// Customer-local service: real issuer, actual TLS exporter and durable admission.
// A receipt authorizes one admission; business writes must use its ID idempotently.
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
import {parseStrictJson} from '../demo/strict_json.mjs';
const V2=createRequire(import.meta.url)('../dist/pot_record_v2.js');
const root=path.dirname(new URL(import.meta.url).pathname);
const state=process.env.TTTPS_STATE_DIR||'/var/lib/openttt/v2';
const config=process.env.TTTPS_CONFIG_DIR||'/etc/openttt/v2';
const signer=crypto.createPrivateKey(fs.readFileSync(path.join(state,'issuer.pem')));
const issuer=crypto.createPublicKey(signer).export({format:'der',type:'spki'}).subarray(-32);
const sealToken=fs.readFileSync(path.join(state,'seal-token'),'utf8').trim();
const ratePerMin=Number(process.env.TTTPS_RATE_PER_MIN||120);
if(!Number.isSafeInteger(ratePerMin)||ratePerMin<1||ratePerMin>1000000)throw new Error('INVALID_RATE_CONFIGURATION');
if (!/^[a-f0-9]{64}$/.test(sealToken)) throw new Error('INVALID_SEAL_AUTH_CONFIGURATION');
function authorized(req){const text=req.headers.authorization||'';return crypto.timingSafeEqual(crypto.createHash('sha256').update(text).digest(),crypto.createHash('sha256').update('Bearer '+sealToken).digest());}
function pipe(executable,args,env=process.env){
 const child=spawn(executable,args,{env,stdio:['pipe','pipe','inherit']});let id=0,failed=false;const pending=new Map();
 function fail(){failed=true;for(const x of pending.values()){clearTimeout(x.t);x.reject(new Error('AUTHORITY_UNAVAILABLE'));}pending.clear();}
 child.on('exit',fail);child.on('error',fail);child.stdin.on('error',fail);
 createInterface({input:child.stdout}).on('line',line=>{let r;try{r=JSON.parse(line);}catch{fail();child.kill();return;}const p=pending.get(r.id);if(p){clearTimeout(p.t);pending.delete(r.id);p.resolve(r);}});
 process.once('exit',()=>child.kill());
 return {alive:()=>!failed,call(q){if(failed||pending.size>=64)return Promise.reject(new Error('AUTHORITY_UNAVAILABLE'));return new Promise((resolve,reject)=>{const n=++id;const t=setTimeout(()=>{pending.delete(n);reject(new Error('AUTHORITY_TIMEOUT'));},3000);pending.set(n,{resolve,reject,t});child.stdin.write(JSON.stringify({...q,id:n})+'\n');});}};
}
const verifier=pipe(path.join(root,'../bin/openttt-v2-verifier'),[],{...process.env,DRAFT13_ISSUER_PUBLIC:issuer.toString('hex')});
const store=pipe('python3',[path.join(root,'replay-store.py'),path.join(state,'admission.sqlite')]);
async function clock(){const r=await store.call({op:'clock'});if(!r.ok)throw new Error('TAI_CLOCK_UNAVAILABLE');return r;}
function event(body){if(typeof body.event_b64!=='string'||body.event_b64.length>44000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.event_b64))throw new Error('INVALID_EVENT');const b=Buffer.from(body.event_b64,'base64');if(!b.length||b.length>32768)throw new Error('INVALID_EVENT');const hash=crypto.createHash('sha256').update(b).digest();return {hash,ctx:hash.subarray(0,16)};}
function send(res,status,body){if(!res.destroyed&&!res.writableEnded){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));}}
let inflight=0;const buckets=new Map();
const server=https.createServer({key:fs.readFileSync(path.join(config,'tls.key')),cert:fs.readFileSync(path.join(config,'tls.crt')),minVersion:'TLSv1.3',maxVersion:'TLSv1.3',handshakeTimeout:5000,connectionsCheckingInterval:1000},async(req,res)=>{
 const url=req.url.split('?')[0];
 if(req.method==='GET'&&url==='/health'){try{await clock();send(res,verifier.alive()&&store.alive()?200:503,{status:verifier.alive()&&store.alive()?'ok':'degraded',recordSize:180,bindingRevision:'draft13',timeProfile:'kernel CLOCK_TAI',replayBackend:'local-sqlite-FULL',application:'customer-local verification and durable admission receipts'});}catch{send(res,503,{status:'clock-unavailable'});}return;}
 if(req.method==='GET'&&url==='/v2/issuer'){send(res,200,{issuer_public:issuer.toString('hex'),issuer_key_id:1});return;}
 if(url==='/v1/legacy'||url.includes('seal_143b')){send(res,410,{error:'LEGACY_143B_NOT_ACCEPTED'});return;}
 if(req.method!=='POST'||!['/v2/seal','/v2/verify'].includes(url)){send(res,404,{error:'NOT_FOUND'});return;}
 if(url==='/v2/seal'&&!authorized(req)){send(res,401,{error:'SEAL_AUTH_REQUIRED'});return;}
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){send(res,415,{error:'APPLICATION_JSON_REQUIRED'});return;}
 const ip=req.socket.remoteAddress;let b=buckets.get(ip),now=Date.now();if(!b||now>=b.until){if(buckets.size>=4096&&!b){send(res,503,{error:'RATE_CAPACITY'});return;}b={count:0,until:now+60000};buckets.set(ip,b);}if(++b.count>ratePerMin){send(res,429,{error:'RATE_LIMIT'});return;}
 if(inflight>=64){send(res,503,{error:'BUSY'});return;}inflight++;let released=false;const release=()=>{if(!released){released=true;inflight--;}};res.once('close',release);
 const timer=setTimeout(()=>req.destroy(),5000);let size=0;const chunks=[];
 req.on('data',c=>{size+=c.length;if(size>65536){clearTimeout(timer);send(res,413,{error:'BODY_TOO_LARGE'});req.destroy();}else chunks.push(c);});
 req.on('end',async()=>{clearTimeout(timer);if(res.destroyed)return;let body;try{body=parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{send(res,400,{error:'INVALID_OR_DUPLICATE_JSON'});release();return;}
  try{const e=event(body);const currentClock=await clock();const nowUs=currentClock.now_us;
   if(url==='/v2/seal'){
    if(!/^[0-9a-f]{64}$/i.test(body.holder_public||''))throw new Error('INVALID_HOLDER');
    const record=V2.encodePotRecordV2({holderAuthType:1,algId:1,tsTaiUs:BigInt(nowUs),dispersionUs:currentClock.dispersion_us,ctxId:e.ctx,nonce:crypto.randomBytes(16),holderAuthData:Buffer.from(body.holder_public,'hex'),issuerKeyId:1},signer);
    send(res,200,{record_hex:record.toString('hex'),event_sha256:e.hash.toString('hex'),issuer_public:issuer.toString('hex')});
   }else{
    if(!/^[0-9a-f]{360}$/i.test(body.record_hex||'')||!/^[0-9a-f]{128}$/i.test(body.binding_proof||''))throw new Error('INVALID_RECORD_OR_PROOF');
    const record=Buffer.from(body.record_hex,'hex');const exporter=req.socket.exportKeyingMaterial(32,V2.DRAFT13_EXPORTER_LABEL,V2.computeDraft13ExporterContext(record,0));
    const r=await verifier.call({record_hex:body.record_hex,context_hex:e.ctx.toString('hex'),binding_proof:body.binding_proof,exporter:exporter.toString('hex'),now_us:nowUs});if(!r.ok)throw new Error(r.reason);
    const claim=crypto.createHash('sha256').update(issuer).update(record.subarray(16,48)).digest('hex');
    const receipt={receipt_id:claim,record_sha256:crypto.createHash('sha256').update(record).digest('hex'),event_sha256:e.hash.toString('hex'),admitted_tai_us:nowUs,issuer_public:issuer.toString('hex')};
    receipt.signature=crypto.sign(null,Buffer.from(JSON.stringify(receipt)),signer).toString('hex');
    const validUntil=Number(record.readBigUInt64BE(4))+600000000+record.readUInt32BE(12);
    const s=await store.call({op:'claim',claim,record:record.toString('hex'),receipt,expires_us:nowUs+r.ttl_ms*1000,valid_until_us:validUntil});if(!s.ok)throw new Error(s.reason);
    send(res,200,{verdict:'ALLOW',receipt,commitPolicy:'Use receipt_id as a unique key in the customer business transaction. No customer DB write is performed here.'});
   }
  }catch(err){const unavailable=/UNAVAILABLE|TIMEOUT|CAPACITY/.test(err.message);send(res,unavailable?503:403,{verdict:'REJECT',reason:err.message});}finally{release();}
 });req.on('error',()=>{clearTimeout(timer);release();});
});
server.on('tlsClientError',(_,socket)=>socket.destroy());server.headersTimeout=5000;server.requestTimeout=5000;server.keepAliveTimeout=5000;server.maxConnections=512;
setInterval(()=>{const now=Date.now();for(const [k,b] of buckets)if(b.until<=now)buckets.delete(k);},60000).unref();
server.listen(Number(process.env.TTTPS_PORT||8090),process.env.TTTPS_HOST||'0.0.0.0',()=>console.log('TTTPS customer-local v2 TLS service listening'));
