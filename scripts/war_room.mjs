// War room — reads the server's own verdict audit stream (Redis) and renders it.
// Every number on screen is read from the stream the server wrote. Latency is the
// server-measured value per call. No verdict, count, or timing is fabricated here.
import Redis from "ioredis";

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }
const REDIS_URL = arg("redis", process.env.REDIS_URL ?? "redis://127.0.0.1:6380");
const STREAM = arg("stream", process.env.TTTPS_AUDIT_STREAM ?? "tttps:audit:v2");
const FROM = process.argv.includes("--from-start") ? "0" : "$";

const C = { red: "\x1b[91m", grn: "\x1b[92m", ylw: "\x1b[93m", cyn: "\x1b[96m", dim: "\x1b[90m", b: "\x1b[1m", r: "\x1b[0m", bgR: "\x1b[41m\x1b[97m" };
const redis = new Redis(REDIS_URL, { lazyConnect: true });

const stats = { total: 0, intact: 0, rejected: 0, other: 0, byReason: new Map(), byTransport: new Map(), lat: [], tape: [] };
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const short = (h) => (h ? h.slice(0, 8) : "········");

function render() {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  process.stdout.write("\x1b[2J\x1b[H");
  const blockRate = stats.total ? ((stats.rejected / stats.total) * 100).toFixed(1) : "—";
  console.log(`${C.cyn}${C.b}  TTTPS v2 GATE · LIVE WAR ROOM${C.r}   ${C.dim}@helm-protocol/ttt-mcp@0.4.3${C.r}`);
  console.log(`${C.dim}  ${now} · stream ${STREAM} · every value below is read from the server's verdict log${C.r}`);
  console.log(`${C.cyn}${"─".repeat(72)}${C.r}`);
  console.log(`   ${C.b}INGRESS ${String(stats.total).padStart(5)}${C.r}     ${C.grn}${C.b}APPROVED ${String(stats.intact).padStart(4)}${C.r}     ${C.red}${C.b}REJECTED ${String(stats.rejected).padStart(4)}${C.r}   ${C.dim}(${blockRate}% blocked)${C.r}`);
  console.log(`${C.cyn}${"─".repeat(72)}${C.r}`);
  console.log(`  ${C.b}REJECTION REASONS (server-returned):${C.r}`);
  if (!stats.byReason.size) console.log(`   ${C.dim}(none yet)${C.r}`);
  for (const [reason, n] of [...stats.byReason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6))
    console.log(`   ${C.red}${String(n).padStart(4)}${C.r}  ${reason}`);
  console.log(`${C.cyn}${"─".repeat(72)}${C.r}`);
  const p50 = pct(stats.lat, 50), p99 = pct(stats.lat, 99);
  console.log(`  ${C.b}SERVER-MEASURED LATENCY${C.r}  p50 ${p50 === null ? `${C.dim}NOT MEASURED${C.r}` : `${p50}us`}   p99 ${p99 === null ? `${C.dim}NOT MEASURED${C.r}` : `${p99}us`}   ${C.dim}(n=${stats.lat.length})${C.r}`);
  console.log(`${C.cyn}${"─".repeat(72)}${C.r}`);
  console.log(`  ${C.b}${C.bgR} LIVE VERDICT TAPE ${C.r}\n`);
  if (!stats.tape.length) console.log(`   ${C.ylw}waiting for attacks… point clients at this server's /mcp${C.r}`);
  for (const t of stats.tape.slice(-12)) console.log("   " + t);
  console.log(`\n${C.cyn}${"─".repeat(72)}${C.r}`);
}

function ingest(fields) {
  const f = {};
  for (let i = 0; i < fields.length; i += 2) f[fields[i]] = fields[i + 1];
  stats.total++;
  const t = (f.ts_ms ? new Date(Number(f.ts_ms)) : new Date()).toISOString().slice(11, 23);
  const us = Number(f.latency_us); if (Number.isFinite(us)) stats.lat.push(us);
  stats.byTransport.set(f.transport, (stats.byTransport.get(f.transport) ?? 0) + 1);
  let mark;
  if (f.verdict === "intact") { stats.intact++; mark = `${C.red}PASSED ${C.r}`; }
  else if (f.verdict === "rejected") { stats.rejected++; mark = `${C.grn}BLOCKED${C.r}`; stats.byReason.set(f.reason || "(no reason)", (stats.byReason.get(f.reason || "(no reason)") ?? 0) + 1); }
  else { stats.other++; mark = `${C.ylw}${f.verdict}${C.r}`; }
  stats.tape.push(`${C.dim}${t}${C.r} ${mark} ${(f.reason || f.verdict).padEnd(30)} ${C.dim}${f.transport}/${f.binding_proof} sha=${short(f.record_sha16)} nonce=${short(f.nonce)} ${us}us${C.r}`);
}

const SNAPSHOT = process.argv.includes("--snapshot");

async function main() {
  await redis.connect();
  if (SNAPSHOT) {
    const res = await redis.call("XRANGE", STREAM, "-", "+");
    if (res) for (const [, fields] of res) ingest(fields);
    render();
    await redis.quit();
    return;
  }
  render();
  let last = FROM;
  for (;;) {
    const res = await redis.call("XREAD", "BLOCK", "1000", "COUNT", "50", "STREAMS", STREAM, last);
    if (res) { for (const [, entries] of res) for (const [id, fields] of entries) { last = id; ingest(fields); } render(); }
  }
}
main().catch((e) => { console.error("war room error:", e.message); process.exit(1); });
