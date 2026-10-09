/**
 * Draft-12 conformance shadow only.
 * This module is deliberately not imported by index.ts/tools.ts and is not part
 * of the package build. It never mutates application state or production Redis.
 */
import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as ed25519Verify,
} from "crypto";
import {
  decodePotRecordV2,
  verifyV2BindingProof,
  HOLDER_AUTH_ED25519,
  HOLDER_AUTH_SHARED_SECRET,
  POT_V2_INTEGRITY_SHA256,
  POT_V2_SIZE,
  POT_V2_VERSION,
} from "../pot_record_v2";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_SIGNATURE_SIZE = 64;
const HMAC_SIGNATURE_SIZE = 32;

export type Draft12ShadowVerdict = "ACCEPT" | "HOLD" | "UNVERIFIABLE" | "REJECT";
export type Draft12ShadowStage =
  | "manifest"
  | "framing"
  | "integrity"
  | "context"
  | "freshness"
  | "replay"
  | "issuer_trust"
  | "issuer_signature"
  | "holder_binding";

export interface Draft12ShadowManifest {
  /** Must be established by the caller from an authenticated policy source. */
  authenticated: boolean;
  ctxId: Buffer;
  tierWindowUs: bigint;
}

export interface Draft12ShadowIssuer {
  state: "trusted" | "unknown" | "revoked" | "expired";
  publicKeyRaw?: Buffer;
}

export interface Draft12ShadowPolicy {
  manifest: Draft12ShadowManifest;
  nowTaiUs: bigint;
  resolveIssuer: (issuerKeyId: number) => Draft12ShadowIssuer;
  tlsExporterOutput?: Buffer;
  holderSharedSecret?: Buffer;
}

export interface Draft12ShadowResult {
  verdict: Draft12ShadowVerdict;
  reason: string;
  trace: Draft12ShadowStage[];
}

type ClaimResult =
  | { state: "claimed"; key: string }
  | { state: "duplicate" }
  | { state: "full" };

/**
 * Bounded, process-local test ledger. `claim` is synchronous, so check+insert
 * is atomic within this JS isolate. This is not a distributed replay service.
 */
export class Draft12ShadowReplayLedger {
  private readonly expiries = new Map<string, bigint>();

  constructor(private readonly maxEntries = 100_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("maxEntries must be a positive safe integer");
    }
  }

  get size(): number {
    return this.expiries.size;
  }

  claim(ctxId: Buffer, nonce: Buffer, expiresAtTaiUs: bigint, nowTaiUs: bigint): ClaimResult {
    const key = `${ctxId.toString("hex")}:${nonce.toString("hex")}`;
    const existingExpiry = this.expiries.get(key);
    if (existingExpiry !== undefined) {
      if (existingExpiry > nowTaiUs) return { state: "duplicate" };
      this.expiries.delete(key);
    }
    if (this.expiries.size >= this.maxEntries) return { state: "full" };
    this.expiries.set(key, expiresAtTaiUs);
    return { state: "claimed", key };
  }

  release(key: string): void {
    this.expiries.delete(key);
  }
}

function reject(
  trace: Draft12ShadowStage[],
  reason: string,
  verdict: Draft12ShadowVerdict = "REJECT",
): Draft12ShadowResult {
  return { verdict, reason, trace: [...trace] };
}

/**
 * Validate one Draft-12 fixed-180 record followed by its holder proof.
 * The only state mutation is a temporary shadow replay claim; failed later
 * checks release that claim. There is intentionally no application commit.
 */
export function verifyDraft12ShadowFrame(
  frame: Buffer,
  bindingProof: Buffer,
  policy: Draft12ShadowPolicy,
  ledger: Draft12ShadowReplayLedger,
): Draft12ShadowResult {
  const trace: Draft12ShadowStage[] = ["manifest"];
  const manifest = policy.manifest;
  if (!manifest.authenticated || manifest.ctxId.length !== 16 || manifest.tierWindowUs < 0n) {
    return reject(trace, "authenticated context/tier manifest unavailable", "UNVERIFIABLE");
  }

  trace.push("framing");
  if (!Buffer.isBuffer(frame) || frame.length < POT_V2_SIZE) {
    return reject(trace, "truncated Draft-12 frame");
  }
  const holderAuthType = frame[1];
  const proofLength = holderAuthType === HOLDER_AUTH_ED25519
    ? ED25519_SIGNATURE_SIZE
    : holderAuthType === HOLDER_AUTH_SHARED_SECRET
      ? HMAC_SIGNATURE_SIZE
      : -1;
  if (
    proofLength < 0 ||
    frame.length !== POT_V2_SIZE + proofLength ||
    bindingProof.length !== proofLength ||
    !timingSafeEqual(bindingProof, frame.subarray(POT_V2_SIZE))
  ) {
    return reject(trace, "frame or holder-proof length mismatch");
  }

  let record: ReturnType<typeof decodePotRecordV2>;
  try {
    record = decodePotRecordV2(frame.subarray(0, POT_V2_SIZE));
  } catch (error) {
    return reject(trace, error instanceof Error ? error.message : String(error));
  }
  if (frame[0] !== POT_V2_VERSION || record.algId !== POT_V2_INTEGRITY_SHA256) {
    return reject(trace, "unsupported Draft-12 version or integrity algorithm");
  }

  trace.push("integrity");
  const expectedTag = createHash("sha256").update(frame.subarray(0, 80)).digest();
  if (!timingSafeEqual(expectedTag, record.integrityTag)) {
    return reject(trace, "integrity tag mismatch");
  }

  trace.push("context");
  if (!timingSafeEqual(record.ctxId, manifest.ctxId)) {
    return reject(trace, "record context does not match authenticated manifest", "UNVERIFIABLE");
  }

  trace.push("freshness");
  if (policy.nowTaiUs < 0n) return reject(trace, "TAI clock value unavailable", "UNVERIFIABLE");
  const delta = record.tsTaiUs >= policy.nowTaiUs
    ? record.tsTaiUs - policy.nowTaiUs
    : policy.nowTaiUs - record.tsTaiUs;
  const allowed = manifest.tierWindowUs + BigInt(record.dispersionUs);
  if (delta > allowed) return reject(trace, "outside authenticated freshness window");

  trace.push("replay");
  const claim = ledger.claim(
    record.ctxId,
    record.nonce,
    record.tsTaiUs + allowed,
    policy.nowTaiUs,
  );
  if (claim.state === "duplicate") return reject(trace, "replay detected");
  if (claim.state === "full") return reject(trace, "shadow replay ledger capacity reached", "HOLD");

  const failAfterClaim = (
    reason: string,
    verdict: Draft12ShadowVerdict = "REJECT",
  ): Draft12ShadowResult => {
    ledger.release(claim.key);
    return reject(trace, reason, verdict);
  };

  trace.push("issuer_trust");
  let issuer: Draft12ShadowIssuer;
  try {
    issuer = policy.resolveIssuer(record.issuerKeyId);
  } catch {
    return failAfterClaim("issuer trust lookup failed", "UNVERIFIABLE");
  }
  if (issuer.state === "unknown") return failAfterClaim("issuer is not trusted", "UNVERIFIABLE");
  if (issuer.state === "revoked") return failAfterClaim("issuer is revoked");
  if (issuer.state === "expired") return failAfterClaim("issuer trust material expired", "UNVERIFIABLE");
  if (!issuer.publicKeyRaw || issuer.publicKeyRaw.length !== 32) {
    return failAfterClaim("trusted issuer key material unavailable", "UNVERIFIABLE");
  }

  trace.push("issuer_signature");
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, issuer.publicKeyRaw]),
      format: "der",
      type: "spki",
    });
    if (!ed25519Verify(null, record.signedPrefix, publicKey, record.issuerSig)) {
      return failAfterClaim("issuer signature invalid");
    }
  } catch {
    return failAfterClaim("issuer signature verification failed");
  }

  trace.push("holder_binding");
  if (!policy.tlsExporterOutput) {
    return failAfterClaim("TLS exporter evidence unavailable", "UNVERIFIABLE");
  }
  const binding = verifyV2BindingProof(
    frame.subarray(0, POT_V2_SIZE),
    frame.subarray(POT_V2_SIZE),
    policy.tlsExporterOutput,
    policy.holderSharedSecret,
  );
  if (binding.verdict !== "intact") return failAfterClaim(binding.reason ?? "holder binding invalid");

  return { verdict: "ACCEPT", reason: "Draft-12 shadow checks passed; no application commit performed", trace };
}
