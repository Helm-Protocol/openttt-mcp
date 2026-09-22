/**
 * Byte-exact conformance tests against Appendix A of
 * draft-helmprotocol-tttps-08 (both test vectors: 184-octet record without
 * holder binding, 216-octet holder-bound record). Values transcribed
 * directly from the draft; do not "fix" a mismatch here by changing the
 * expected value — a mismatch means pot_record_v08.ts diverged from spec.
 */

import {
  generatePotRecordV08,
  decodePotRecordV08,
  verifyPotRecordV08,
  computeCommitmentSha256,
  ed25519KeyFromSeed,
  rawPublicKeyOf,
  RECORD_SIZE_NO_HOLDER,
  RECORD_SIZE_HOLDER,
  MTI_INTEGRITY_ALG_SHA256,
  RESERVED_ERROR_BOUND,
  type PotRecordV08Fields,
} from "../pot_record_v08";

// ---- Common inputs (Appendix A) ----
const CTX_ID = "example.com/pot-v1";
const PAYLOAD = Buffer.from("the quick brown fox jumps over the lazy dog", "ascii");
const PAYLOAD_DIGEST = Buffer.from("05c6e08f1d9fdafa03147fcb8f82f124c76d2f70e3d989dc8aadb5e7d7450bec", "hex");
const ISSUER_SEED = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const ISSUER_PUBKEY = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
const ISSUER_KEY_ID = Buffer.from("21fe31dfa154a261", "hex");
const NONCE = Buffer.from("000102030405060708090a0b0c0d0e0f1011121314151617" + "18191a1b1c1d1e1f", "hex");
const TIMESTAMP_NS = 0x18c5addedb8c0000n;
const TIER = 0x2;
const ERROR_BOUND_US = 0x00c350;
const SRC_CNT = 4;

test("SHA-256(payload) matches the Appendix A Payload Digest", () => {
  const { createHash } = require("crypto");
  expect(createHash("sha256").update(PAYLOAD).digest().equals(PAYLOAD_DIGEST)).toBe(true);
});

test("issuer key derivation matches Appendix A public key and Issuer Key ID", () => {
  const { createPublicKey } = require("crypto");
  const priv = ed25519KeyFromSeed(ISSUER_SEED);
  const pub = createPublicKey(priv);
  expect(rawPublicKeyOf(pub).equals(ISSUER_PUBKEY)).toBe(true);
  const { createHash } = require("crypto");
  expect(createHash("sha256").update(ISSUER_PUBKEY).digest().subarray(0, 8).equals(ISSUER_KEY_ID)).toBe(true);
});

describe("Vector 1 — 184-octet record, Flags=0x00, no holder binding", () => {
  const EXPECTED_RECORD = Buffer.from(
    "120000010400c35018c5addedb8c000021fe31dfa154a261" +
      "000102030405060708090a0b0c0d0e0f1011121314151617" +
      "18191a1b1c1d1e1f05c6e08f1d9fdafa03147fcb8f82f124" +
      "c76d2f70e3d989dc8aadb5e7d7450bec20ea9777b481577d" +
      "7e057797dd891afa9d097b46043e181bbaad3eee63ae39de" +
      "8081fa5802ecb58a2179e7f7a400d8b83f84ce8e440b7629" +
      "a85e969a25a024e6979b401d263a58eb830ea2c0b0725fb8" +
      "79012dd1c3e4102512f2c3c47c643e03",
    "hex"
  );
  const EXPECTED_COMMITMENT = Buffer.from(
    "20ea9777b481577d7e057797dd891afa9d097b46043e181bbaad3eee63ae39de",
    "hex"
  );

  const fields: PotRecordV08Fields = {
    version: 1,
    tier: TIER,
    integrityAlg: MTI_INTEGRITY_ALG_SHA256,
    srcCnt: SRC_CNT,
    errorBoundUs: ERROR_BOUND_US,
    timestampNs: TIMESTAMP_NS,
    issuerKeyId: ISSUER_KEY_ID,
    nonce: NONCE,
    payloadDigest: PAYLOAD_DIGEST,
  };

  test("generatePotRecordV08 reproduces the exact 184-octet record", () => {
    const record = generatePotRecordV08(fields, CTX_ID, ISSUER_SEED);
    expect(record.length).toBe(RECORD_SIZE_NO_HOLDER);
    expect(record.equals(EXPECTED_RECORD)).toBe(true);
  });

  test("computeCommitmentSha256 reproduces the exact Commitment", () => {
    const record = generatePotRecordV08(fields, CTX_ID, ISSUER_SEED);
    const decoded = decodePotRecordV08(record);
    expect(computeCommitmentSha256(decoded.fieldsPre, CTX_ID).equals(EXPECTED_COMMITMENT)).toBe(true);
  });

  test("decodePotRecordV08 round-trips all fields", () => {
    const decoded = decodePotRecordV08(EXPECTED_RECORD);
    expect(decoded.version).toBe(1);
    expect(decoded.tier).toBe(TIER);
    expect(decoded.flags).toBe(0x00);
    expect(decoded.integrityAlg).toBe(MTI_INTEGRITY_ALG_SHA256);
    expect(decoded.srcCnt).toBe(SRC_CNT);
    expect(decoded.errorBoundUs).toBe(ERROR_BOUND_US);
    expect(decoded.timestampNs).toBe(TIMESTAMP_NS);
    expect(decoded.issuerKeyId.equals(ISSUER_KEY_ID)).toBe(true);
    expect(decoded.nonce.equals(NONCE)).toBe(true);
    expect(decoded.payloadDigest.equals(PAYLOAD_DIGEST)).toBe(true);
    expect(decoded.holderKey).toBeUndefined();
  });

  test("verifyPotRecordV08 returns intact, and detects payload digest match/mismatch", () => {
    const result = verifyPotRecordV08(EXPECTED_RECORD, CTX_ID, ISSUER_PUBKEY, PAYLOAD);
    expect(result.verdict).toBe("intact");
    expect(result.payloadDigestMatchesContent).toBe(true);

    const tampered = Buffer.concat([PAYLOAD, Buffer.from("!")]);
    const bad = verifyPotRecordV08(EXPECTED_RECORD, CTX_ID, ISSUER_PUBKEY, tampered);
    expect(bad.verdict).toBe("rejected");
    expect(bad.payloadDigestMatchesContent).toBe(false);
  });

  test("verifyPotRecordV08 rejects on ctx_id mismatch (context separation)", () => {
    const result = verifyPotRecordV08(EXPECTED_RECORD, "different.example/ctx", ISSUER_PUBKEY);
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toMatch(/commitment mismatch/);
  });

  test("verifyPotRecordV08 rejects a corrupted signature", () => {
    const corrupted = Buffer.from(EXPECTED_RECORD);
    corrupted[corrupted.length - 1] ^= 0xff;
    const result = verifyPotRecordV08(corrupted, CTX_ID, ISSUER_PUBKEY);
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toMatch(/signature invalid/);
  });
});

describe("Vector 2 — 216-octet record, Flags=0x80, holder-bound", () => {
  const HOLDER_PUBKEY = Buffer.from(
    "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    "hex"
  );
  const EXPECTED_RECORD = Buffer.from(
    "128000010400c35018c5addedb8c000021fe31dfa154a261" +
      "000102030405060708090a0b0c0d0e0f1011121314151617" +
      "18191a1b1c1d1e1f05c6e08f1d9fdafa03147fcb8f82f124" +
      "c76d2f70e3d989dc8aadb5e7d7450bec3d4017c3e843895a" +
      "92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c" +
      "57c85cba540637962ebf8c6fc6a182709c72a45ed67910b6" +
      "98a0b0ae33a5a207edf2267af4bd1a20313866ac3714078a" +
      "b139b5a4fa9918350eba055daeed95d6e2a4ff60ca6f28f2" +
      "760983adf4d947aef54a200f55be50b2f437ec6d2f955c07",
    "hex"
  );

  const fields: PotRecordV08Fields = {
    version: 1,
    tier: TIER,
    integrityAlg: MTI_INTEGRITY_ALG_SHA256,
    srcCnt: SRC_CNT,
    errorBoundUs: ERROR_BOUND_US,
    timestampNs: TIMESTAMP_NS,
    issuerKeyId: ISSUER_KEY_ID,
    nonce: NONCE,
    payloadDigest: PAYLOAD_DIGEST,
    holderKey: HOLDER_PUBKEY,
  };

  test("generatePotRecordV08 reproduces the exact 216-octet holder-bound record", () => {
    const record = generatePotRecordV08(fields, CTX_ID, ISSUER_SEED);
    expect(record.length).toBe(RECORD_SIZE_HOLDER);
    expect(record.equals(EXPECTED_RECORD)).toBe(true);
  });

  test("decodePotRecordV08 recovers the Holder Key and Flags bit 0", () => {
    const decoded = decodePotRecordV08(EXPECTED_RECORD);
    expect(decoded.flags).toBe(0x80);
    expect(decoded.holderKey?.equals(HOLDER_PUBKEY)).toBe(true);
  });

  test("verifyPotRecordV08 returns intact for the holder-bound record", () => {
    const result = verifyPotRecordV08(EXPECTED_RECORD, CTX_ID, ISSUER_PUBKEY);
    expect(result.verdict).toBe("intact");
  });
});

describe("Field validation (draft-08 Section 3.2 MUST/MUST NOT constraints)", () => {
  const baseFields: PotRecordV08Fields = {
    version: 1,
    tier: TIER,
    integrityAlg: MTI_INTEGRITY_ALG_SHA256,
    srcCnt: SRC_CNT,
    errorBoundUs: ERROR_BOUND_US,
    timestampNs: TIMESTAMP_NS,
    issuerKeyId: ISSUER_KEY_ID,
    nonce: NONCE,
    payloadDigest: PAYLOAD_DIGEST,
  };

  test("rejects Src Cnt below 3", () => {
    expect(() => generatePotRecordV08({ ...baseFields, srcCnt: 2 }, CTX_ID, ISSUER_SEED)).toThrow(/Src Cnt/);
  });

  test("rejects the reserved Error Bound value 0xFFFFFF", () => {
    expect(() =>
      generatePotRecordV08({ ...baseFields, errorBoundUs: RESERVED_ERROR_BOUND }, CTX_ID, ISSUER_SEED)
    ).toThrow(/reserved/);
  });

  test("decodePotRecordV08 rejects a length that doesn't match Flags bit 0", () => {
    const record = generatePotRecordV08(baseFields, CTX_ID, ISSUER_SEED);
    const truncated = record.subarray(0, record.length - 1);
    expect(() => decodePotRecordV08(truncated)).toThrow(/expected 184 octets/);
  });

  test("verifyPotRecordV08 rejects an unimplemented integrity algorithm", () => {
    const record = generatePotRecordV08(baseFields, CTX_ID, ISSUER_SEED);
    record.writeUInt16BE(0x0100, 2); // reserved GRG codepoint — mutate in place, offsets untouched otherwise
    const result = verifyPotRecordV08(record, CTX_ID, ISSUER_PUBKEY);
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toMatch(/unimplemented integrity algorithm/);
  });

  test("freshness policy rejects a record outside the configured bound", () => {
    const record = generatePotRecordV08(baseFields, CTX_ID, ISSUER_SEED);
    const result = verifyPotRecordV08(record, CTX_ID, ISSUER_PUBKEY, undefined, {
      nowNs: TIMESTAMP_NS + 10_000_000_000n,
      maxSkewNs: 1_000_000n,
    });
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("freshness window exceeded");
  });

  test("freshness policy accepts a record inside the configured bound", () => {
    const record = generatePotRecordV08(baseFields, CTX_ID, ISSUER_SEED);
    const result = verifyPotRecordV08(record, CTX_ID, ISSUER_PUBKEY, undefined, {
      nowNs: TIMESTAMP_NS + 1_000_000n,
      maxSkewNs: 1_000_000n,
    });
    expect(result.verdict).toBe("intact");
  });
});
