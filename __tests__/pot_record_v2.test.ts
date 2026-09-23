import { ed25519KeyFromSeed } from "../pot_record_v08";
import { sign as ed25519Sign } from "crypto";
import { encodePotRecordV2, decodePotRecordV2, verifyPotRecordV2, computeV2BindingInput, verifyV2BindingProof } from "../pot_record_v2";

const SEED = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const KEY = ed25519KeyFromSeed(SEED);
const PUB = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
const BASE = {
  holderAuthType: 0x01,
  algId: 0x0001,
  tsTaiUs: 1_800_000_000_000_000n,
  dispersionUs: 100,
  ctxId: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
  nonce: Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"),
  holderAuthData: PUB,
  issuerKeyId: 0x01020304,
};

test("draft-11 v2 is exactly 180 octets and verifies", () => {
  const record = encodePotRecordV2(BASE, KEY);
  expect(record.length).toBe(180);
  expect(decodePotRecordV2(record).issuerKeyId).toBe(0x01020304);
  expect(verifyPotRecordV2(record, PUB, { nowTaiUs: BASE.tsTaiUs, maxSkewUs: 1_000n }).verdict).toBe("intact");
});

test("draft-11 v2 rejects mutations at every record octet", () => {
  const record = encodePotRecordV2(BASE, KEY);
  for (let offset = 0; offset < record.length; offset++) {
    const mutated = Buffer.from(record);
    mutated[offset] ^= 1;
    expect(verifyPotRecordV2(mutated, PUB).verdict).toBe("rejected");
  }
});

test("draft-11 v2 rejects a stale record", () => {
  const record = encodePotRecordV2(BASE, KEY);
  expect(verifyPotRecordV2(record, PUB, { nowTaiUs: BASE.tsTaiUs + 10_000n, maxSkewUs: 1n }).reason).toBe("freshness window exceeded");
});

test("draft-11 v2 verifies the Section 6.1 Ed25519 TLS binding proof", () => {
  const record = encodePotRecordV2(BASE, KEY);
  const exporterOutput = Buffer.alloc(32, 0x42);
  const bindingInput = computeV2BindingInput(record, exporterOutput);
  const proof = ed25519Sign(null, bindingInput, KEY);
  expect(verifyV2BindingProof(record, proof, exporterOutput)).toEqual({ verdict: "intact" });
  const wrongSessionOutput = Buffer.alloc(32, 0x43);
  expect(verifyV2BindingProof(record, proof, wrongSessionOutput).verdict).toBe("rejected");
});
