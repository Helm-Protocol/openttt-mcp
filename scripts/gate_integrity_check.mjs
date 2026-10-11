// Bounded real TLS/DB regression; private holder key stays local and is never printed.
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const V2=createRequire(import.meta.url)('../dist/pot_record_v2.js');
const port=Number(process.env.TEST_GATE_PORT || 18090);
const host=process.env.TEST_GATE_HOST || '127.0.0.1';
const key=crypto.createPrivateKey(fs.readFileSync(process.env.TEST_HOLDER_KEY));
const results=[];
class Client {
 constructor(){this.agent=new https.Agent({keepAlive:true,maxSockets:1,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'});}
 async request(path, body, plain=false,headers={}){
  const data=body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body);
  return new Promise((resolve,reject)=>{
   const req=(plain?http:https).request({host,port,path,method:data?'POST':'GET',servername:'api.kenosian.com',agent:plain?undefined:this.agent,headers:{...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}),...headers}},res=>{
    let text='';res.on('data',c=>text+=c);res.on('end',()=>{let body;try{body=JSON.parse(text);}catch{body=text;}resolve({status:res.statusCode,headers:res.headers,body});});
   });
   req.setTimeout(5000,()=>req.destroy(new Error('request timeout')));
   req.on('socket',s=>{if(s instanceof tls.TLSSocket){if(s.encrypted && !s.connecting)this.socket=s;else s.once('secureConnect',()=>{this.socket=s;});}});req.on('error',reject);req.end(data);
  });
 }
 proof(record,direction=0){const r=Buffer.from(record,'hex');return crypto.sign(null,V2.computeDraft13BindingInput(r,this.socket.exportKeyingMaterial(32,V2.DRAFT13_EXPORTER_LABEL,V2.computeDraft13ExporterContext(r,direction)),direction),key).toString('hex');}
 close(){this.agent.destroy();}
}
const bob=new Client(),eve=new Client();
function check(name,r,reason){if(reason){assert.equal(r.status,403);assert.equal(r.body.reason,reason);assert.equal(r.body.state_drift,false);assert.equal(r.body.db_hash_before,r.body.db_hash_after);}results.push({name,...r.body,status:r.status});}
try{
 const health=await bob.request('/health');assert.equal(health.status,200);assert.equal(health.body.bindingRevision,'draft13');
 assert.equal(health.body.verificationEngine,'rust-draft13');assert.equal(health.body.recordSize,180);
 assert.equal(health.body.defaultVerifyPath,'/v2/verify');
 const legacy=await bob.request('/v1/legacy');assert.equal(legacy.status,410);assert.equal(legacy.body.error,'LEGACY_143B_NOT_ACCEPTED');
 const token=(await bob.request('/token')).body;
 const body={record_hex:token.record_hex,action:token.action};
 const parserStats=(await bob.request('/stats')).body;
 for (const [name,raw] of [
   ['duplicate top-level key','{"record_hex":"00","record_hex":"11"}'],
   ['duplicate nested escaped key','{"action":{"amount":1,"\\u0061mount":2}}'],
   ['invalid Unicode surrogate','{"action":{"to":"\\ud800","amount":1}}'],
 ]) {
   const r=await bob.request('/v2/verify',raw); assert.equal(r.status,400);
   results.push({name,status:r.status,error:r.body.error});
 }
 const contentType=await bob.request('/v2/verify',body,false,{'content-type':'text/plain'});
 assert.equal(contentType.status,415); results.push({name:'non-JSON content type',status:contentType.status});
 const afterParserStats=(await bob.request('/stats')).body;
 assert.equal(afterParserStats.total,parserStats.total); // denied before verification/nonce/commit
 assert.equal((await bob.request('/health')).body.status,'ok');
 await assert.rejects(eve.request('/v2/verify',body,true));
 results.push({name:'plaintext transport rejected',status:'connection rejected'});
 check('TLS token without holder proof',await eve.request('/v2/verify',body),'HOLDER_PROOF_REQUIRED');
 check('143B is never silently accepted as v2',await eve.request('/v2/verify',{...body,record_hex:'00'.repeat(143)}),'INVALID_FRAME_ENCODING');
 check('HTTP exporter and issuer injection ignored',await eve.request('/v2/verify',{...body,exporter:'00'.repeat(32),issuer_public:'00'.repeat(32)}),'HOLDER_PROOF_REQUIRED');
 const proof=bob.proof(token.record_hex);
 check('unused token and proof stolen into another TLS session',await eve.request('/v2/verify',{...body,binding_proof:proof}),'TLS_HOLDER_BINDING_FAIL');
 check('wrong holder direction',await bob.request('/v2/verify',{...body,binding_proof:bob.proof(token.record_hex,1)}),'TLS_HOLDER_BINDING_FAIL');
 check('noncanonical trailing hex',await bob.request('/v2/verify',{...body,record_hex:token.record_hex+'zz',binding_proof:proof}),'INVALID_FRAME_ENCODING');
 check('unsigned action amount substitution',await bob.request('/v2/verify',{...body,action:{...token.action,amount:500000},binding_proof:proof}),'ARGUMENT_BINDING_FAIL');
 const damaged=Buffer.from(token.record_hex,'hex');damaged[179]^=1;
 check('issuer signature mutation',await bob.request('/v2/verify',{...body,record_hex:damaged.toString('hex'),binding_proof:proof}),'ISSUER_SIGNATURE_INVALID');
 const concurrent=await Promise.all(Array.from({length:8},()=>bob.request('/v2/verify',{...body,binding_proof:proof})));
 assert.equal(concurrent.filter(r=>r.status===200).length,1);
 for(const [i,r] of concurrent.entries()){if(r.status===200){assert.equal(r.body.verdict,'ALLOW');assert.equal(r.body.state_drift,true);results.push({name:'authorized holder commit',...r.body,status:r.status});}else check(`replay ${i}`,r,'REPLAY_LEDGER_CLAIMED');}
 const stats=(await bob.request('/stats')).body;assert.equal(stats.drift,0);
 await assert.rejects(eve.request('/go',undefined,true));
 const redirect={headers:{location:'https://api.kenosian.com:'+port+'/go'}};
 await assert.rejects(new Promise((resolve,reject)=>{const q=https.get({host,port,servername:'api.kenosian.com',minVersion:'TLSv1.2',maxVersion:'TLSv1.2'},resolve);q.on('error',reject);q.setTimeout(5000,()=>q.destroy(new Error('timeout')));}));
 const out={passed:true,health:health.body,results,stats:{total:stats.total,allow:stats.allow,reject:stats.reject,drift:stats.drift},redirect:redirect.headers.location,tls12Rejected:true};
 if(process.env.TEST_OUTPUT)fs.writeFileSync(process.env.TEST_OUTPUT,JSON.stringify(out,null,2));
 console.log(JSON.stringify({passed:true,cases:results.length,stats:out.stats,source:health.body.sourceSha256}));
}finally{bob.close();eve.close();}
