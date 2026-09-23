#!/usr/bin/env node
// @helm-protocol/ttt-mcp — MCP Server for OpenTTT Proof of Time
// Provides 10 tools for AI agents: pot_generate, pot_verify, pot_generate_v2, pot_verify_v2, pot_verify_v08,
// pot_query, pot_graph, pot_stats, pot_health, pot_checkpoint

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "http";
import { createServer as createHttpsServer } from "https";
import { readFileSync } from "fs";
import { extractTls13Exporter } from "./tls_exporter";
import { withTransportBinding } from "./transport_context";
import { z } from "zod";
import { potGenerate, potGenerateV2, potVerify, potVerifyV2, potVerifyV08, potQuery, potGraph, potStats, potHealth, potCheckpoint, restoreDagEntry, redis, tttsFreshnessSeal } from "./tools";
import { checkRateLimit, resolveApiKey } from "./auth";
import { FREE_TIER_UPGRADE_MESSAGE, UPGRADE_URL, QuotaExceededError } from "./server";

// ---------- DAG Recovery from Redis on server restart ----------

interface PersistedDagEntry {
  eventId: string;
  prevEventId: string | null;
  potHash: string;
  timestamp: string;
  stratum: number;
  mode: string;
  createdAt: number;
  chainId: number | null;
  poolAddress: string | null;
}

async function restoreDAGFromRedis(): Promise<number> {
  try {
    // Connect with a short timeout — Redis is optional
    await Promise.race([
      redis.connect(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
  } catch {
    return 0; // Redis unavailable — proceed with empty in-memory DAG
  }

  let cursor = "0";
  let restored = 0;
  const entries: PersistedDagEntry[] = [];

  try {
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "dag:*", "COUNT", "200");
      cursor = next;
      if (keys.length === 0) continue;
      const values = await redis.mget(...keys);
      for (const v of values) {
        if (!v) continue;
        try {
          const entry = JSON.parse(v) as PersistedDagEntry;
          if (entry.eventId) entries.push(entry);
        } catch {
          // malformed entry — skip
        }
      }
    } while (cursor !== "0");
  } catch {
    return 0; // scan failed — treat as empty
  }

  // Sort by createdAt ascending so prevEventId references are inserted before their children
  entries.sort((a, b) => a.createdAt - b.createdAt);

  for (const e of entries) {
    try {
      restoreDagEntry({
        eventId: e.eventId,
        prevEventId: e.prevEventId,
        potHash: e.potHash,
        timestamp: e.timestamp,
        stratum: e.stratum,
        mode: e.mode,
        createdAt: e.createdAt,
        chainId: e.chainId,
        poolAddress: e.poolAddress,
      });
      restored++;
    } catch {
      // skip invalid entry
    }
  }

  if (restored > 0) {
    console.error(`[ttt-mcp] DAG restored from Redis: ${restored} entries`);
  }
  return restored;
}

// ---------- Helper: build a fresh McpServer per HTTP request ----------
// In stateless mode, StreamableHTTPServerTransport cannot be reused across
// requests (throws "Stateless transport cannot be reused...").
// We therefore create a new McpServer + transport per POST request.

// Format a tool error as MCP content. QuotaExceededError surfaces the upgrade
// page so the user gets a natural, actionable message (no overstatement).
function toolError(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  if (err instanceof QuotaExceededError) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { error: "quota_exceeded", tier: err.tier, message: err.message, upgradeUrl: err.upgradeUrl },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

// Wrap a successful tool result as MCP content.
// If the result carries a _quotaNotice field (injected by applyAdvisory in tools.ts),
// it is surfaced as a separate advisory text block — normal result is always first.
// TTT Seal Layer (v0.3.1): appends _tttps_freshness to every object response.
function toolSuccess(result: unknown): { content: { type: "text"; text: string }[] } {
  const seal = tttsFreshnessSeal();
  if (seal && result !== null && typeof result === "object") {
    const r = result as Record<string, unknown>;
    const notice = r._quotaNotice as string | undefined;
    if (notice) {
      const { _quotaNotice: _, ...rest } = r;
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ ...rest, _tttps_freshness: seal }, null, 2) },
          { type: "text" as const, text: `⚠ Quota notice: ${notice}` },
        ],
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ ...(result as object), _tttps_freshness: seal }, null, 2) }] };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function buildMcpServer(): McpServer {
  const s = new McpServer({ name: "ttt-mcp", version: "0.4.3" });
  // MCP SDK tool overloads can exceed TypeScript instantiation depth in clean CI installs.
  // Runtime registration remains the SDK method; this local boundary keeps the published build deterministic.
  const registerTool: any = s.tool.bind(s);

  registerTool(
    "pot_generate",
    "Generate a cryptographic Proof of Time timestamp (draft-helmprotocol-tttps, https://datatracker.ietf.org/doc/draft-helmprotocol-tttps/). For Claude Code workflows: use eventId + prevEventId to build a causal chain. For DeFi: use txHash + chainId + poolAddress. For a spec-conformant draft-08 §3 record binding this attestation to a specific piece of content, also supply contentDigest. One of eventId, txHash, or contentDigest is required.",
    {
      eventId: z.string().optional().describe("Workflow step identifier (Claude Code). E.g. 'refactor_auth_step1'"),
      prevEventId: z.string().optional().describe("Previous step's eventId — links steps into a causal chain"),
      txHash: z.string().optional().describe("Transaction hash (DeFi, hex with 0x prefix)"),
      chainId: z.number().optional().describe("EVM chain ID (DeFi, e.g. 8453 for Base)"),
      poolAddress: z.string().optional().describe("DEX pool contract address (DeFi)"),
      contentDigest: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional()
        .describe(
          "SHA-256 digest (lowercase hex, 64 characters) of the content this record attests to. Computed by the caller — the server never sees the content itself. When supplied, and the local time synthesis meets draft-08's own requirements (>=3 independent sources, a representable error bound), the response includes a spec-conformant potRecordV08 binary record (hex-encoded) in addition to the usual potHash fields; otherwise potRecordV08Error explains why it could not be produced."
        ),
      ctxId: z
        .string()
        .max(255)
        .optional()
        .describe("draft-08 §3.3 context identifier (domain separator for the Commitment). Defaults to a fixed server value if omitted; MAY be public."),
    },
    { title: "Generate Proof of Time", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args: any) => {
      try {
        const result = await potGenerate(args);
        return toolSuccess(result);
      } catch (err: unknown) {
        return toolError(err);
      }
    }
  );

  registerTool(
    "pot_verify",
    "Verify a Proof of Time using its hash and integrity shards. Returns validity, mode (turbo/full), and timestamp.",
    {
      potHash: z.string().describe("PoT hash to verify (hex with 0x prefix)"),
      grgShards: z.array(z.string()).describe("Array of hex-encoded cryptographic integrity shards"),
      chainId: z.number().describe("EVM chain ID (e.g. 84532 for Base Sepolia)"),
      poolAddress: z.string().describe("Uniswap V4 pool address (0x-prefixed)"),
    },
    { title: "Verify Proof of Time", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (args: any) => {
      try {
        const result = await potVerify(args);
        return toolSuccess(result);
      } catch (err: unknown) {
        return toolError(err);
      }
    }
  );

  registerTool(
    "pot_generate_v2",
    "Generate the draft-11 180-octet Proof-of-Time Record v2 core. TLS binding proof is computed only after a live TLS session exists.",
    {
      tsTaiUs: z.string().describe("TAI timestamp in microseconds as a decimal string"),
      dispersionUs: z.number().int().nonnegative().describe("Uncertainty bound in microseconds"),
      ctxId: z.string().length(32).describe("16-octet context identifier encoded as hex"),
      holderAuthData: z.string().length(64).describe("32-octet holder public key or PSK digest encoded as hex"),
      holderAuthType: z.number().int().optional().describe("0x01 Ed25519 holder key (default) or 0x02 shared secret"),
    },
    { title: "Generate draft-11 180-octet PoT v2", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args: any) => {
      try { return toolSuccess(await potGenerateV2(args)); } catch (err: unknown) { return toolError(err); }
    }
  );

  registerTool(
    "pot_verify_v2",
    "Verify the draft-11 180-octet PoT Record v2 core. Binding-required mode fails closed in stdio because no TLS exporter session exists.",
    {
      potRecordV2: z.string().length(360).describe("Hex-encoded 180-octet draft-11 v2 record"),
      issuerPubKey: z.string().length(64).optional().describe("Raw 32-octet issuer Ed25519 public key in hex"),
      nowTaiUs: z.string().optional().describe("Current TAI timestamp in microseconds"),
      maxSkewUs: z.string().optional().describe("Configured freshness allowance in microseconds"),
      clientId: z.string().optional(),
      sessionId: z.string().optional(),
      bindingProof: z.string().regex(/^(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{64})$/).optional().describe("64-octet Ed25519 or 32-octet HMAC TLS binding proof"),
    },
    { title: "Verify draft-11 180-octet PoT v2", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args: any) => {
      try { return toolSuccess(await potVerifyV2(args)); } catch (err: unknown) { return toolError(err); }
    }
  );

  registerTool(
    "pot_verify_v08",
    "Verify and, when configured, admit a draft-helmprotocol-tttps-08 §3 Proof-of-Time record: recomputes the Commitment and Ed25519 signature, applies configured freshness, and atomically claims client/session/nonce in Redis before admission.",
    {
      potRecordV08: z.string().describe("Hex-encoded 184 or 216-octet record from pot_generate's potRecordV08 field"),
      ctxId: z.string().max(255).optional().describe("Context identifier the record was generated under. Must match what pot_generate used, or verification fails."),
      issuerPubKey: z.string().optional().describe("Hex-encoded 32-byte raw Ed25519 issuer public key. Defaults to this server's own key."),
      content: z.string().optional().describe("The payload (utf8) to check against the record's Payload Digest field, if available"),
      clientId: z.string().optional().describe("Stable caller identity for the durable replay ledger when TTTPS_REQUIRE_REPLAY_LEDGER=1"),
      sessionId: z.string().optional().describe("Active transport/session identifier for the durable replay ledger when TTTPS_REQUIRE_REPLAY_LEDGER=1"),
    },
    { title: "Verify draft-08 Proof-of-Time Record", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args: any) => {
      try {
        const result = await potVerifyV08(args);
        return toolSuccess(result);
      } catch (err: unknown) {
        return toolError(err);
      }
    }
  );

  registerTool(
    "pot_query",
    "Query Proof of Time records. Use eventId for exact lookup of a specific workflow step. Use startTime/endTime for time-range queries.",
    {
      eventId: z.string().optional().describe("Exact eventId lookup — call this at workflow start to restore action history after context compression"),
      startTime: z.number().optional().describe("Start time (unix ms). Default: 24h ago"),
      endTime: z.number().optional().describe("End time (unix ms). Default: now"),
      limit: z.number().optional().describe("Max entries to return. Default: 100, max: 1000"),
    },
    { title: "Query Proof of Time Records", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (args: any) => {
      try {
        const result = await potQuery(args);
        return toolSuccess(result);
      } catch (err: unknown) {
        return toolError(err);
      }
    }
  );

  registerTool(
    "pot_graph",
    "Traverse the causal chain of workflow steps. Given an eventId, returns the full backward chain (ancestors via prevEventId) and forward chain (steps that follow). Use after context compression to reconstruct the complete workflow timeline.",
    {
      eventId: z.string().describe("The workflow step to start traversal from"),
      depth: z.number().optional().describe("Max backward traversal depth. Default: 10, max: 100"),
    },
    { title: "Traverse PoT Causal Chain", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (args: any) => {
      try {
        const result = await potGraph(args);
        return toolSuccess(result);
      } catch (err: unknown) {
        return toolError(err);
      }
    }
  );

  registerTool(
    "pot_stats",
    "Get PoT statistics: total swaps, turbo/full counts, and turbo ratio for a given period.",
    { period: z.enum(["day", "week", "month"]).describe("Time period for statistics") },
    { title: "PoT Statistics", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (args: any) => {
      try {
        const result = await potStats(args);
        return toolSuccess(result);
      } catch (err: unknown) {
        return toolError(err);
      }
    }
  );

  registerTool(
    "pot_health",
    "Check PoT system health: time source status, subgraph sync, server uptime, and current mode.",
    {},
    { title: "PoT System Health", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async () => {
      try {
        const result = await potHealth();
        return toolSuccess(result);
      } catch (err: unknown) {
        return toolError(err);
      }
    }
  );

  registerTool(
    "pot_checkpoint",
    "Create a compressed rollup checkpoint of workflow history. Call this periodically to prevent token explosion when recovering from context compression. Returns checkpointId, compressed event history, chainIntact status, and nextCheckpointHint (recommended events before next checkpoint).",
    {
      fromEventId: z.string().optional().describe("Start of range by eventId (optional, use with toEventId)"),
      toEventId: z.string().optional().describe("End of range by eventId (optional, use with fromEventId)"),
      startTime: z.number().optional().describe("Unix ms start time (optional, default: 1h ago)"),
      endTime: z.number().optional().describe("Unix ms end time (optional, default: now)"),
      maxTokens: z.number().optional().describe("Approximate max tokens for rollup (default: 2000)"),
    },
    { title: "Create PoT Checkpoint", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args: any) => {
      try {
        const result = await potCheckpoint(args);
        return toolSuccess(result);
      } catch (err: unknown) {
        return toolError(err);
      }
    }
  );

  return s;
}

// ---------- Start Server ----------

async function main() {
  // Restore DAG from Redis before accepting any requests (fire-and-forget on failure)
  await restoreDAGFromRedis();

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : null;

  if (port) {
    // HTTP mode — per-request McpServer + transport (stateless, no reuse)
    const requestHandler = async (req: import("http").IncomingMessage, res: import("http").ServerResponse) => {
      // Health check for Docker/Glama container probes
      if (req.method === "GET" && (req.url === "/health" || req.url === "/ping")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", server: "ttt-mcp", version: "0.4.3" }));
        return;
      }
      // Rate limiting — free tier: 100 calls/day per IP (HTTP mode only);
      // API key (X-TTT-API-Key) is metered server-side by monthly plan quota — not a local unlimited pass
      if (req.method === "POST") {
        const apiKey = resolveApiKey(req.headers["x-api-key"] as string | undefined);
        const clientIp =
          (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ||
          req.socket.remoteAddress ||
          "unknown";
        const rl = checkRateLimit(apiKey, clientIp);
        if (!rl.allowed) {
          res.writeHead(429, {
            "Content-Type": "application/json",
            "Retry-After": "86400",
            "X-RateLimit-Limit": String(parseInt(process.env.FREE_TIER_LIMIT ?? "100", 10)),
            "X-RateLimit-Remaining": "0",
          });
          res.end(
            JSON.stringify({
              error: "rate_limit_exceeded",
              message: FREE_TIER_UPGRADE_MESSAGE,
              upgradeUrl: UPGRADE_URL,
              tier: "free",
            })
          );
          return;
        }
        if (rl.tier === "free") {
          res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
          res.setHeader("X-RateLimit-Tier", "free");
        }
      }
      // SDK requires both application/json and text/event-stream in Accept.
      // Smithery/Glama send only application/json — Hono reads rawHeaders (not headers),
      // so we must patch rawHeaders directly.
      const accept = (req.headers["accept"] as string) ?? "";
      if (!accept.includes("text/event-stream")) {
        const newAccept = accept
          ? `${accept}, text/event-stream`
          : "application/json, text/event-stream";
        req.headers["accept"] = newAccept;
        const raw = req.rawHeaders as string[];
        const idx = raw.findIndex((h, i) => i % 2 === 0 && h.toLowerCase() === "accept");
        if (idx >= 0) {
          raw[idx + 1] = newAccept;
        } else {
          raw.push("Accept", newAccept);
        }
      }
      try {
        // Create fresh server + transport per request (stateless mode requirement)
        const reqServer = buildMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await reqServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    };

    const certFile = process.env.MCP_TLS_CERT_FILE?.trim();
    const keyFile = process.env.MCP_TLS_KEY_FILE?.trim();
    if ((certFile && !keyFile) || (!certFile && keyFile)) {
      throw new Error("MCP_TLS_CERT_FILE and MCP_TLS_KEY_FILE must be configured together");
    }
    const httpServer = certFile && keyFile
      ? createHttpsServer({ minVersion: "TLSv1.3", cert: readFileSync(certFile), key: readFileSync(keyFile) }, (req, res) => {
          const exporter = extractTls13Exporter(req);
          return withTransportBinding({ exporter, remoteAddress: req.socket.remoteAddress ?? "", clientId: String(req.headers["x-ttt-client-id"] ?? ""), sessionId: String(req.headers["x-ttt-session-id"] ?? "") }, () => requestHandler(req, res));
        })
      : createServer((req, res) => withTransportBinding({ remoteAddress: req.socket.remoteAddress ?? "", clientId: String(req.headers["x-ttt-client-id"] ?? ""), sessionId: String(req.headers["x-ttt-session-id"] ?? "") }, () => requestHandler(req, res)));

    httpServer.listen(port, () => {
      console.error(`[ttt-mcp] OpenTTT MCP Server (${certFile ? "HTTPS/TLS1.3" : "HTTP"}) on port ${port}`);
    });
  } else {
    // stdio mode for npx/Claude Desktop usage
    const stdioServer = buildMcpServer();
    const transport = new StdioServerTransport();
    await stdioServer.connect(transport);
    console.error("[ttt-mcp] OpenTTT MCP Server running on stdio");
  }
}

main().catch((err) => {
  console.error("[ttt-mcp] Fatal:", err);
  process.exit(1);
});
