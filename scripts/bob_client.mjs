// Bob — the legitimate agent. Issues one valid draft-11 v2 record over a live TLS 1.3
// session, binds it to that exact session's exporter, and runs one successful verify.
// Publishes the *used* record + proof so the audience can try to reuse it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Session, loadV2, parseToolResult } from "./lib/mcp_tls_client.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1] === undefined || process.argv[i + 1]?.startsWith("--") ? true : process.argv[i + 1];
  return def;
}

const HOST = arg("host", "127.0.0.1");
const PORT = arg("port", "8443");
const INSECURE = arg("insecure", false) === true || arg("insecure", "false") === "true";
const KEYFILE = arg("key", "/tmp/buildday/bob_holder_key.json");
const OUTDIR = arg("out", "/tmp/buildday");
const REPLAY = arg("replay", false) === true;

fs.mkdirSync(OUTDIR, { recursive: true });
fs.mkdirSync(path.dirname(KEYFILE), { recursive: true });

// Bob's holder key: reused across runs if present (his private key never leaves this file).
let holderPriv, holderPubRaw;
if (fs.existsSync(KEYFILE)) {
  const saved = JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
  holderPriv = crypto.createPrivateKey({ key: Buffer.from(saved.pkcs8, "base64"), format: "der", type: "pkcs8" });
  holderPubRaw = Buffer.from(saved.pubRaw, "hex");
} else {
  const kp = crypto.generateKeyPairSync("ed25519");
  holderPriv = kp.privateKey;
  holderPubRaw = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  fs.writeFileSync(KEYFILE, JSON.stringify({
    pkcs8: holderPriv.export({ format: "der", type: "pkcs8" }).toString("base64"),
    pubRaw: holderPubRaw.toString("hex"),
  }), { mode: 0o600 });
}

const { computeV2ExporterContext, computeV2BindingInput } = loadV2();

const action = { subject: "bob@kenosian.com", verb: "db_write", target: "account:eve", body: { amount: 500000 }, runId: crypto.randomUUID() };
const ctxId = crypto.createHash("sha256").update(JSON.stringify(action)).digest().subarray(0, 16);

const s = new Session({ host: HOST, port: PORT, insecure: INSECURE });

const gen = parseToolResult((await s.rpc("tools/call", {
  name: "pot_generate_v2",
  arguments: {
    tsTaiUs: String(BigInt(Date.now()) * 1000n),
    dispersionUs: 100,
    ctxId: ctxId.toString("hex"),
    holderAuthData: holderPubRaw.toString("hex"),
    holderAuthType: 0x01,
  },
})).body);

if (!gen.tool?.potRecordV2) { console.error("pot_generate_v2 failed:", JSON.stringify(gen)); process.exit(1); }
const recordHex = gen.tool.potRecordV2;
const record = Buffer.from(recordHex, "hex");

const ch = s.channel();
if (!ch || ch.protocol !== "TLSv1.3") { console.error("not on TLS 1.3, refusing to bind:", ch); process.exit(1); }

const exporterOutput = s.exporter(computeV2ExporterContext(record));
const proof = crypto.sign(null, computeV2BindingInput(record, exporterOutput), holderPriv);

const verify = parseToolResult((await s.rpc("tools/call", {
  name: "pot_verify_v2",
  arguments: { potRecordV2: recordHex, bindingProof: proof.toString("hex"), clientId: "bob", sessionId: s._id2 ?? "bob-session" },
})).body);

const used = {
  note: "PUBLIC. This record and proof were already consumed by Bob on his own TLS session.",
  endpoint: `https://${HOST}:${PORT}/mcp`,
  action, ctxId: ctxId.toString("hex"),
  potRecordV2: recordHex,
  bindingProof: proof.toString("hex"),
  issuerPubKey: gen.tool.issuerPubKey,
  holderPubKey: holderPubRaw.toString("hex"),
  firstVerdict: verify.tool?.verdict ?? verify,
};
fs.writeFileSync(path.join(OUTDIR, "bob_used.json"), JSON.stringify(used, null, 2));

console.log("── BOB (legitimate agent) ──────────────────────────────");
console.log("channel      :", ch.protocol, ch.cipher);
console.log("action       :", JSON.stringify(action));
console.log("ctxId        :", ctxId.toString("hex"));
console.log("first verify :", verify.tool?.verdict ?? JSON.stringify(verify), verify.tool?.serverLatencyUs ? `(${verify.tool.serverLatencyUs}us server)` : "");
console.log("published    :", path.join(OUTDIR, "bob_used.json"));

if (REPLAY) {
  const again = parseToolResult((await s.rpc("tools/call", {
    name: "pot_verify_v2",
    arguments: { potRecordV2: recordHex, bindingProof: proof.toString("hex"), clientId: "bob", sessionId: "bob-session" },
  })).body);
  console.log("replay(self) :", again.tool?.verdict, "-", again.tool?.reason ?? "");
}
s.close();
