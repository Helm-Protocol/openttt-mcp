#!/usr/bin/env node
// @helm-protocol/ttt-mcp — MCP Server for OpenTTT Proof of Time
// Provides 5 tools for AI agents: pot_generate, pot_verify, pot_query, pot_stats, pot_health

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "http";
import { z } from "zod";
import { potGenerate, potVerify, potQuery, potGraph, potStats, potHealth } from "./tools";
import { checkRateLimit, resolveApiKey, FREE_TIER_LIMIT } from "./auth";

// ---------- Helper: build a fresh McpServer per HTTP request ----------
// In stateless mode, StreamableHTTPServerTransport cannot be reused across
// requests (throws "Stateless transport cannot be reused...").
// We therefore create a new McpServer + transport per POST request.

function buildMcpServer(): McpServer {
  const s = new McpServer({ name: "ttt-mcp", version: "0.1.0" });

  s.tool(
    "pot_generate",
    "Generate a cryptographic Proof of Time timestamp. For Claude Code workflows: use eventId + prevEventId to build a causal chain. For DeFi: use txHash + chainId + poolAddress. Either eventId or txHash is required.",
    {
      eventId: z.string().optional().describe("Workflow step identifier (Claude Code). E.g. 'refactor_auth_step1'"),
      prevEventId: z.string().optional().describe("Previous step's eventId — links steps into a causal chain"),
      txHash: z.string().optional().describe("Transaction hash (DeFi, hex with 0x prefix)"),
      chainId: z.number().optional().describe("EVM chain ID (DeFi, e.g. 8453 for Base)"),
      poolAddress: z.string().optional().describe("DEX pool contract address (DeFi)"),
    },
    async (args) => {
      try {
        const result = await potGenerate(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  s.tool(
    "pot_verify",
    "Verify a Proof of Time using its hash and integrity shards. Returns validity, mode (turbo/full), and timestamp.",
    {
      potHash: z.string().describe("PoT hash to verify (hex with 0x prefix)"),
      grgShards: z.array(z.string()).describe("Array of hex-encoded cryptographic integrity shards"),
      chainId: z.number().describe("EVM chain ID (e.g. 84532 for Base Sepolia)"),
      poolAddress: z.string().describe("Uniswap V4 pool address (0x-prefixed)"),
    },
    async (args) => {
      try {
        const result = await potVerify(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  s.tool(
    "pot_query",
    "Query Proof of Time records. Use eventId for exact O(1) lookup of a specific workflow step (collision probability 2^-256). Use startTime/endTime for time-range queries.",
    {
      eventId: z.string().optional().describe("Exact eventId lookup — call this at workflow start to restore action history after context compression"),
      startTime: z.number().optional().describe("Start time (unix ms). Default: 24h ago"),
      endTime: z.number().optional().describe("End time (unix ms). Default: now"),
      limit: z.number().optional().describe("Max entries to return. Default: 100, max: 1000"),
    },
    async (args) => {
      try {
        const result = await potQuery(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  s.tool(
    "pot_graph",
    "Traverse the causal chain of workflow steps. Given an eventId, returns the full backward chain (ancestors via prevEventId) and forward chain (steps that follow). Use after context compression to reconstruct the complete workflow timeline.",
    {
      eventId: z.string().describe("The workflow step to start traversal from"),
      depth: z.number().optional().describe("Max backward traversal depth. Default: 10, max: 100"),
    },
    async (args) => {
      try {
        const result = await potGraph(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  s.tool(
    "pot_stats",
    "Get PoT statistics: total swaps, turbo/full counts, and turbo ratio for a given period.",
    { period: z.enum(["day", "week", "month"]).describe("Time period for statistics") },
    async (args) => {
      try {
        const result = await potStats(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  s.tool(
    "pot_health",
    "Check PoT system health: time source status, subgraph sync, server uptime, and current mode.",
    {},
    async () => {
      try {
        const result = await potHealth();
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  return s;
}

// ---------- Start Server ----------

async function main() {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : null;

  if (port) {
    // HTTP mode — per-request McpServer + transport (stateless, no reuse)
    const httpServer = createServer(async (req, res) => {
      // Health check for Docker/Glama container probes
      if (req.method === "GET" && (req.url === "/health" || req.url === "/ping")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", server: "ttt-mcp", version: "0.2.0" }));
        return;
      }
      // Rate limiting — free tier: 100 calls/day per IP, API key = unlimited
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
              message: "Free tier: 100 calls/day reached. Contact heime.jorgen@proton.me for commercial access.",
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
    });

    httpServer.listen(port, () => {
      console.error(`[ttt-mcp] OpenTTT MCP Server (HTTP) on port ${port}`);
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
