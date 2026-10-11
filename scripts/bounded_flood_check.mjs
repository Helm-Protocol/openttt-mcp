// Own-host, bounded application flood trial. No arbitrary remote targets or unbounded generators.
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const V2=createRequire(import.meta.url)('../dist/pot_record_v2.js');
const mode=process.env.FLOOD_MODE??'isolated';
if(!['isolated','live'].includes(mode))throw Error('Invalid bounded mode');
const port=Number(process.env.FLOOD_PORT??18092);
if(mode==='live'&&port!==8090)throw Error('Live mode is only the existing gate');
if(mode==='isolated'&&(port<18090||port>18100))throw Error('Use a designated loopback port');
const targetPid=Number(process.env.FLOOD_PID);
const publicPid=Number(process.env.PUBLIC_GATE_PID);
const agents=new Map();const outstanding=new Set();const rawSockets=new Set();const stages=[];const samples=[];
const liveIp='127.0.0.44';let abortReason=null,monitoring=false,baselineRss=0,cpuStreak=0,healthStreak=0,previousCpu;
const start=performance.now();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function agent(ip){if(!agents.has(ip))agents.set(ip,new https.Agent({keepAlive:true,maxSockets:4,localAddress:ip,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'}));return agents.get(ip);}
function request(path,body,ip='127.0.0.20',requestPort=port){
  if(abortReason)return Promise.reject(Error(abortReason));
  const payload=body===undefined?undefined:JSON.stringify(body);const t=performance.now();
  return new Promise((resolve,reject)=>{
    const req=https.request({host:'127.0.0.1',port:requestPort,servername:'api.kenosian.com',path,method:payload===undefined?'GET':'POST',agent:agent(ip),headers:payload===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(payload)}},res=>{
      let text='';res.on('data',c=>{if(text.length<8192)text+=c;});res.on('end',()=>{let parsed;try{parsed=JSON.parse(text);}catch{parsed=null;}resolve({status:res.statusCode,ms:performance.now()-t,body:parsed,socket:req.socket});});
    });
    outstanding.add(req);req.on('close',()=>outstanding.delete(req));req.on('error',reject);req.setTimeout(1500,()=>req.destroy(Error('bounded request timeout')));req.end(payload);
  });
}
function usage(pid){
  const status=fs.readFileSync(`/proc/${pid}/status`,'utf8');const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ');
  return {rssKiB:Number(/VmRSS:\s+(\d+)/.exec(status)?.[1]??0),ticks:Number(stat[11])+Number(stat[12])};
}
function stop(reason){if(abortReason)return;abortReason=reason;for(const req of outstanding)req.destroy(Error(reason));for(const socket of rawSockets)socket.destroy();}
async function sample(){
  if(monitoring)return;monitoring=true;
  try{
    const u=usage(targetPid);usage(publicPid);
    const availableKiB=Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo','utf8'))[1]);
    const now=performance.now();const cpuPercent=previousCpu?(u.ticks-previousCpu.ticks)*10/(now-previousCpu.time)*100:0;
    previousCpu={ticks:u.ticks,time:now};
    const health=await request('/health',undefined,'127.0.0.30',8090);
    samples.push({elapsedMs:now-start,rssKiB:u.rssKiB,cpuPercent,availableKiB,publicHealthStatus:health.status,publicHealthMs:health.ms});
    healthStreak=health.status!==200||health.ms>500?healthStreak+1:0;cpuStreak=cpuPercent>80?cpuStreak+1:0;
    if(healthStreak>=2)stop('public_health_threshold');
    if(cpuStreak>=3)stop('target_cpu_threshold');
    if(u.rssKiB>baselineRss+256*1024)stop('rss_threshold');
    if(availableKiB<1024*1024)stop('host_memory_threshold');
    if(now-start>45000)stop('duration_cap');
  }catch(e){stop(`monitor_failure:${e.message}`);}finally{monitoring=false;}
}
function summary(name,rows){
  const lat=rows.map(r=>r.ms).sort((a,b)=>a-b);const statuses={};for(const r of rows)statuses[r.status]=(statuses[r.status]??0)+1;
  return {name,count:rows.length,statuses,p50Ms:lat[Math.floor(lat.length*.5)]??0,p95Ms:lat[Math.min(lat.length-1,Math.floor(lat.length*.95))]??0,maxMs:lat.at(-1)??0,rejectedDrift:rows.filter(r=>r.body?.verdict==='REJECT'&&r.body?.state_drift).length};
}
async function phase(name,count,rps,ips,body){
  if(count>400||rps>(mode==='live'?10:80))throw Error('phase exceeds cap');
  const rows=[];const running=new Set();const phaseStart=performance.now();
  for(let i=0;i<count;i++){
    if(abortReason)throw Error(abortReason);
    while(running.size>=(mode==='live'?4:16))await Promise.race(running);
    const wait=phaseStart+i*1000/rps-performance.now();if(wait>0)await delay(wait);
    const p=request('/v2/verify',body,ips[i%ips.length]).then(r=>{rows.push(r);if(r.status===200)stop('unexpected_attack_acceptance');return r;}).catch(e=>{stop(e.message);return null;}).finally(()=>running.delete(p));running.add(p);
  }
  await Promise.all(running);const result=summary(name,rows);stages.push(result);console.log(JSON.stringify(result));return rows;
}
async function slowConnections(){
  const held=[];
  for(const kind of ['incomplete_tls','incomplete_headers','incomplete_body'])for(let i=0;i<4;i++){
    const connected=performance.now();const item={kind,closed:false};held.push(item);
    const s=kind==='incomplete_tls'?net.connect({host:'127.0.0.1',port}):tls.connect({host:'127.0.0.1',port,servername:'api.kenosian.com',minVersion:'TLSv1.3',maxVersion:'TLSv1.3'});
    rawSockets.add(s);s.on('error',()=>{});s.on('data',()=>{});s.on('close',()=>{item.closed=true;item.closedAfterMs=performance.now()-connected;rawSockets.delete(s);});
    if(kind!=='incomplete_tls')s.once('secureConnect',()=>s.write(kind==='incomplete_headers'?'GET /health HTTP/1.1\r\nHost: api.kenosian.com\r\n':'POST /v2/verify HTTP/1.1\r\nHost: api.kenosian.com\r\nContent-Type: application/json\r\nContent-Length: 128\r\n\r\n{'));
  }
  await delay(6500);const report={name:'slow_connections',holdLimitMs:6500,sockets:held.map(item=>({...item}))};for(const s of rawSockets)s.destroy();stages.push(report);console.log(JSON.stringify(report));if(held.some(item=>!item.closed))throw Error('slow_connection_deadline_failed');
}
let timer;
try{
  const initial=await request('/health');if(initial.status!==200)throw Error('gate not healthy');baselineRss=usage(targetPid).rssKiB;await sample();timer=setInterval(sample,500);
  const ip=mode==='live'?liveIp:'127.0.0.2';
  const token=await request('/token',undefined,ip);if(token.status!==200)throw Error('token unavailable');const attack={record_hex:token.body.record_hex,action:token.body.action};
  const before=await request('/v2/verify',{},'127.0.0.20');const initialHash=before.body.db_hash_before;
  const rows=await phase('single_ip_rate_limit',mode==='live'?150:160,mode==='live'?10:40,[ip],attack);
  if(!rows.some(r=>r.status===429))throw Error('rate limit not reached');
  if(mode==='isolated'){
    await phase('four_source_addresses',320,80,['127.0.0.3','127.0.0.4','127.0.0.5','127.0.0.6'],attack);
    const large=await request('/v2/verify',{padding:'x'.repeat(66000)},'127.0.0.7').catch(e=>({status:'connection_rejected',ms:0}));
    if(![413,'connection_rejected'].includes(large.status))throw Error('oversize accepted');stages.push({name:'oversize_body',status:large.status});
    await slowConnections();
    const key=crypto.createPrivateKey(fs.readFileSync(process.env.FLOOD_HOLDER_KEY));
    const legitimate=await request('/token',undefined,'127.0.0.20');const record=Buffer.from(legitimate.body.record_hex,'hex');
    const proof=crypto.sign(null,V2.computeDraft13BindingInput(record,legitimate.socket.exportKeyingMaterial(32,V2.DRAFT13_EXPORTER_LABEL,V2.computeDraft13ExporterContext(record,0)),0),key).toString('hex');
    const accepted=await request('/v2/verify',{record_hex:legitimate.body.record_hex,action:legitimate.body.action,binding_proof:proof},'127.0.0.20');
    if(accepted.status!==200)throw Error('normal holder cannot commit after trial');
    const replay=await request('/v2/verify',{record_hex:legitimate.body.record_hex,action:legitimate.body.action,binding_proof:proof},'127.0.0.20');
    if(replay.status!==403||replay.body.reason!=='REPLAY_LEDGER_CLAIMED')throw Error('normal replay defense failed');
    stages.push({name:'normal_holder_after_flood',status:accepted.status,replayStatus:replay.status,replayReason:replay.body.reason});
  }
  const after=await request('/v2/verify',{},'127.0.0.20');
  if(mode==='live'&&after.body.db_hash_before!==initialHash)throw Error('live canary state changed during deny-only load');
  const stats=await request('/stats');if(stats.body.drift!==0)throw Error('rejected DB drift');await sample();
}catch(e){stop(e.message);}finally{
  clearInterval(timer);while(monitoring)await delay(10);for(const req of outstanding)req.destroy();for(const s of rawSockets)s.destroy();for(const a of agents.values())a.destroy();
  const out={mode,completed:!abortReason,abortReason,durationMs:performance.now()-start,stages,samples,baselineRssKiB:baselineRss,peakRssKiB:Math.max(baselineRss,...samples.map(s=>s.rssKiB)),maxPublicHealthMs:Math.max(0,...samples.map(s=>s.publicHealthMs)),limits:{maxRps:mode==='live'?10:80,maxConcurrency:mode==='live'?4:16,totalAttackRequests:mode==='live'?150:480,maxSlowSockets:mode==='live'?0:12},scope:'loopback own-host bounded application load; not internet-scale volumetric DDoS'};
  fs.writeFileSync(process.env.FLOOD_OUTPUT,JSON.stringify(out,null,2));console.log(JSON.stringify({completed:out.completed,abortReason:out.abortReason,durationMs:out.durationMs,peakRssKiB:out.peakRssKiB,maxPublicHealthMs:out.maxPublicHealthMs}));if(abortReason)process.exitCode=1;
}
