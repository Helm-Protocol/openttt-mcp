import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import fs from 'node:fs';

// Exporter secrets only traverse anonymous parent-child pipes. No public endpoint or disk log.
export function startRustVerifier(binary, issuerPublic, holderPublic) {
  fs.accessSync(binary, fs.constants.X_OK);
  const child=spawn(binary,[],{stdio:['pipe','pipe','inherit'],env:{...process.env,
    DRAFT13_ISSUER_PUBLIC:issuerPublic.toString('hex'),DRAFT13_HOLDER_PUBLIC:holderPublic.toString('hex')}});
  const pending=new Map(); let sequence=0, failed=false;
  function fail(){failed=true;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('RUST_VERIFIER_UNAVAILABLE'));}pending.clear();}
  child.on('error',fail);child.on('exit',fail);child.stdin.on('error',fail);
  createInterface({input:child.stdout}).on('line',line=>{
    let result;try{result=JSON.parse(line);}catch{fail();child.kill();return;}
    const entry=pending.get(result.id);if(!entry)return;
    clearTimeout(entry.timer);pending.delete(result.id);entry.resolve(result);
  });
  process.once('exit',()=>child.kill());
  return {
    alive:()=>!failed,
    verify(body,exporter,nowUs){
      if(failed || pending.size>=64)return Promise.reject(new Error('RUST_VERIFIER_UNAVAILABLE'));
      const id=++sequence;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(new Error('RUST_VERIFIER_TIMEOUT'));},3000);
        pending.set(id,{resolve,reject,timer});
        // Only the selected HTTP fields are passed; attacker-supplied exporter/issuer fields are ignored.
        child.stdin.write(JSON.stringify({id,body:{record_hex:body?.record_hex,action:body?.action,binding_proof:body?.binding_proof},
          exporter:exporter?.toString('hex'),now_us:Number(nowUs)})+'\n');
      });
    }
  };
}
