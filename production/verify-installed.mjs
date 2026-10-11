// Run only on an owned validation instance as root. Secrets never leave the host.
import https from 'node:https';import tls from 'node:tls';import http from 'node:http';
import fs from 'node:fs';import crypto from 'node:crypto';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {createRequire} from 'node:module';
const V2=createRequire(import.meta.url)('../dist/pot_record_v2.js');
const token=fs.readFileSync('/var/lib/openttt/v2/seal-token','utf8').trim();
const holder=crypto.generateKeyPairSync('ed25519');const pub=holder.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
const event_b64=Buffer.from('customer event: validation '+crypto.randomBytes(16).toString('hex')).toString('base64');
const ca=fs.readFileSync('/etc/openttt/v2/tls.crt');const results=[];
class Client {
 constructor(){this.agent=new https.Agent({keepAlive:true,maxSockets:1,ca,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'});}
 request(url,body,auth=false){const text=body===undefined?null:typeof body==='string'?body:JSON.stringify(body);return new Promise((resolve,reject)=>{const r=https.request({host:'127.0.0.1',servername:'localhost',port:8090,path:url,method:text===null?'GET':'POST',agent:this.agent,headers:{...(text!==null?{'content-type':'application/json','content-length':Buffer.byteLength(text)}:{}),...(auth?{authorization:'Bearer '+token}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b)}));});r.on('socket',s=>{if(!s.connecting)this.socket=s;else s.once('secureConnect',()=>this.socket=s);});r.on('error',reject);r.setTimeout(5000,()=>r.destroy(new Error('timeout')));r.end(text);});}
 proof(record,direction=0,key=holder.privateKey){const b=Buffer.from(record,'hex');return crypto.sign(null,V2.computeDraft13BindingInput(b,this.socket.exportKeyingMaterial(32,V2.DRAFT13_EXPORTER_LABEL,V2.computeDraft13ExporterContext(b,direction)),direction),key).toString('hex');}
 close(){this.agent.destroy();}
}
const a=new Client(),b=new Client();
function check(name,r,status){assert.equal(r.status,status,name);results.push({name,status:r.status,reason:r.body.reason||r.body.error});}
const req={event_b64,holder_public:pub};let accepted;
try{
 check('healthy real installed service',await a.request('/health'),200);
 check('unauthenticated seal rejected',await a.request('/v2/seal',req),401);
 check('legacy route rejected',await a.request('/v1/legacy'),410);
 check('duplicate escaped JSON keys rejected',await a.request('/v2/verify','{"event_b64":"QQ==","\\u0065vent_b64":"Qg=="}'),400);
 const s=await a.request('/v2/seal',req,true);check('authenticated real event seal',s,200);assert.equal(s.body.record_hex.length,360);
 const record=s.body.record_hex;
 const without={event_b64,record_hex:record};
 check('holder proof required',await a.request('/v2/verify',without),403);
 const proof=a.proof(record);
 check('altered event bytes rejected',await a.request('/v2/verify',{...without,event_b64:'Qg==',binding_proof:proof}),403);
 check('wrong direction rejected',await a.request('/v2/verify',{...without,binding_proof:a.proof(record,1)}),403);
 check('wrong holder rejected',await a.request('/v2/verify',{...without,binding_proof:a.proof(record,0,crypto.generateKeyPairSync('ed25519').privateKey)}),403);
 await b.request('/health');check('cross-session stolen proof rejected',await b.request('/v2/verify',{...without,binding_proof:proof}),403);
 const damaged=Buffer.from(record,'hex');damaged[179]^=1;
 check('altered issuer signature rejected',await a.request('/v2/verify',{...without,record_hex:damaged.toString('hex'),binding_proof:proof}),403);
 check('143B packet rejected',await a.request('/v2/verify',{...without,record_hex:'00'.repeat(143),binding_proof:proof}),403);
 const concurrent=await Promise.all(Array.from({length:8},()=>a.request('/v2/verify',{...without,binding_proof:proof})));
 assert.equal(concurrent.filter(r=>r.status===200).length,1);assert.equal(concurrent.filter(r=>r.status===403&&r.body.reason==='REPLAY_DETECTED').length,7);results.push({name:'atomic concurrent claim',accepted:1,replayed:7});
 accepted=concurrent.find(r=>r.status===200).body.receipt;
 const {signature,...unsigned}=accepted;
 const issuerKey=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(accepted.issuer_public,'hex')]),format:'der',type:'spki'});
 assert(crypto.verify(null,Buffer.from(JSON.stringify(unsigned)),issuerKey,Buffer.from(signature,'hex')));results.push({name:'signed durable admission receipt',status:'PASS'});
 a.close();b.close();
 execFileSync('systemctl',['restart','openttt-v2']);
 const c=new Client();try{
  for(let i=0;i<50;i++){try{const h=await c.request('/health');if(h.status===200)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  check('restart retains issuer identity',await c.request('/v2/issuer'),200);
  const r=await c.request('/v2/verify',{...without,binding_proof:c.proof(record)});check('restart replay rejected',r,403);assert.equal(r.body.reason,'REPLAY_DETECTED');
 }finally{c.close();}
 const counts=execFileSync('python3',['-c',"import sqlite3,json;c=sqlite3.connect('/var/lib/openttt/v2/admission.sqlite');print(json.dumps({'claims':c.execute('select count(*) from claims').fetchone()[0],'receipts':c.execute('select count(*) from receipts').fetchone()[0]}))"],{encoding:'utf8'});results.push({name:'durable store counts',...JSON.parse(counts)});
 const original=fs.readFileSync('/var/lib/openttt/signing_key.hex','utf8').trim();
 const oldKey=crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(original,'hex')]),format:'der',type:'pkcs8'});
 assert.equal(crypto.createPublicKey(oldKey).export({format:'der',type:'spki'}).subarray(-32).toString('hex'),accepted.issuer_public);results.push({name:'existing production issuer identity preserved',status:'PASS'});
 fs.writeFileSync('/tmp/tttps-v2-validation.json',JSON.stringify({passed:true,results},null,2));console.log(JSON.stringify({passed:true,cases:results.length}));
}finally{a.close();b.close();}
