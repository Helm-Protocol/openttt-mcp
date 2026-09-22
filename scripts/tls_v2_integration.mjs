import fs from "node:fs";
import tls from "node:tls";
import crypto from "node:crypto";
import { encodePotRecordV2, computeV2ExporterContext, computeV2BindingInput, verifyPotRecordV2, verifyV2BindingProof } from "../dist/pot_record_v2.js";
import { exporterForTlsSocket } from "../dist/tls_exporter.js";

const [keyPath, certPath] = process.argv.slice(2);
if (!keyPath || !certPath) throw new Error("usage: node scripts/tls_v2_integration.mjs KEY.pem CERT.pem");

const issuer = crypto.generateKeyPairSync("ed25519");
const holder = crypto.generateKeyPairSync("ed25519");
const holderPub = holder.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const issuerPub = issuer.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const record = encodePotRecordV2({
  holderAuthType: 0x01,
  algId: 0x0001,
  tsTaiUs: 1800000000000000n,
  dispersionUs: 100,
  ctxId: Buffer.alloc(16, 7),
  nonce: Buffer.alloc(16, 8),
  holderAuthData: holderPub,
  issuerKeyId: 1,
}, issuer.privateKey);

const server = tls.createServer({
  key: fs.readFileSync(keyPath),
  cert: fs.readFileSync(certPath),
  minVersion: "TLSv1.3",
}, (socket) => {
  socket.once("data", () => {
    const exporter = exporterForTlsSocket(socket);
    if (!exporter) throw new Error("server exporter unavailable");
    const exporterOutput = exporter(computeV2ExporterContext(record));
    const proof = crypto.sign(null, computeV2BindingInput(record, exporterOutput), holder.privateKey);
    if (verifyPotRecordV2(record, issuerPub).verdict !== "intact") throw new Error("core verify failed");
    if (verifyV2BindingProof(record, proof, exporterOutput).verdict !== "intact") throw new Error("binding verify failed");
    if (verifyV2BindingProof(record, proof, Buffer.alloc(32, 0x99)).verdict !== "rejected") throw new Error("cross-session binding accepted");
    console.log("TLS_V2_INTEGRATION_PASS protocol=TLSv1.3 record=180 binding=Ed25519 cross_session=reject");
    socket.end();
    server.close(() => process.exit(0));
  });
});
server.on("tlsClientError", (error) => { console.error(error); process.exitCode = 1; });
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const client = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, minVersion: "TLSv1.3" }, () => client.write("go"));
  client.on("error", (error) => { console.error(error); process.exitCode = 1; });
});
setTimeout(() => { console.error("integration timeout"); process.exit(1); }, 10000).unref();
