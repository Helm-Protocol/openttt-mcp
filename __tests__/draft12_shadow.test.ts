import { sign as ed25519Sign } from "crypto";
import { ed25519KeyFromSeed } from "../pot_record_v08";
import {
  computeV2BindingInput,
  encodePotRecordV2,
} from "../pot_record_v2";
import {
  Draft12ShadowReplayLedger,
  verifyDraft12ShadowFrame,
  type Draft12ShadowPolicy,
} from "../shadow/draft12_shadow";

const SEED = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const KEY = ed25519KeyFromSeed(SEED);
const PUB = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
const CTX = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const NOW = 1_800_000_000_000_000n;
const EXPORTER = Buffer.alloc(32, 0x42);

function makeFrame(nonceByte = 0x10): { frame: Buffer; proof: Buffer } {
  const record = encodePotRecordV2({
    holderAuthType: 0x01,
    algId: 0x0001,
    tsTaiUs: NOW,
    dispersionUs: 100,
    ctxId: CTX,
    nonce: Buffer.alloc(16, nonceByte),
    holderAuthData: PUB,
    issuerKeyId: 0x01020304,
  }, KEY);
  const proof = ed25519Sign(null, computeV2BindingInput(record, EXPORTER), KEY);
  return { frame: Buffer.concat([record, proof]), proof };
}

function policy(overrides: Partial<Draft12ShadowPolicy> = {}): Draft12ShadowPolicy {
  return {
    manifest: { authenticated: true, ctxId: CTX, tierWindowUs: 1_000n },
    nowTaiUs: NOW,
    resolveIssuer: (issuerKeyId) => issuerKeyId === 0x01020304
      ? { state: "trusted", publicKeyRaw: PUB }
      : { state: "unknown" },
    tlsExporterOutput: EXPORTER,
    ...overrides,
  };
}

test("isolated Draft-12 shadow accepts a valid fixed-180 record and external binding", () => {
  const { frame, proof } = makeFrame();
  const ledger = new Draft12ShadowReplayLedger();
  const result = verifyDraft12ShadowFrame(frame, proof, policy(), ledger);
  expect(result.verdict).toBe("ACCEPT");
  expect(result.trace).toEqual([
    "manifest", "framing", "integrity", "context", "freshness", "replay",
    "issuer_trust", "issuer_signature", "holder_binding",
  ]);
  expect(ledger.size).toBe(1);
});

test("143-byte and length-prefixed Rust-v2 frames are not reinterpreted as Draft-12", () => {
  const ledger = new Draft12ShadowReplayLedger();
  const result143 = verifyDraft12ShadowFrame(Buffer.alloc(143), Buffer.alloc(64), policy(), ledger);
  const result145 = verifyDraft12ShadowFrame(Buffer.alloc(145), Buffer.alloc(64), policy(), ledger);
  expect(result143.verdict).toBe("REJECT");
  expect(result145.verdict).toBe("REJECT");
  expect(result143.trace).toEqual(["manifest", "framing"]);
  expect(result145.trace).toEqual(["manifest", "framing"]);
  expect(ledger.size).toBe(0);
});

test("integrity failure is rejected before replay or issuer lookup", () => {
  const { frame, proof } = makeFrame();
  frame[80] ^= 1;
  const ledger = new Draft12ShadowReplayLedger();
  const resolveIssuer = jest.fn(() => ({ state: "trusted" as const, publicKeyRaw: PUB }));
  const result = verifyDraft12ShadowFrame(frame, proof, policy({ resolveIssuer }), ledger);
  expect(result.verdict).toBe("REJECT");
  expect(result.trace).toEqual(["manifest", "framing", "integrity"]);
  expect(resolveIssuer).not.toHaveBeenCalled();
  expect(ledger.size).toBe(0);
});

test("duplicate valid record is rejected before trust lookup", () => {
  const { frame, proof } = makeFrame();
  const ledger = new Draft12ShadowReplayLedger();
  const resolveIssuer = jest.fn((issuerKeyId: number) => ({
    state: issuerKeyId === 0x01020304 ? "trusted" as const : "unknown" as const,
    publicKeyRaw: PUB,
  }));
  const configured = policy({ resolveIssuer });
  expect(verifyDraft12ShadowFrame(frame, proof, configured, ledger).verdict).toBe("ACCEPT");
  resolveIssuer.mockClear();
  const duplicate = verifyDraft12ShadowFrame(frame, proof, configured, ledger);
  expect(duplicate.verdict).toBe("REJECT");
  expect(duplicate.reason).toBe("replay detected");
  expect(duplicate.trace).toEqual(["manifest", "framing", "integrity", "context", "freshness", "replay"]);
  expect(resolveIssuer).not.toHaveBeenCalled();
});

test("failed signature releases its temporary shadow nonce claim", () => {
  const { frame, proof } = makeFrame();
  const badSignature = Buffer.from(frame);
  badSignature[116] ^= 1;
  const ledger = new Draft12ShadowReplayLedger();
  const result = verifyDraft12ShadowFrame(badSignature, proof, policy(), ledger);
  expect(result.verdict).toBe("REJECT");
  expect(result.trace).toEqual([
    "manifest", "framing", "integrity", "context", "freshness", "replay", "issuer_trust", "issuer_signature",
  ]);
  expect(ledger.size).toBe(0);
});

test("missing authenticated manifest holds without touching replay state", () => {
  const { frame, proof } = makeFrame();
  const ledger = new Draft12ShadowReplayLedger();
  const result = verifyDraft12ShadowFrame(
    frame,
    proof,
    policy({ manifest: { authenticated: false, ctxId: CTX, tierWindowUs: 1_000n } }),
    ledger,
  );
  expect(result.verdict).toBe("UNVERIFIABLE");
  expect(result.trace).toEqual(["manifest"]);
  expect(ledger.size).toBe(0);
});

test("frame rejects trailing bytes even when record and proof are otherwise valid", () => {
  const { frame, proof } = makeFrame();
  const ledger = new Draft12ShadowReplayLedger();
  const result = verifyDraft12ShadowFrame(Buffer.concat([frame, Buffer.from([0])]), proof, policy(), ledger);
  expect(result.verdict).toBe("REJECT");
  expect(result.trace).toEqual(["manifest", "framing"]);
  expect(ledger.size).toBe(0);
});

test("authenticated context mismatch is detected only after integrity validation", () => {
  const { frame, proof } = makeFrame();
  const ledger = new Draft12ShadowReplayLedger();
  const result = verifyDraft12ShadowFrame(
    frame,
    proof,
    policy({ manifest: { authenticated: true, ctxId: Buffer.alloc(16, 0xff), tierWindowUs: 1_000n } }),
    ledger,
  );
  expect(result.verdict).toBe("UNVERIFIABLE");
  expect(result.trace).toEqual(["manifest", "framing", "integrity", "context"]);
  expect(ledger.size).toBe(0);
});

test("detached holder proof must equal the proof appended to the frame", () => {
  const { frame, proof } = makeFrame();
  const ledger = new Draft12ShadowReplayLedger();
  const mismatchedProof = Buffer.from(proof);
  mismatchedProof[0] ^= 1;
  const result = verifyDraft12ShadowFrame(frame, mismatchedProof, policy(), ledger);
  expect(result.verdict).toBe("REJECT");
  expect(result.trace).toEqual(["manifest", "framing"]);
  expect(ledger.size).toBe(0);
});
