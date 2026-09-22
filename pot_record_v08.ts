// pot_record_v08.ts — draft-helmprotocol-tttps-08 Section 3 Proof-of-Time Record.
//
// Byte layout and the SHA-256 commitment/Ed25519 signature scheme are
// verified byte-exact against Appendix A of draft-helmprotocol-tttps-08
// (both the 184-octet and 216-octet test vectors) before this file was
// written; see the test suite in pot_record_v08.test.ts.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
  verify as ed25519Verify,
  type KeyObject,
} from "crypto";

// Fixed ASN.1 DER prefixes for wrapping a raw 32-byte Ed25519 seed/public
// key into the PKCS8 / SPKI structures Node's crypto module requires.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function ed25519KeyFromSeed(seed: Buffer): KeyObject {
  if (seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

export function ed25519PublicKeyFromRaw(pub: Buffer): KeyObject {
  if (pub.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  const der = Buffer.concat([ED25519_SPKI_PREFIX, pub]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

export function rawPublicKeyOf(key: KeyObject): Buffer {
  return key.export({ type: "spki", format: "der" }).subarray(-32);
}

// draft-08 Section 3.1 offsets, within the fields-preceding-Commitment
// region ("P_pre"). Holder Key is present only when Flags bit 0 is set.
const PRE_OFFSET = {
  HEADER: 0, // Version(4)|Tier(4), Flags(8), Integrity Alg(16) — 4 bytes
  SRC_ERR: 4, // Src Cnt(8), Error Bound(24) — 4 bytes
  TIMESTAMP: 8, // 8 bytes
  ISSUER_KEY_ID: 16, // 8 bytes
  NONCE: 24, // 32 bytes
  PAYLOAD_DIGEST: 56, // 32 bytes
  HOLDER_KEY: 88, // 32 bytes, iff Flags bit 0 = 1
} as const;

const PRE_LEN_NO_HOLDER = 88;
const PRE_LEN_HOLDER = 120;
const COMMITMENT_LEN = 32;
const SIGNATURE_LEN = 64;

export const RECORD_SIZE_NO_HOLDER = PRE_LEN_NO_HOLDER + COMMITMENT_LEN + SIGNATURE_LEN; // 184
export const RECORD_SIZE_HOLDER = PRE_LEN_HOLDER + COMMITMENT_LEN + SIGNATURE_LEN; // 216

export const MTI_INTEGRITY_ALG_SHA256 = 0x0001;
export const RESERVED_ERROR_BOUND = 0xffffff;

export interface PotRecordV08Fields {
  version: number; // 4 bits, this document defines version 1
  tier: number; // 4 bits, Section 6 tier
  integrityAlg: number; // 16 bits; only 0x0001 (SHA-256) is implemented here
  srcCnt: number; // 8 bits, MUST be >= 3
  errorBoundUs: number; // 24 bits, microseconds; MUST NOT be 0xFFFFFF
  timestampNs: bigint; // 64 bits, ns since UNIX epoch
  issuerKeyId: Buffer; // 8 bytes
  nonce: Buffer; // 32 bytes
  payloadDigest: Buffer; // 32 bytes — SHA-256(payload), supplied by caller
  holderKey?: Buffer; // 32 bytes, optional (sets Flags bit 0)
}

export interface DecodedPotRecordV08 {
  version: number;
  tier: number;
  flags: number;
  integrityAlg: number;
  srcCnt: number;
  errorBoundUs: number;
  timestampNs: bigint;
  issuerKeyId: Buffer;
  nonce: Buffer;
  payloadDigest: Buffer;
  holderKey?: Buffer;
  commitment: Buffer;
  signature: Buffer;
  fieldsPre: Buffer; // P minus Commitment — the algorithm input
  p: Buffer; // fieldsPre || commitment — what the signature covers
}

function encodeFieldsPre(f: PotRecordV08Fields): Buffer {
  if (f.version < 0 || f.version > 0xf) throw new Error("version must fit in 4 bits");
  if (f.tier < 0 || f.tier > 0xf) throw new Error("tier must fit in 4 bits");
  if (f.integrityAlg < 0 || f.integrityAlg > 0xffff) throw new Error("integrityAlg must fit in 16 bits");
  if (f.srcCnt < 3) throw new Error("Src Cnt MUST be at least 3 (draft-08 Section 3.2)");
  if (f.srcCnt > 0xff) throw new Error("srcCnt must fit in 8 bits");
  if (f.errorBoundUs === RESERVED_ERROR_BOUND) {
    throw new Error("Error Bound 0xFFFFFF is reserved and MUST NOT be emitted (draft-08 Section 3.2)");
  }
  if (f.errorBoundUs < 0 || f.errorBoundUs > 0xffffff) throw new Error("errorBoundUs must fit in 24 bits");
  if (f.issuerKeyId.length !== 8) throw new Error("issuerKeyId must be 8 bytes");
  if (f.nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  if (f.payloadDigest.length !== 32) throw new Error("payloadDigest must be 32 bytes (SHA-256)");
  if (f.holderKey !== undefined && f.holderKey.length !== 32) {
    throw new Error("holderKey must be 32 bytes");
  }

  const hasHolder = f.holderKey !== undefined;
  const buf = Buffer.alloc(hasHolder ? PRE_LEN_HOLDER : PRE_LEN_NO_HOLDER);

  buf.writeUInt8((f.version << 4) | f.tier, PRE_OFFSET.HEADER);
  buf.writeUInt8(hasHolder ? 0x80 : 0x00, PRE_OFFSET.HEADER + 1);
  buf.writeUInt16BE(f.integrityAlg, PRE_OFFSET.HEADER + 2);

  buf.writeUInt8(f.srcCnt, PRE_OFFSET.SRC_ERR);
  buf.writeUIntBE(f.errorBoundUs, PRE_OFFSET.SRC_ERR + 1, 3);

  buf.writeBigUInt64BE(f.timestampNs, PRE_OFFSET.TIMESTAMP);
  f.issuerKeyId.copy(buf, PRE_OFFSET.ISSUER_KEY_ID);
  f.nonce.copy(buf, PRE_OFFSET.NONCE);
  f.payloadDigest.copy(buf, PRE_OFFSET.PAYLOAD_DIGEST);
  if (hasHolder) f.holderKey!.copy(buf, PRE_OFFSET.HOLDER_KEY);

  return buf;
}

/**
 * draft-08 Section 3.3.2, algorithm 0x0001 (SHA-256, arity 2, MTI):
 *   commitment = SHA-256( len(ctx_id) || ctx_id || 0x00 || fields )
 * ctx_id is encoded as a single length octet (max 255) followed by its
 * UTF-8 bytes. This is a domain-separation hash, not a MAC — ctx_id MAY
 * be public (Section 3.3).
 */
export function computeCommitmentSha256(fieldsPre: Buffer, ctxId: string): Buffer {
  const ctxBytes = Buffer.from(ctxId, "utf8");
  if (ctxBytes.length > 255) {
    throw new Error("ctx_id exceeds 255 octets — not usable with integrity algorithm 0x0001");
  }
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from([ctxBytes.length]), ctxBytes, Buffer.from([0x00]), fieldsPre]))
    .digest();
}

/** draft-08 Section 3.4 Generation, steps 4-10 (steps 1-3, source collection
 * and error-bound computation, happen upstream — this takes the already
 * time-synthesized fields). Signs with an already-constructed Ed25519
 * KeyObject — the caller owns key management (ephemeral, file-backed,
 * HSM, whatever). */
export function assemblePotRecordV08(fields: PotRecordV08Fields, ctxId: string, issuerPrivateKey: KeyObject): Buffer {
  const fieldsPre = encodeFieldsPre(fields);
  const commitment = computeCommitmentSha256(fieldsPre, ctxId);
  const p = Buffer.concat([fieldsPre, commitment]);
  const signature = ed25519Sign(null, p, issuerPrivateKey);
  return Buffer.concat([p, signature]);
}

/** Convenience wrapper over {@link assemblePotRecordV08} for callers that
 * hold a raw 32-byte Ed25519 seed rather than a KeyObject — this is the
 * form Appendix A's test vectors are expressed in. */
export function generatePotRecordV08(
  fields: PotRecordV08Fields,
  ctxId: string,
  issuerPrivateKeySeed: Buffer
): Buffer {
  return assemblePotRecordV08(fields, ctxId, ed25519KeyFromSeed(issuerPrivateKeySeed));
}

/** Parses a wire-format record without verifying anything (Section 3.5 step
 * 2's self-delimiting length derivation from Flags bit 0). */
export function decodePotRecordV08(record: Buffer): DecodedPotRecordV08 {
  if (record.length < 2) throw new Error("record too short to read Flags");
  const flags = record.readUInt8(PRE_OFFSET.HEADER + 1);
  const hasHolder = (flags & 0x80) !== 0;
  const expectedLen = hasHolder ? RECORD_SIZE_HOLDER : RECORD_SIZE_NO_HOLDER;
  if (record.length !== expectedLen) {
    throw new Error(`expected ${expectedLen} octets for Flags bit0=${hasHolder ? 1 : 0}, got ${record.length}`);
  }

  const versionTier = record.readUInt8(PRE_OFFSET.HEADER);
  const version = (versionTier >> 4) & 0x0f;
  const tier = versionTier & 0x0f;
  const integrityAlg = record.readUInt16BE(PRE_OFFSET.HEADER + 2);
  const srcCnt = record.readUInt8(PRE_OFFSET.SRC_ERR);
  const errorBoundUs = record.readUIntBE(PRE_OFFSET.SRC_ERR + 1, 3);
  const timestampNs = record.readBigUInt64BE(PRE_OFFSET.TIMESTAMP);
  const issuerKeyId = Buffer.from(record.subarray(PRE_OFFSET.ISSUER_KEY_ID, PRE_OFFSET.ISSUER_KEY_ID + 8));
  const nonce = Buffer.from(record.subarray(PRE_OFFSET.NONCE, PRE_OFFSET.NONCE + 32));
  const payloadDigest = Buffer.from(record.subarray(PRE_OFFSET.PAYLOAD_DIGEST, PRE_OFFSET.PAYLOAD_DIGEST + 32));

  const preLen = hasHolder ? PRE_LEN_HOLDER : PRE_LEN_NO_HOLDER;
  const holderKey = hasHolder
    ? Buffer.from(record.subarray(PRE_OFFSET.HOLDER_KEY, PRE_OFFSET.HOLDER_KEY + 32))
    : undefined;

  const fieldsPre = Buffer.from(record.subarray(0, preLen));
  const commitment = Buffer.from(record.subarray(preLen, preLen + COMMITMENT_LEN));
  const signature = Buffer.from(record.subarray(preLen + COMMITMENT_LEN, preLen + COMMITMENT_LEN + SIGNATURE_LEN));
  const p = Buffer.from(record.subarray(0, preLen + COMMITMENT_LEN));

  return {
    version,
    tier,
    flags,
    integrityAlg,
    srcCnt,
    errorBoundUs,
    timestampNs,
    issuerKeyId,
    nonce,
    payloadDigest,
    holderKey,
    commitment,
    signature,
    fieldsPre,
    p,
  };
}

export interface VerifyResultV08 {
  verdict: "intact" | "rejected";
  reason?: string;
  payloadDigestMatchesContent?: boolean; // undefined if no content supplied
}

export interface FreshnessPolicyV08 {
  nowNs: bigint;
  maxSkewNs: bigint;
}

/** draft-08 Section 3.5, the subset of steps this MCP server can evaluate
 * without a live TLS/QUIC session binding (steps 1, 2, 5 [commitment],
 * 9 [payload digest], and the signature check folded into step 5's
 * neighbourhood). Session/holder binding (steps 3-4, 10) are the caller's
 * responsibility when this record travels inside a Section 5 transport. */
export function verifyPotRecordV08(
  record: Buffer,
  ctxId: string,
  issuerPublicKeyRaw: Buffer,
  content?: Buffer,
  freshness?: FreshnessPolicyV08,
): VerifyResultV08 {
  let decoded: DecodedPotRecordV08;
  try {
    decoded = decodePotRecordV08(record);
  } catch (e) {
    return { verdict: "rejected", reason: e instanceof Error ? e.message : String(e) };
  }

  if (decoded.version !== 1) {
    return { verdict: "rejected", reason: `unknown version ${decoded.version}, expected 1` };
  }
  if (decoded.integrityAlg !== MTI_INTEGRITY_ALG_SHA256) {
    return { verdict: "rejected", reason: `unimplemented integrity algorithm 0x${decoded.integrityAlg.toString(16)}` };
  }
  if (decoded.errorBoundUs === RESERVED_ERROR_BOUND) {
    return { verdict: "rejected", reason: "Error Bound carries the reserved value 0xFFFFFF" };
  }

  if (freshness !== undefined) {
    if (freshness.maxSkewNs < 0n) {
      return { verdict: "rejected", reason: "invalid freshness policy" };
    }
    const delta = decoded.timestampNs >= freshness.nowNs
      ? decoded.timestampNs - freshness.nowNs
      : freshness.nowNs - decoded.timestampNs;
    if (delta > freshness.maxSkewNs + BigInt(decoded.errorBoundUs) * 1_000n) {
      return { verdict: "rejected", reason: "freshness window exceeded" };
    }
  }

  const expectedCommitment = computeCommitmentSha256(decoded.fieldsPre, ctxId);
  if (!expectedCommitment.equals(decoded.commitment)) {
    return { verdict: "rejected", reason: "commitment mismatch" };
  }

  const publicKey = ed25519PublicKeyFromRaw(issuerPublicKeyRaw);
  if (!ed25519Verify(null, decoded.p, publicKey, decoded.signature)) {
    return { verdict: "rejected", reason: "Ed25519 signature invalid" };
  }

  let payloadDigestMatchesContent: boolean | undefined;
  if (content !== undefined) {
    const recomputed = createHash("sha256").update(content).digest();
    payloadDigestMatchesContent = recomputed.equals(decoded.payloadDigest);
    if (!payloadDigestMatchesContent) {
      return { verdict: "rejected", reason: "Payload Digest does not match supplied content", payloadDigestMatchesContent };
    }
  }

  return { verdict: "intact", payloadDigestMatchesContent };
}
