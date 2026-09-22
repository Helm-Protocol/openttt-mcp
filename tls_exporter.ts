import type * as http from "node:http";
import type * as tls from "node:tls";

export const TTTPS_V2_EXPORTER_LABEL = "EXPORTER-TTTPS-v2-Binding";
export const TTTPS_V2_EXPORTER_LENGTH = 32;

export type TlsExporter = (contextValue: Buffer) => Buffer;

/**
 * Returns a live TLS 1.3 exporter function for the request socket.
 *
 * No stdio fallback is provided: stdio has no TLS exporter and must either
 * use an explicitly specified non-TLS profile or fail closed when v2 binding
 * is required. The context is supplied later because draft-11 binds it to
 * the complete 180-octet record.
 */
export function exporterForTlsSocket(socket: tls.TLSSocket): TlsExporter | undefined {
  if (!socket.encrypted || typeof socket.exportKeyingMaterial !== "function") return undefined;
  if (typeof socket.getProtocol === "function" && socket.getProtocol() !== "TLSv1.3") return undefined;
  return (contextValue: Buffer) =>
    socket.exportKeyingMaterial(TTTPS_V2_EXPORTER_LENGTH, TTTPS_V2_EXPORTER_LABEL, contextValue);
}

export function extractTls13Exporter(req: http.IncomingMessage): TlsExporter | undefined {
  return exporterForTlsSocket(req.socket as tls.TLSSocket);
}
