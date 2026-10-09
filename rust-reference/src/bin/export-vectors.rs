//! Deterministic PUBLIC Appendix B seeds. This binary never reads runtime TLS secrets.
use ed25519_dalek::{Signer, SigningKey};
use openttt_draft13_reference::draft13::{Direction, Record};
use serde_json::json;
use sha2::{Digest,Sha256};
fn main() -> Result<(),Box<dyn std::error::Error>> {
    let seed=|s:&str| -> Result<[u8;32],Box<dyn std::error::Error>> {Ok(hex::decode(s)?.try_into().map_err(|_|"invalid public seed length")?)};
    let issuer=SigningKey::from_bytes(&seed("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")?);
    let holder=SigningKey::from_bytes(&seed("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")?);
    let secret:[u8;32]=std::array::from_fn(|i|i as u8);
    let exporter:[u8;32]=std::array::from_fn(|i|(i+32) as u8);
    let mut vectors=serde_json::Map::new();
    for (name,kind) in [("ed25519",1),("psk",2)] {
        let mut bytes=[0u8;180];bytes[0]=2;bytes[1]=kind;bytes[3]=1;
        bytes[4..12].copy_from_slice(&2100000000000000u64.to_be_bytes());
        bytes[12..16].copy_from_slice(&100u32.to_be_bytes());
        bytes[16..32].copy_from_slice(&hex::decode("00112233445566778899aabbccddeeff")?);
        bytes[32..48].copy_from_slice(&hex::decode("ffeeddccbbaa99887766554433221100")?);
        let auth=if kind==1 {holder.verifying_key().to_bytes()} else {Sha256::digest(secret).into()};
        bytes[48..80].copy_from_slice(&auth);
        let integrity=Sha256::digest(&bytes[..80]);bytes[80..112].copy_from_slice(&integrity);
        bytes[112..116].copy_from_slice(&1001u32.to_be_bytes());
        let signature=issuer.sign(&bytes[..116]);bytes[116..180].copy_from_slice(&signature.to_bytes());
        let record=Record::parse(&bytes)?;record.verify_issuer(&issuer.verifying_key())?;
        let input=record.binding_input(&exporter,Direction::Client);
        let proof=if kind==1 {holder.sign(&input).to_bytes().to_vec()} else {ring::hmac::sign(&ring::hmac::Key::new(ring::hmac::HMAC_SHA256,&secret),&input).as_ref().to_vec()};
        let mut presentation=bytes.to_vec();presentation.extend_from_slice(&proof);
        vectors.insert(name.into(),json!({"record":hex::encode(bytes),"record_hash":hex::encode(Sha256::digest(bytes)),
            "exporter_context_hash":hex::encode(record.binding_context(Direction::Client)),"binding_input":hex::encode(input),
            "holder_proof":hex::encode(proof),"presentation":hex::encode(presentation),"integrity_tag":hex::encode(&bytes[80..112]),
            "issuer_signed_bytes":hex::encode(&bytes[..116]),"issuer_signature":hex::encode(&bytes[116..]),"direction":0,
            "server_direction_context":hex::encode(record.binding_context(Direction::Server)),
            "server_direction_binding_input":hex::encode(record.binding_input(&exporter,Direction::Server))}));
    }
    println!("{}",json!({"exporter_fixture":hex::encode(exporter),"vectors":vectors}));
    Ok(())
}
