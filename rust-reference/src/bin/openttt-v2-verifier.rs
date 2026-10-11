//! Production private verifier pipe. HTTP clients never select authority or exporter.
use std::io::{self, BufRead, Read, Write};
use ed25519_dalek::VerifyingKey;
use openttt_draft13_reference::{draft13::{Direction, Record}, replay::replay_ttl, strict_json};
use serde::Deserialize;
use serde_json::json;
#[derive(Deserialize)]
struct Request { id:u64, record_hex:String, context_hex:String, binding_proof:String, exporter:String, now_us:u64 }
fn decode<const N:usize>(s:&str)->Result<[u8;N], &'static str>{
    if s.len()!=N*2{return Err("INVALID_ENCODING")}
    hex::decode(s).map_err(|_|"INVALID_ENCODING")?.try_into().map_err(|_|"INVALID_ENCODING")
}
fn verify(r:&Request,key:&VerifyingKey)->Result<u64,&'static str>{
    let bytes=decode::<180>(&r.record_hex)?;
    let record=Record::parse(&bytes).map_err(|_|"INVALID_RECORD")?;
    record.verify_issuer(key).map_err(|_|"ISSUER_SIGNATURE_INVALID")?;
    if record.issuer_key_id()!=1{return Err("UNKNOWN_ISSUER_KEY_ID")}
    if bytes[1]!=1{return Err("UNSUPPORTED_HOLDER_PROFILE")}
    if bytes[16..32]!=decode::<16>(&r.context_hex)?{return Err("EVENT_BINDING_FAIL")}
    let dispersion=u32::from_be_bytes(std::array::from_fn(|i|bytes[12+i])) as u64;
    let ttl=replay_ttl(record.timestamp_us(),dispersion,r.now_us).map_err(|_|"STALE_TIMESTAMP")?;
    record.verify_holder(&decode::<32>(&r.exporter)?,Direction::Client,&decode::<64>(&r.binding_proof)?)
        .map_err(|_|"TLS_HOLDER_BINDING_FAIL")?;
    Ok((ttl.as_micros() as u64 + 999)/1000)
}
fn main()->Result<(),Box<dyn std::error::Error>>{
    let key=VerifyingKey::from_bytes(&decode::<32>(&std::env::var("DRAFT13_ISSUER_PUBLIC")?)?)?;
    let mut input=io::stdin().lock(); let mut output=io::BufWriter::new(io::stdout().lock());
    loop {
        let mut line=Vec::new(); let n=(&mut input).take(8193).read_until(b'\n',&mut line)?;
        if n==0{break} if n>8192||line.last()!=Some(&b'\n'){return Err("oversized pipe request".into())}
        let r:Request=strict_json::from_slice(&line)?;let result=verify(&r,&key);
        writeln!(output,"{}",json!({"id":r.id,"ok":result.is_ok(),"reason":result.as_ref().err(),"ttl_ms":result.as_ref().ok()}))?;output.flush()?;
    }
    Ok(())
}
