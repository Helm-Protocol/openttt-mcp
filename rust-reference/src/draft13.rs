//! Explicit Draft-13 180-byte v2 codec. Legacy 143-byte records require reissuance.
use sha2::{Digest, Sha256};
use ed25519_dalek::{Signature, VerifyingKey};
pub const RECORD_SIZE: usize = 180;
pub const EXPORTER_LABEL: &[u8] = b"EXPORTER-TTTPS-v2-draft13";
const DOMAIN: &[u8] = b"tttps-binding-v2-draft13\0";
#[derive(Clone, Copy)]
pub enum Direction { Client = 0, Server = 1 }
pub struct Record<'a> { pub bytes: &'a [u8; RECORD_SIZE] }
impl<'a> Record<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, &'static str> {
        let bytes: &[u8; RECORD_SIZE] = bytes.try_into().map_err(|_| "invalid record size")?;
        if bytes[0] != 2 || !matches!(bytes[1], 1 | 2) || bytes[2..4] != [0, 1] { return Err("unsupported v2 profile"); }
        if Sha256::digest(&bytes[..80]).as_slice() != &bytes[80..112] { return Err("integrity mismatch"); }
        Ok(Self { bytes })
    }
    pub fn verify_issuer(&self, key: &VerifyingKey) -> Result<(), &'static str> {
        let signature = Signature::from_slice(&self.bytes[116..]).map_err(|_| "invalid signature")?;
        key.verify_strict(&self.bytes[..116], &signature).map_err(|_| "issuer signature mismatch")
    }
    pub fn timestamp_us(&self) -> u64 { u64::from_be_bytes(std::array::from_fn(|i|self.bytes[4+i])) }
    pub fn issuer_key_id(&self) -> u32 { u32::from_be_bytes(std::array::from_fn(|i|self.bytes[112+i])) }
    pub fn binding_context(&self, direction: Direction) -> [u8; 32] {
        let mut h=Sha256::new();h.update(DOMAIN);h.update([direction as u8]);h.update(Sha256::digest(self.bytes));h.finalize().into()
    }
    pub fn binding_input(&self, exporter: &[u8;32], direction: Direction) -> Vec<u8> {
        let mut input=Vec::with_capacity(DOMAIN.len()+65);input.extend_from_slice(DOMAIN);input.push(direction as u8);
        input.extend_from_slice(exporter);input.extend_from_slice(&Sha256::digest(self.bytes));input
    }
    pub fn verify_shared_secret(&self, exporter: &[u8;32], direction: Direction, secret: &[u8], proof: &[u8]) -> Result<(), &'static str> {
        if self.bytes[1] != 2 || secret.is_empty() { return Err("shared-secret holder required"); }
        if Sha256::digest(secret).as_slice() != &self.bytes[48..80] { return Err("holder secret mismatch"); }
        let key=ring::hmac::Key::new(ring::hmac::HMAC_SHA256,secret);
        ring::hmac::verify(&key,&self.binding_input(exporter,direction),proof).map_err(|_| "holder binding mismatch")
    }
    pub fn verify_holder(&self, exporter: &[u8;32], direction: Direction, proof: &[u8]) -> Result<(), &'static str> {
        if self.bytes[1] != 1 { return Err("Ed25519 holder required"); }
        let public: [u8;32]=self.bytes[48..80].try_into().map_err(|_|"invalid holder size")?;
        let key=VerifyingKey::from_bytes(&public).map_err(|_| "invalid holder")?;
        let sig=Signature::from_slice(proof).map_err(|_| "invalid holder proof")?;
        key.verify_strict(&self.binding_input(exporter,direction),&sig).map_err(|_| "holder binding mismatch")
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn rejects_legacy_and_wrong_lengths() { for n in [0,143,179,181] { assert!(Record::parse(&vec![0;n]).is_err()); } }
    #[test] fn directions_are_distinct() {
        let mut bytes=[0u8;180];bytes[0]=2;bytes[1]=1;bytes[3]=1;
        let hash=Sha256::digest(&bytes[..80]);bytes[80..112].copy_from_slice(&hash);
        let record=Record::parse(&bytes).unwrap();
        assert_ne!(record.binding_context(Direction::Client),record.binding_context(Direction::Server));
        assert_eq!(record.binding_input(&[0;32],Direction::Client)[DOMAIN.len()],0);
        assert_eq!(record.binding_input(&[0;32],Direction::Server)[DOMAIN.len()],1);
    }
}

#[cfg(test)] mod appendix_vectors {
    use super::*;
    #[test] fn shared_typescript_vectors_match_rust() {
        let vectors: serde_json::Value=serde_json::from_str(include_str!("../tests/fixtures/draft13-vectors.json")).unwrap();
        let exporter: [u8;32]=std::array::from_fn(|i|(i+32) as u8);
        let issuer=VerifyingKey::from_bytes(&hex::decode("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a").unwrap().try_into().unwrap()).unwrap();
        for kind in ["ed25519","psk"] {
            let vector=&vectors[kind];let bytes=hex::decode(vector["record"].as_str().unwrap()).unwrap();let record=Record::parse(&bytes).unwrap();
            record.verify_issuer(&issuer).unwrap();
            assert_eq!(hex::encode(record.binding_context(Direction::Client)),vector["exporter_context_hash"].as_str().unwrap());
            assert_eq!(hex::encode(record.binding_input(&exporter,Direction::Client)),vector["binding_input"].as_str().unwrap());
            let proof=hex::decode(vector["holder_proof"].as_str().unwrap()).unwrap();
            if kind=="ed25519" {
                record.verify_holder(&exporter,Direction::Client,&proof).unwrap();
                assert!(record.verify_holder(&exporter,Direction::Server,&proof).is_err());
                assert!(record.verify_holder(&[0;32],Direction::Client,&proof).is_err());
            } else {
                let secret: [u8;32]=std::array::from_fn(|i|i as u8);
                record.verify_shared_secret(&exporter,Direction::Client,&secret,&proof).unwrap();
                assert!(record.verify_shared_secret(&exporter,Direction::Server,&secret,&proof).is_err());
                assert!(record.verify_shared_secret(&[0;32],Direction::Client,&secret,&proof).is_err());
            }
        }
    }
}
