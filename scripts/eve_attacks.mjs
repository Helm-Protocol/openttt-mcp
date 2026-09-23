// Eve — the attacker. Each attack hits the REAL server; the war room shows the
// server's own verdict. Nothing here is simulated. Attacks map to the verdict the
// published 0.4.0 package actually returns today (Tier 1). The one case the package
// does NOT yet block (attacker mints with her own issuer key + issuerPubKey arg) is
// the --gap probe, shown honestly to motivate the authorization layer (Tier 2).
import crypto from "node:crypto";
import fs from "node:fs";
import { Session, loadV2, parseToolResult } from "./lib/mcp_tls_client.mjs";

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); if (i < 0) return def; const n = process.argv[i + 1]; return n === undefined || n.startsWith("--") ? true : n; }
const HOST = arg("host", "127.0.0.1"), PORT = arg("port", "8443");
const INSECURE = String(arg("insecure", "false")) === "true";
const USED = JSON.parse(fs.readFileSync(arg("used", "/tmp/buildday/bob_used.json"), "utf8"));
const ONLY = arg("only", null);
const GAP = arg("gap", false) === true;

const { encodePotRecordV2, computeV2ExporterContext, computeV2BindingInput } = loadV2();

async function verify(sess, args) {
  const r = parseToolResult((await sess.rpc("tools/call", { name: "pot_verify_v2", arguments: args })).body);
  return r.tool ?? r;
}
const line = (id, name, res) => {
  const v = res?.verdict ?? "?", reason = res?.reason ?? "", us = res?.serverLatencyUs;
  const mark = v === "rejected" ? "\x1b[92mBLOCKED\x1b[0m" : v === "intact" ? "\x1b[91mPASSED \x1b[0m" : "\x1b[93m?      \x1b[0m";
  console.log(`  [${id}] ${mark} ${name.padEnd(34)} verdict=${v}${reason ? ` reason="${reason}"` : ""}${us !== undefined ? ` (${us}us)` : ""}`);
  return v;
};

const attacks = {
  // A) Cross-session hijack: replay Bob's exact record+proof from Eve's own TLS session.
  hijack: async () => {
    const s = new Session({ host: HOST, port: PORT, insecure: INSECURE });
    const res = await verify(s, { potRecordV2: USED.potRecordV2, bindingProof: USED.bindingProof, clientId: "eve", sessionId: "eve-hijack" });
    s.close();
    return line("A", "cross-session hijack", res);
  },
  // B) Tamper: flip one octet of Bob's record, keep his proof.
  tamper: async () => {
    const s = new Session({ host: HOST, port: PORT, insecure: INSECURE });
    const buf = Buffer.from(USED.potRecordV2, "hex"); buf[60] ^= 0xff;
    const res = await verify(s, { potRecordV2: buf.toString("hex"), bindingProof: USED.bindingProof, clientId: "eve", sessionId: "eve-tamper" });
    s.close();
    return line("B", "1-octet record tamper", res);
  },
  // C) Forgery: Eve mints her own record with her OWN issuer key, binds it correctly to
  //    her live session, but does NOT get to supply a matching server issuer key.
  forge: async () => {
    const s = new Session({ host: HOST, port: PORT, insecure: INSECURE });
    const issuer = crypto.generateKeyPairSync("ed25519");
    const holder = crypto.generateKeyPairSync("ed25519");
    const holderPub = holder.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const rec = encodePotRecordV2({
      holderAuthType: 0x01, algId: 0x0001, tsTaiUs: BigInt(Date.now()) * 1000n, dispersionUs: 100,
      ctxId: crypto.randomBytes(16), nonce: crypto.randomBytes(16), holderAuthData: holderPub, issuerKeyId: 0xdeadbeef,
    }, issuer.privateKey);
    await s.rpc("tools/call", { name: "pot_health", arguments: {} }); // warm socket (not audited)
    const out = s.exporter(computeV2ExporterContext(rec));
    const proof = crypto.sign(null, computeV2BindingInput(rec, out), holder.privateKey);
    const res = await verify(s, { potRecordV2: rec.toString("hex"), bindingProof: proof.toString("hex"), clientId: "eve", sessionId: "eve-forge" });
    s.close();
    return line("C", "forged issuer signature", res);
  },
  // GAP) The honest hole: same forgery, but Eve also supplies her own issuerPubKey arg.
  //      Tier 1 checks the sig against whatever key the caller passes → intact. Tier 2 fixes this.
  gap: async () => {
    const s = new Session({ host: HOST, port: PORT, insecure: INSECURE });
    const issuer = crypto.generateKeyPairSync("ed25519");
    const holder = crypto.generateKeyPairSync("ed25519");
    const issuerPubRaw = issuer.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const holderPub = holder.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const rec = encodePotRecordV2({
      holderAuthType: 0x01, algId: 0x0001, tsTaiUs: BigInt(Date.now()) * 1000n, dispersionUs: 100,
      ctxId: crypto.randomBytes(16), nonce: crypto.randomBytes(16), holderAuthData: holderPub, issuerKeyId: 1,
    }, issuer.privateKey);
    await s.rpc("tools/call", { name: "pot_health", arguments: {} });
    const out = s.exporter(computeV2ExporterContext(rec));
    const proof = crypto.sign(null, computeV2BindingInput(rec, out), holder.privateKey);
    const res = await verify(s, { potRecordV2: rec.toString("hex"), bindingProof: proof.toString("hex"), issuerPubKey: issuerPubRaw.toString("hex"), clientId: "eve", sessionId: "eve-gap" });
    s.close();
    return line("GAP", "attacker's own issuer key (Tier-1 hole)", res);
  },
};

console.log(`\n── EVE (attacker) → https://${HOST}:${PORT}/mcp ─────────────`);
const order = ONLY ? [ONLY] : ["hijack", "tamper", "forge", ...(GAP ? ["gap"] : [])];
for (const name of order) { if (attacks[name]) await attacks[name](); else console.log(`  unknown attack: ${name}`); }
console.log("");
