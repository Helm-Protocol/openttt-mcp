//! Private parent-child verifier channel. Never accepts an exporter from public HTTP.
//! TLS termination supplies the connection-local exporter; pinned authority is fixed at startup.
use std::io::{self, BufRead, Read, Write};
use ed25519_dalek::VerifyingKey;
use openttt_draft13_reference::draft13::{Direction, Record};
use serde::Deserialize;
use openttt_draft13_reference::replay::replay_ttl;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
struct Request { id: u64, body: Value, exporter: Option<String>, now_us: u64 }
fn decode<const N:usize>(s: &str) -> Result<[u8;N], &'static str> {
    if s.len()!=N*2 { return Err("INVALID_FRAME_ENCODING"); }
    hex::decode(s).map_err(|_| "INVALID_FRAME_ENCODING")?.try_into().map_err(|_| "INVALID_FRAME_ENCODING")
}
fn verify(r: &Request, issuer: &VerifyingKey, holder: &[u8;32]) -> Result<u64, &'static str> {
    let bytes = decode::<180>(r.body["record_hex"].as_str().ok_or("INVALID_FRAME_ENCODING")?)?;
    let record=Record::parse(&bytes).map_err(|s| if s=="integrity mismatch" {"DIGEST_MUTATION_FAIL"} else {"RECORD_REJECTED"})?;
    record.verify_issuer(issuer).map_err(|_| "ISSUER_SIGNATURE_INVALID")?;
    let dispersion=u32::from_be_bytes([bytes[12],bytes[13],bytes[14],bytes[15]]) as u64;
    let ts=record.timestamp_us();
    let ttl = replay_ttl(ts, dispersion, r.now_us).map_err(|_| "STALE_TIMESTAMP")?;
    if &bytes[48..80]!=holder { return Err("HOLDER_NOT_AUTHORIZED"); }
    let action=&r.body["action"];
    let to=action["to"].as_str().ok_or("INVALID_ACTION")?;
    let amount=action["amount"].as_u64().filter(|n| *n>0 && *n<=9_007_199_254_740_991).ok_or("INVALID_ACTION")?;
    if action.as_object().map(|o|o.len())!=Some(2) { return Err("INVALID_ACTION"); }
    // Exactly the JS canonical field order, independent of serde's map ordering.
    let canonical=format!("{{\"to\":{},\"amount\":{}}}",serde_json::to_string(to).map_err(|_|"INVALID_ACTION")?,amount);
    if bytes[16..32]!=Sha256::digest(canonical.as_bytes())[..16] {return Err("ARGUMENT_BINDING_FAIL");}
    let proof=decode::<64>(r.body["binding_proof"].as_str().ok_or("HOLDER_PROOF_REQUIRED")?).map_err(|_|"HOLDER_PROOF_REQUIRED")?;
    let exporter=decode::<32>(r.exporter.as_deref().ok_or("TLS_HOLDER_BINDING_FAIL")?).map_err(|_|"TLS_HOLDER_BINDING_FAIL")?;
    record.verify_holder(&exporter,Direction::Client,&proof).map_err(|_|"TLS_HOLDER_BINDING_FAIL")?;
    Ok(ttl.as_millis() as u64 + u64::from(ttl.subsec_nanos() % 1_000_000 != 0))
}
fn main() -> Result<(),Box<dyn std::error::Error>> {
    let issuer=VerifyingKey::from_bytes(&decode::<32>(&std::env::var("DRAFT13_ISSUER_PUBLIC")?)?)?;
    let holder=decode::<32>(&std::env::var("DRAFT13_HOLDER_PUBLIC")?)?;
    let stdin=io::stdin(); let mut input=stdin.lock(); let mut output=io::BufWriter::new(io::stdout().lock());
    loop {
        // Parent bounds request bodies too. No unbounded lines on this private channel.
        let mut line=Vec::new();
        let n=(&mut input).take(131073).read_until(b'\n', &mut line)?;
        if n==0 {break;}
        if n>131072 || line.last()!=Some(&b'\n') {return Err("oversized verifier request".into());}
        let request:Request=openttt_draft13_reference::strict_json::from_slice(&line)?;
        let result=verify(&request,&issuer,&holder);
        writeln!(output,"{}",json!({"id":request.id,"ok":result.is_ok(),"reason":result.as_ref().err(),"replayTtlMs":result.as_ref().ok(),"engine":"rust-draft13","recordSize":180}))?;
        output.flush()?;
    }
    Ok(())
}
