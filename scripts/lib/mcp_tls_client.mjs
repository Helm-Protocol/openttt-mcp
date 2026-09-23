// One MCP client == one TLS 1.3 session.
// Uses Node https with a single-socket keep-alive agent so the client can read the
// RFC 5705 keying-material exporter of the exact session its requests travel on.
// That exporter, on both endpoints of one TLS 1.3 session, yields the same value,
// which is what binds a v2 holder proof to a live channel.
import https from "node:https";
import tls from "node:tls";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

export function loadV2() {
  for (const c of [
    path.join(here, "..", "..", "dist", "pot_record_v2.js"),
    "@helm-protocol/ttt-mcp/dist/pot_record_v2.js",
  ]) {
    try { return require(c); } catch { /* try next */ }
  }
  throw new Error("pot_record_v2.js not found — run `npm run build`, or `npm i @helm-protocol/ttt-mcp`.");
}

export const EXPORTER_LABEL = "EXPORTER-TTTPS-v2-Binding";
export const EXPORTER_LENGTH = 32;

export class Session {
  constructor(opts) {
    this.host = opts.host;
    this.port = Number(opts.port ?? 8443);
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(opts.host);
    this.servername = opts.servername ?? (isIp ? undefined : opts.host);
    this.insecure = Boolean(opts.insecure);
    this.mcpPath = opts.path ?? "/mcp";
    this.tlsSocket = null;
    this.agent = new https.Agent({
      keepAlive: true, maxSockets: 1, maxFreeSockets: 1,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
    });
    this._id = 1;
  }

  exporter(contextValue) {
    if (!this.tlsSocket) throw new Error("no live TLS session yet — call rpc() once first");
    return this.tlsSocket.exportKeyingMaterial(EXPORTER_LENGTH, EXPORTER_LABEL, contextValue);
  }

  channel() {
    const s = this.tlsSocket;
    return s ? { protocol: s.getProtocol(), cipher: s.getCipher()?.name, authorized: s.authorized } : null;
  }

  close() { try { this.agent.destroy(); } catch { /* ignore */ } }

  rpc(method, params, headers = {}) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: this._id++, method, params });
    const options = {
      host: this.host, port: this.port, servername: this.servername, path: this.mcpPath,
      method: "POST", agent: this.agent, rejectUnauthorized: !this.insecure,
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "content-length": Buffer.byteLength(body),
        ...headers,
      },
    };
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (d) => { data += d; });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });
      req.on("socket", (sock) => {
        if (sock instanceof tls.TLSSocket) {
          const grab = () => { this.tlsSocket = sock; };
          if (sock.getProtocol && sock.getProtocol()) grab(); else sock.once("secureConnect", grab);
        }
      });
      req.on("error", reject);
      req.end(body);
    });
  }
}

// MCP Streamable-HTTP responses may be SSE ("data: {json}") or bare JSON.
export function parseToolResult(httpBody) {
  let json = httpBody.trim();
  if (json.startsWith("event:") || json.includes("\ndata:") || json.startsWith("data:")) {
    const line = json.split("\n").find((l) => l.startsWith("data:"));
    if (line) json = line.slice(5).trim();
  }
  const rpc = JSON.parse(json);
  if (rpc.error) return { rpcError: rpc.error };
  const content = rpc.result?.content?.[0]?.text;
  return { rpc, tool: content ? JSON.parse(content) : rpc.result };
}
