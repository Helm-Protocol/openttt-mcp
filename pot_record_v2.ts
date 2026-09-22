import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  sign as ed25519Sign,
  verify as ed25519Verify,
  type KeyObject,
} from "crypto";

export const POT_V2_SIZE = 180;
export const POT_V2_VERSION = 0x02;
export const POT_V2_INTEGRITY_SHA256 = 0x0001;
export const HOLDER_AUTH_ED25519 = 0x01;
export const HOLDER_AUTH_SHARED_SECRET = 0x02;

const OFF = {
  VERSION: 0,
  HOLDER_AUTH_TYPE: 1,
  ALG_ID: 2,
  TS: 4,
  DISPERSION: 12,
  CTX_ID: 16,
  NONCE: 32,
  HOLDER_AUTH_DATA: 48,
  INTEGRITY_TAG: 80,
  ISSUER_KEY_ID: 112,
  ISSUER_SIG: 116,
} as const;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface PotRecordV2Fields {
  holderAuthType: number;
  algId: number;
  tsTaiUs: bigint;
  dispersionUs: number;
  ctxId: Buffer;
  nonce: Buffer;
  holderAuthData: Buffer;
  issuerKeyId: number;
}

export interface DecodedPotRecordV2 extends PotRecordV2Fields {
  integrityTag: Buffer;
  issuerSig: Buffer;
  signedPrefix: Buffer;
}

export interface V2FreshnessPolicy {
  nowTaiUs: bigint;
  maxSkewUs: bigint;
}

export interface VerifyV2Result {
  verdict: "intact" | "rejected";
  reason?: string;
  nonce?: Buffer;
}

function requireLength(name: string, value: Buffer, length: number): void {
  if (value.length !== length) throw new Error(`${name} must be ${length} bytes`);
}

function issuerPublicKeyFromRaw(raw: Buffer): KeyObject {
  requireLength("issuer public key", raw, 32);
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

function integrityTag(signedPrefix: Buffer): Buffer {
  return createHash("sha256").update(signedPrefix).digest();
}

export function encodePotRecordV2(fields: PotRecordV2Fields, issuerPrivateKey: KeyObject): Buffer {
  if (fields.holderAuthType !== HOLDER_AUTH_ED25519 && fields.holderAuthType !== HOLDER_AUTH_SHARED_SECRET) {
    throw new Error("unsupported holder_auth_type");
  }
  if (fields.algId !== POT_V2_INTEGRITY_SHA256) throw new Error("unsupported alg_id");
  if (fields.tsTaiUs < 0n || fields.tsTaiUs > 0xffffffffffffffffn) throw new Error("ts out of range");
  if (fields.dispersionUs < 0 || fields.dispersionUs > 0xffffffff) throw new Error("dispersion out of range");
  if (fields.issuerKeyId < 0 || fields.issuerKeyId > 0xffffffff) throw new Error("issuer_key_id out of range");
  requireLength("ctx_id", fields.ctxId, 16);
  requireLength("nonce", fields.nonce, 16);
  requireLength("holder_auth_data", fields.holderAuthData, 32);

  const prefix = Buffer.alloc(116);
  prefix.writeUInt8(POT_V2_VERSION, OFF.VERSION);
  prefix.writeUInt8(fields.holderAuthType, OFF.HOLDER_AUTH_TYPE);
  prefix.writeUInt16BE(fields.algId, OFF.ALG_ID);
  prefix.writeBigUInt64BE(fields.tsTaiUs, OFF.TS);
  prefix.writeUInt32BE(fields.dispersionUs, OFF.DISPERSION);
  fields.ctxId.copy(prefix, OFF.CTX_ID);
  fields.nonce.copy(prefix, OFF.NONCE);
  fields.holderAuthData.copy(prefix, OFF.HOLDER_AUTH_DATA);
  integrityTag(prefix.subarray(0, 80)).copy(prefix, OFF.INTEGRITY_TAG);
  prefix.writeUInt32BE(fields.issuerKeyId, OFF.ISSUER_KEY_ID);

  const signature = ed25519Sign(null, prefix, issuerPrivateKey);
  return Buffer.concat([prefix, signature]);
}

export function decodePotRecordV2(record: Buffer): DecodedPotRecordV2 {
  if (record.length !== POT_V2_SIZE) throw new Error(`expected 180 octets, got ${record.length}`);
  const signedPrefix = record.subarray(0, 116);
  return {
    holderAuthType: record.readUInt8(OFF.HOLDER_AUTH_TYPE),
    algId: record.readUInt16BE(OFF.ALG_ID),
    tsTaiUs: record.readBigUInt64BE(OFF.TS),
    dispersionUs: record.readUInt32BE(OFF.DISPERSION),
    ctxId: Buffer.from(record.subarray(OFF.CTX_ID, OFF.CTX_ID + 16)),
    nonce: Buffer.from(record.subarray(OFF.NONCE, OFF.NONCE + 16)),
    holderAuthData: Buffer.from(record.subarray(OFF.HOLDER_AUTH_DATA, OFF.HOLDER_AUTH_DATA + 32)),
    issuerKeyId: record.readUInt32BE(OFF.ISSUER_KEY_ID),
    integrityTag: Buffer.from(record.subarray(OFF.INTEGRITY_TAG, OFF.INTEGRITY_TAG + 32)),
    issuerSig: Buffer.from(record.subarray(OFF.ISSUER_SIG, POT_V2_SIZE)),
    signedPrefix: Buffer.from(signedPrefix),
  };
}

export function computeV2ExporterContext(record: Buffer): Buffer {
  const decoded = decodePotRecordV2(record);
  const bindingPrefix = Buffer.from("tttps-binding-v2\0", "ascii");
  const recordHash = createHash("sha256").update(record).digest();
  return createHash("sha256")
    .update(Buffer.concat([bindingPrefix, recordHash, decoded.ctxId, decoded.nonce]))
    .digest();
}

export function computeV2BindingInput(record: Buffer, exporterOutput: Buffer): Buffer {
  decodePotRecordV2(record);
  if (exporterOutput.length !== 32) throw new Error("TLS exporter output must be 32 octets");
  return Buffer.concat([Buffer.from("tttps-binding-v2\0", "ascii"), exporterOutput, record.subarray(16, 32), record.subarray(32, 48)]);
}

export function verifyV2BindingProof(
  record: Buffer,
  bindingProof: Buffer,
  exporterOutput: Buffer,
  sharedSecret?: Buffer,
): { verdict: "intact" | "rejected"; reason?: string } {
  const decoded = decodePotRecordV2(record);
  const bindingInput = computeV2BindingInput(record, exporterOutput);
  if (decoded.holderAuthType === HOLDER_AUTH_ED25519) {
    if (bindingProof.length !== 64) return { verdict: "rejected", reason: "Ed25519 binding proof must be 64 octets" };
    const holderPublicKey = issuerPublicKeyFromRaw(decoded.holderAuthData);
    return ed25519Verify(null, bindingInput, holderPublicKey, bindingProof)
      ? { verdict: "intact" }
      : { verdict: "rejected", reason: "TLS exporter holder proof mismatch" };
  }
  if (decoded.holderAuthType === HOLDER_AUTH_SHARED_SECRET) {
    if (!sharedSecret) return { verdict: "rejected", reason: "shared-secret holder binding is not configured" };
    if (bindingProof.length !== 32) return { verdict: "rejected", reason: "HMAC binding proof must be 32 octets" };
    const expectedDigest = createHash("sha256").update(sharedSecret).digest();
    if (!timingSafeEqual(expectedDigest, decoded.holderAuthData)) return { verdict: "rejected", reason: "shared-secret digest mismatch" };
    const expected = createHmac("sha256", sharedSecret).update(bindingInput).digest();
    return timingSafeEqual(expected, bindingProof)
      ? { verdict: "intact" }
      : { verdict: "rejected", reason: "TLS exporter HMAC proof mismatch" };
  }
  return { verdict: "rejected", reason: "unsupported holder authentication type" };
}

export function verifyPotRecordV2(
  record: Buffer,
  issuerPublicKeyRaw: Buffer,
  freshness?: V2FreshnessPolicy,
): VerifyV2Result {
  let decoded: DecodedPotRecordV2;
  try { decoded = decodePotRecordV2(record); } catch (e) {
    return { verdict: "rejected", reason: e instanceof Error ? e.message : String(e) };
  }
  if (record[OFF.VERSION] !== POT_V2_VERSION) return { verdict: "rejected", reason: "unknown version" };
  if (decoded.holderAuthType !== HOLDER_AUTH_ED25519 && decoded.holderAuthType !== HOLDER_AUTH_SHARED_SECRET) {
    return { verdict: "rejected", reason: "unsupported holder_auth_type" };
  }
  if (decoded.algId !== POT_V2_INTEGRITY_SHA256) return { verdict: "rejected", reason: "unsupported alg_id" };
  if (!integrityTag(decoded.signedPrefix.subarray(0, 80)).equals(decoded.integrityTag)) return { verdict: "rejected", reason: "integrity mismatch" };
  if (freshness) {
    const delta = decoded.tsTaiUs >= freshness.nowTaiUs ? decoded.tsTaiUs - freshness.nowTaiUs : freshness.nowTaiUs - decoded.tsTaiUs;
    if (delta > freshness.maxSkewUs + BigInt(decoded.dispersionUs)) return { verdict: "rejected", reason: "freshness window exceeded" };
  }
  try {
    if (!ed25519Verify(null, decoded.signedPrefix, issuerPublicKeyFromRaw(issuerPublicKeyRaw), decoded.issuerSig)) {
      return { verdict: "rejected", reason: "issuer signature invalid" };
    }
  } catch (e) {
    return { verdict: "rejected", reason: e instanceof Error ? e.message : String(e) };
  }
  return { verdict: "intact", nonce: decoded.nonce };
}
