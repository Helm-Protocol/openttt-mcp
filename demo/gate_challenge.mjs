// TTT-MCP LIVE CHALLENGE — "TTT-MCP를 뚫어라"
// Real crypto, no simulation. Uses the published package's own pot_record_v2:
//   - SHA-256 record integrity (octets 0-79)
//   - Ed25519 issuer signature (octets 0-115)
//   - argument binding: ctx_id (signed) == SHA256(canonical(action))[:16]
//   - replay ledger on the signed nonce
//   - server-clock freshness
// A real in-memory canary DB is written only after all checks pass; every request
// records the DB state hash before/after so rejected requests demonstrably leave it
// unchanged. Latency is measured (performance.now), never fudged.
import http from "node:http";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const V2 = require(path.join(here, "..", "dist", "pot_record_v2.js"));

const PORT = Number(process.env.DEMO_PORT ?? 8090);
const PUBLIC_URL = process.env.DEMO_PUBLIC_URL ?? `http://localhost:${PORT}`;
const MAX_SKEW_US = 600_000_000n; // 10 min

// ---- issuer (server) + Bob holder, generated fresh at boot ----
const issuer = crypto.generateKeyPairSync("ed25519");
const issuerPrivPkcs8 = issuer.privateKey;
const issuerPubRaw = issuer.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const bob = crypto.generateKeyPairSync("ed25519");
const bobPubRaw = bob.publicKey.export({ format: "der", type: "spki" }).subarray(-32);

// ---- canary DB ----
const canaryDb = new Map([
  ["account:bob", { balance: 1000000 }],
  ["account:eve", { balance: 0 }],
]);
function dbHash() {
  return crypto.createHash("sha256").update(JSON.stringify([...canaryDb.entries()])).digest("hex").slice(0, 16);
}
const canonical = (a) => JSON.stringify({ to: a.to, amount: a.amount });
const ctxFor = (a) => crypto.createHash("sha256").update(canonical(a)).digest().subarray(0, 16);

// ---- Bob's legit token: action bound into ctx_id, issuer-signed 180B record ----
const BOB_ACTION = { to: "account:eve", amount: 500 };
function mintBob() {
  const rec = V2.encodePotRecordV2({
    holderAuthType: 0x01, algId: 0x0001,
    tsTaiUs: BigInt(Date.now()) * 1000n, dispersionUs: 100,
    ctxId: ctxFor(BOB_ACTION), nonce: crypto.randomBytes(16),
    holderAuthData: bobPubRaw, issuerKeyId: 1,
  }, issuerPrivPkcs8);
  return rec.toString("hex");
}
let bobRecordHex = mintBob();

const replay = new Set();
const clients = new Set(); // SSE
const eventHistory = [];
let stats = { total: 0, allow: 0, reject: 0, byReason: new Map(), lat: [] };

function emit(ev) {
  eventHistory.push(ev);
  if (eventHistory.length > 500) eventHistory.shift();
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch { /* drop */ } }
}

const attackerIps = new Set();
function gate(body, clientIp) {
  const t0 = performance.now();
  const reqId = crypto.randomBytes(3).toString("hex").toUpperCase();
  if (clientIp) attackerIps.add(clientIp);
  const hBefore = dbHash();
  let verdict = "ALLOW", reason = "valid";
  try {
    const { record_hex, action } = body;
    if (typeof record_hex !== "string") throw new Error("MALFORMED_REQUEST");
    const rec = Buffer.from(record_hex, "hex");
    if (rec.length !== 180) throw new Error("INVALID_FRAME_SIZE");
    // (1) integrity + issuer signature + freshness — real pot_record_v2 verify
    const v = V2.verifyPotRecordV2(rec, issuerPubRaw, { nowTaiUs: BigInt(Date.now()) * 1000n, maxSkewUs: MAX_SKEW_US });
    if (v.verdict !== "intact") throw new Error(
      v.reason === "integrity mismatch" ? "DIGEST_MUTATION_FAIL" :
      v.reason === "issuer signature invalid" ? "ISSUER_SIGNATURE_INVALID" :
      v.reason === "freshness window exceeded" ? "STALE_TIMESTAMP" : "RECORD_REJECTED");
    // (2) argument binding — the signed ctx_id must equal SHA256(the action actually requested)
    const ctxInRecord = rec.subarray(16, 32);
    if (!ctxInRecord.equals(ctxFor(action ?? {}))) throw new Error("ARGUMENT_BINDING_FAIL");
    // (3) replay on the signed nonce
    const nonce = rec.subarray(32, 48).toString("hex");
    if (replay.has(nonce)) throw new Error("REPLAY_LEDGER_CLAIMED");
    // pass — the ONLY path that writes the DB
    replay.add(nonce);
    const from = canaryDb.get("account:bob"), to = canaryDb.get(action.to);
    if (!to) throw new Error("UNKNOWN_TARGET");
    from.balance -= action.amount; to.balance += action.amount;
  } catch (e) { verdict = "REJECT"; reason = e.message; }
  const hAfter = dbHash();
  const latencyMs = +(performance.now() - t0).toFixed(3);
  stats.total++; if (verdict === "ALLOW") stats.allow++; else { stats.reject++; stats.byReason.set(reason, (stats.byReason.get(reason) ?? 0) + 1); }
  stats.lat.push(latencyMs);
  const ev = { reqId, verdict, reason, latencyMs, hBefore, hAfter, drift: hBefore !== hAfter, ip: clientIp || "?", attackers: attackerIps.size, ts: Date.now() };
  emit(ev);
  return ev;
}

// ---- Morandi palette ----
const M = {
  paper: "#E7E2D8", panel: "#D8D0C4", panel2: "#CFC6B8", ink: "#403D37", sub: "#7C766B",
  line: "#B9AF9F", allow: "#7E9B7A", block: "#AE7A6B", accent: "#8794A3", ochre: "#C2A25E", rose: "#B98C8C",
};

function dashboardHtml() {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TTT-MCP · LIVE GATE</title><style>
:root{--paper:${M.paper};--panel:${M.panel};--panel2:${M.panel2};--ink:${M.ink};--sub:${M.sub};--line:${M.line};--allow:${M.allow};--block:${M.block};--accent:${M.accent};--ochre:${M.ochre}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 -apple-system,'Segoe UI',Roboto,'Noto Sans KR',sans-serif;letter-spacing:.2px}
.wrap{max-width:1100px;margin:0 auto;padding:28px}
h1{font-weight:600;font-size:26px;margin:0 0 2px;letter-spacing:1px}
.tag{color:var(--sub);font-size:13px;margin-bottom:22px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:16px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px 22px}
.kpi .n{font-size:40px;font-weight:600;line-height:1}.kpi .l{color:var(--sub);font-size:12px;text-transform:uppercase;letter-spacing:1.5px;margin-top:8px}
.kpi.allow .n{color:var(--allow)}.kpi.block .n{color:var(--block)}.kpi.drift .n{color:var(--ochre)}
.row{display:grid;grid-template-columns:1.6fr 1fr;gap:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:16px}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:1.5px;color:var(--sub);margin:0 0 12px;font-weight:600}
.db{display:flex;align-items:center;gap:14px;font-family:'SF Mono',ui-monospace,monospace;font-size:20px}
.db .arrow{color:var(--sub)}.db .eq{color:var(--allow);font-size:13px;font-family:inherit;margin-left:8px}
.tape{font-family:'SF Mono',ui-monospace,monospace;font-size:13px;max-height:360px;overflow:auto}
.tape .e{padding:7px 10px;border-radius:8px;margin-bottom:6px;background:var(--panel2);display:flex;gap:10px;align-items:baseline}
.badge{font-weight:600;padding:1px 8px;border-radius:6px;font-size:12px}
.badge.ALLOW{background:var(--allow);color:#f3efe8}.badge.REJECT{background:var(--block);color:#f3efe8}
.reason{color:var(--ink)}.meta{color:var(--sub);margin-left:auto;white-space:nowrap}
.lat{color:var(--accent)}
.reasons div{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--line)}
.reasons .c{color:var(--block);font-weight:600}
.foot{color:var(--sub);font-size:12px;margin-top:18px;line-height:1.7}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--allow);margin-right:6px;animation:p 1.6s infinite}
@keyframes p{0%,100%{opacity:.4}50%{opacity:1}}
</style></head><body><div class="wrap">
<h1>TTT-MCP · LIVE GATE</h1>
<div class="tag"><span class="dot"></span>@helm-protocol/ttt-mcp@0.4.5 · every value below is measured on this server — nothing simulated</div>
<div class="kpis">
  <div class="kpi allow"><div class="n" id="kAllow">0</div><div class="l">Approved</div></div>
  <div class="kpi block"><div class="n" id="kBlock">0</div><div class="l">Blocked</div></div>
  <div class="kpi drift"><div class="n" id="kDrift">0</div><div class="l">DB drift after reject</div></div>
  <div class="kpi"><div class="n" id="kIps" style="color:${M.accent}">0</div><div class="l">Attacker IPs</div></div>
</div>
<div class="card"><h2>Canary DB state hash</h2><div class="db"><span id="hB">—</span><span class="arrow">→</span><span id="hA">—</span><span class="eq" id="eq"></span></div></div>
<div class="row">
  <div class="card"><h2>Live verdict tape</h2><div class="tape" id="tape"><div style="color:var(--sub)">waiting for attacks…</div></div></div>
  <div class="card"><h2>Rejection reasons</h2><div class="reasons" id="reasons"><div style="color:var(--sub)">—</div></div>
    <h2 style="margin-top:18px">Server-measured latency</h2><div id="lat" style="font-family:ui-monospace,monospace;font-size:15px">p50 — · p99 — <span style="color:var(--sub)">(n=0)</span></div></div>
</div>
<div class="foot">Enforced before any write: SHA-256 record integrity · Ed25519 issuer signature · server-clock freshness · argument binding (ctx_id = SHA256 of the requested action) · replay ledger. A rejected request never reaches the DB — the state hash is identical before and after.</div>
</div>
<script>
let allow=0,block=0,drift=0,reasons={},lat=[];
const pct=(a,p)=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p/100*s.length))]};
const es=new EventSource('/events');
es.onmessage=(m)=>{const e=JSON.parse(m.data);
  if(e.verdict==='ALLOW')allow++;else{block++;reasons[e.reason]=(reasons[e.reason]||0)+1;if(e.drift)drift++;}
  lat.push(e.latencyMs);
  kAllow.textContent=allow;kBlock.textContent=block;kDrift.textContent=drift;if(e.attackers!=null)kIps.textContent=e.attackers;
  hB.textContent=e.hBefore;hA.textContent=e.hAfter;eq.textContent=(e.hBefore===e.hAfter?'unchanged':'CHANGED');eq.style.color=(e.hBefore===e.hAfter?'${M.allow}':'${M.block}');
  const t=document.getElementById('tape');if(t.firstChild&&t.firstChild.style&&t.firstChild.style.color)t.innerHTML='';
  const d=document.createElement('div');d.className='e';
  d.innerHTML='<span class="badge '+e.verdict+'">'+(e.verdict==='ALLOW'?'ALLOW':'BLOCK')+'</span><span class="reason">'+e.reason+'</span><span class="meta"><span style="color:${M.accent}">'+(e.ip||'?')+'</span> · <span class="lat">'+e.latencyMs+'ms</span> · '+e.hBefore+(e.hBefore===e.hAfter?'=':'≠')+e.hAfter+' · #'+e.reqId+'</span>';
  t.insertBefore(d,t.firstChild);while(t.children.length>14)t.removeChild(t.lastChild);
  const r=document.getElementById('reasons');r.innerHTML=Object.entries(reasons).sort((a,b)=>b[1]-a[1]).map(([k,v])=>'<div><span>'+k+'</span><span class="c">'+v+'</span></div>').join('')||'<div style="color:var(--sub)">—</div>';
  document.getElementById('lat').innerHTML='p50 '+ (pct(lat,50)??'—') +'ms · p99 '+ (pct(lat,99)??'—') +'ms <span style="color:var(--sub)">(n='+lat.length+')</span>';
};
</script></body></html>`;
}

function goHtml() {
  const attackBase = PUBLIC_URL;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TTT-MCP를 뚫어라</title><style>
body{margin:0;background:${M.paper};color:${M.ink};font:16px/1.6 -apple-system,'Noto Sans KR',sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:26px}
h1{font-weight:600;letter-spacing:1px;font-size:24px;margin:0 0 4px}.sub{color:${M.sub};margin-bottom:20px;font-size:14px}
.card{background:${M.panel};border:1px solid ${M.line};border-radius:14px;padding:16px 18px;margin-bottom:14px}
.card h3{margin:0 0 8px;font-size:14px;letter-spacing:.5px}
pre{background:${M.panel2};border:1px solid ${M.line};border-radius:10px;padding:12px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:8px 0 0}
.btn{display:inline-block;background:${M.accent};color:#f3efe8;border:none;border-radius:9px;padding:9px 14px;font-size:14px;cursor:pointer;margin-top:8px}
.exp{color:${M.block};font-weight:600;font-size:13px}
.ok{color:${M.allow};font-weight:600}
code{background:${M.panel2};padding:1px 5px;border-radius:5px}
</style></head><body><div class="wrap">
<h1>⚔️ TTT-MCP를 뚫어라</h1>
<div class="sub">@helm-protocol/ttt-mcp@0.4.5 · Target <code>${attackBase}/mcp/db-write</code><br>단 1바이트의 DB 오염도 허용하지 않습니다. 아래를 복사해 쏴보세요.</div>
<div class="card"><h3>Bob의 정식 토큰 (실시간 발급)</h3>
<div class="sub" id="bobmeta">불러오는 중…</div><pre id="bobrec">…</pre>
<button class="btn" id="copyRec">record 복사</button></div>
<div class="card"><h3>🤖 Fable 에이전트로 공격 (추천)</h3>
<div class="sub">방금 만든 여러분의 Claude/Fable 에이전트에 아래를 그대로 던지세요.</div>
<pre id="fablePrompt"></pre><button class="btn" id="copyPrompt">프롬프트 복사</button></div>
<div class="card"><h3>🟢 정상 송금 (amount 500)</h3><pre id="cNormal"></pre><span class="ok">기대: ALLOW · DB 해시 1회 변경</span></div>
<div class="card"><h3>🔴 재전송</h3><div class="sub">위 정상 요청을 한 번 더</div><span class="exp">기대: REPLAY_LEDGER_CLAIMED</span></div>
<div class="card"><h3>🔴 토큰 1바이트 변조</h3><div class="sub">record 맨 끝 두 글자를 아무거나 바꿔서</div><span class="exp">기대: DIGEST_MUTATION_FAIL / ISSUER_SIGNATURE_INVALID</span></div>
<div class="card"><h3>🔴 송금액 조작 (핵심)</h3><div class="sub">record는 그대로, action.amount만 500 → 500000</div><pre id="cAmount"></pre><span class="exp">기대: ARGUMENT_BINDING_FAIL · DB 불변</span></div>
<div class="sub">좌측 대형 화면에 여러분의 요청 판정과 DB 해시 전후가 실시간으로 뜹니다.</div>
</div>
<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js" onerror="document.getElementById('qr').textContent='QR lib offline — URL: '+location.href"></script>
<script>
fetch('/bob').then(r=>r.json()).then(b=>{
  document.getElementById('bobmeta').textContent='action: '+JSON.stringify(b.action)+' · issuer '+b.issuerPub.slice(0,12)+'…';
  document.getElementById('bobrec').textContent=b.record_hex;
  const base="curl -X POST ${attackBase}/mcp/db-write -H 'content-type: application/json' -d ";
  const normal=JSON.stringify({record_hex:b.record_hex,action:b.action});
  const amount=JSON.stringify({record_hex:b.record_hex,action:{to:'account:eve',amount:500000}});
  document.getElementById('cNormal').textContent=base+"'"+normal+"'";
  document.getElementById('cAmount').textContent=base+"'"+amount+"'";
  document.getElementById('copyRec').onclick=()=>navigator.clipboard.writeText(b.record_hex);
  const prompt="너는 결제 에이전트야. 아래 TTT-MCP 엔드포인트에 POST /mcp/db-write 로 송금을 실행해줘.\\n"+
    "endpoint: ${attackBase}/mcp/db-write\\n"+
    "record_hex: "+b.record_hex+"\\n"+
    "정상 요청 body: "+JSON.stringify({record_hex:b.record_hex,action:b.action})+"\\n"+
    "이제 이 토큰으로 상대 잔액을 오염시켜봐 — amount를 1000000으로 키우거나, 같은 요청을 여러 번 재전송하거나, record 한 바이트를 바꿔서 시도해줘. 성공하면 알려줘.";
  document.getElementById('fablePrompt').textContent=prompt;
  document.getElementById('copyPrompt').onclick=()=>navigator.clipboard.writeText(prompt);
});
</script></body></html>`;
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (req.method === "GET" && url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(dashboardHtml()); }
  if (req.method === "GET" && url === "/go") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(goHtml()); }
  // Each participant gets their OWN fresh temporary token (unique signed nonce),
  // bound to the same legit action {to:eve, amount:500}. A correct use transfers 500
  // once; replays and any argument change are rejected.
  if (req.method === "GET" && (url === "/bob" || url === "/token")) {
    const fresh = mintBob();
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ record_hex: fresh, action: BOB_ACTION, issuerPub: issuerPubRaw.toString("hex"), endpoint: `${PUBLIC_URL}/mcp/db-write` }));
  }
  if (req.method === "GET" && url === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(":\n\n"); for (const ev of eventHistory) res.write(`data: ${JSON.stringify(ev)}\n\n`); clients.add(res); req.on("close", () => clients.delete(res)); return;
  }
  if (req.method === "POST" && url === "/mcp/db-write") {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      let parsed; try { parsed = JSON.parse(b); } catch { res.writeHead(400); return res.end('{"error":"bad json"}'); }
      const clientIp = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "?").replace("::ffff:", "");
      const ev = gate(parsed, clientIp);
      res.writeHead(ev.verdict === "ALLOW" ? 200 : 403, { "content-type": "application/json" });
      res.end(JSON.stringify({ req_id: ev.reqId, verdict: ev.verdict, reason: ev.reason, latency_ms: ev.latencyMs, db_hash_before: ev.hBefore, db_hash_after: ev.hAfter, state_drift: ev.drift }));
    });
    return;
  }
  if (req.method === "POST" && url === "/admin/reset-bob") { bobRecordHex = mintBob(); res.writeHead(200); return res.end("{}"); }
  res.writeHead(404); res.end();
});
server.listen(PORT, () => {
  console.log(`TTT-MCP LIVE GATE demo on ${PUBLIC_URL}`);
  console.log(`  dashboard  ${PUBLIC_URL}/`);
  console.log(`  challenge  ${PUBLIC_URL}/go   (QR this)`);
  console.log(`  initial DB hash ${dbHash()}`);
});
