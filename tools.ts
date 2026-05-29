// @helm-protocol/ttt-mcp — Tool implementations for Proof of Time MCP Server
// Uses OpenTTT SDK: TimeSynthesis, IntegrityPipeline, PotSigner, AdaptiveSwitch

import { TimeSynthesis, GrgPipeline, PotSigner, AdaptiveSwitch, AdaptiveMode } from "openttt";
import { telemetryIncrement } from "./telemetry";

// ---------- Shared Instances ----------

const timeSynth = new TimeSynthesis();
const adaptiveSwitch = new AdaptiveSwitch();
const potSigner = new PotSigner(); // ephemeral Ed25519 keypair per server session
const startedAt = Date.now();

// In-memory PoT anchor log (bounded ring buffer)
const POT_LOG_MAX = 10000;
const potLog: PotAnchorEntry[] = [];

// O(1) eventId index for causal chain traversal
const potByEventId = new Map<string, PotAnchorEntry>();

interface PotAnchorEntry {
  potHash: string;
  timestamp: string;
  stratum: number;
  mode: string;
  chainId?: number;
  poolAddress?: string;
  eventId?: string;
  prevEventId?: string;
  createdAt: number;
}

// ---------- Helpers ----------

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function serialize(obj: unknown): unknown {
  return JSON.parse(JSON.stringify(obj, bigintReplacer));
}

const SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/1744392/openttt-base-sepolia/v0.1.0";

// ---------- Tool: pot_generate ----------

export async function potGenerate(args: {
  eventId?: string;
  prevEventId?: string;
  txHash?: string;
  chainId?: number;
  poolAddress?: string;
}): Promise<unknown> {
  if (!args.eventId && !args.txHash) {
    throw new Error("Either eventId (Claude Code) or txHash (DeFi) is required");
  }
  telemetryIncrement("pot_generate");

  const pot = await timeSynth.generateProofOfTime();
  const potHash = TimeSynthesis.getOnChainHash(pot);

  // Integrity shards only when DeFi params present
  let grgShards: string[] = [];
  if (args.txHash && args.chainId != null && args.poolAddress) {
    const txData = new TextEncoder().encode(args.txHash);
    grgShards = GrgPipeline.processForward(txData, args.chainId, args.poolAddress)
      .map((s: Uint8Array) => Buffer.from(s).toString("hex"));
  }

  const signature = potSigner.signPot(potHash);

  const entry: PotAnchorEntry = {
    potHash,
    timestamp: pot.timestamp.toString(),
    stratum: pot.stratum,
    mode: adaptiveSwitch.getCurrentMode(),
    chainId: args.chainId,
    poolAddress: args.poolAddress,
    eventId: args.eventId,
    prevEventId: args.prevEventId,
    createdAt: Date.now(),
  };
  potLog.push(entry);
  if (potLog.length > POT_LOG_MAX) potLog.shift();
  if (args.eventId) potByEventId.set(args.eventId, entry);

  return serialize({
    potHash,
    eventId: args.eventId ?? null,
    prevEventId: args.prevEventId ?? null,
    timestamp: pot.timestamp.toString(),
    stratum: pot.stratum,
    uncertainty: pot.uncertainty,
    confidence: pot.confidence,
    sources: pot.sources,
    nonce: pot.nonce,
    expiresAt: pot.expiresAt.toString(),
    ...(grgShards.length > 0 && { grgShards }),
    signature: {
      issuerPubKey: signature.issuerPubKey,
      signature: signature.signature,
      issuedAt: signature.issuedAt.toString(),
    },
  });
}

// ---------- Tool: pot_verify ----------

export async function potVerify(args: {
  potHash: string;
  grgShards: string[];
  chainId: number;
  poolAddress: string;
}): Promise<unknown> {
  telemetryIncrement("pot_verify");

  const shards = args.grgShards.map((hex) => new Uint8Array(Buffer.from(hex, "hex")));
  let valid = false;
  let reconstructedSize = 0;

  try {
    const recovered = GrgPipeline.processInverse(shards, 0, args.chainId, args.poolAddress);
    valid = recovered.length > 0;
    reconstructedSize = recovered.length;
  } catch {
    valid = false;
  }

  const mode = adaptiveSwitch.getCurrentMode() === AdaptiveMode.TURBO ? "turbo" : "full";

  return serialize({
    valid,
    mode,
    potHash: args.potHash,
    reconstructedBytes: reconstructedSize,
    verifiedAt: Date.now(),
  });
}

// ---------- Tool: pot_query ----------

export async function potQuery(args: {
  eventId?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
}): Promise<unknown> {
  telemetryIncrement("pot_query");

  // Direct eventId lookup — O(1), exact identity match (SHA-3 collision prob = 2^-256)
  if (args.eventId) {
    const entry = potByEventId.get(args.eventId);
    return serialize({
      local: entry ? [entry] : [],
      subgraph: [],
      found: !!entry,
      totalLocal: potLog.length,
      query: { eventId: args.eventId },
    });
  }

  const limit = Math.min(args.limit ?? 100, 1000);
  const now = Date.now();
  const startTime = args.startTime ?? now - 86400_000;
  const endTime = args.endTime ?? now;

  // Filter from in-memory log
  const filtered = potLog
    .filter((e) => e.createdAt >= startTime && e.createdAt <= endTime)
    .slice(-limit);

  // Best-effort subgraph query
  let subgraphEntries: unknown[] = [];
  try {
    const query = `{
      potAnchors(
        first: ${limit},
        orderBy: blockTimestamp,
        orderDirection: desc,
        where: { blockTimestamp_gte: "${Math.floor(startTime / 1000)}", blockTimestamp_lte: "${Math.floor(endTime / 1000)}" }
      ) {
        id
        potHash
        blockTimestamp
        txHash
      }
    }`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(SUBGRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (resp.ok) {
      const json = (await resp.json()) as { data?: { potAnchors?: unknown[] } };
      subgraphEntries = json.data?.potAnchors ?? [];
    }
  } catch {
    // Subgraph unavailable — local log still returned
  }

  return serialize({
    local: filtered,
    subgraph: subgraphEntries,
    totalLocal: potLog.length,
    query: { startTime, endTime, limit },
  });
}

// ---------- Tool: pot_graph ----------

export async function potGraph(args: {
  eventId: string;
  depth?: number;
}): Promise<unknown> {
  telemetryIncrement("pot_graph");

  const maxDepth = Math.min(args.depth ?? 10, 100);

  // Traverse backward chain (prevEventId links) — O(depth)
  const backwardChain: PotAnchorEntry[] = [];
  let cursor = potByEventId.get(args.eventId);
  let d = 0;
  while (cursor && d < maxDepth) {
    backwardChain.unshift(cursor); // prepend for chronological order
    cursor = cursor.prevEventId ? potByEventId.get(cursor.prevEventId) : undefined;
    d++;
  }

  // Forward chain — entries that cite this eventId as their prevEventId
  const forwardChain = potLog.filter((e) => e.prevEventId === args.eventId);

  const found = potByEventId.has(args.eventId);
  return serialize({
    eventId: args.eventId,
    found,
    backwardChain,
    forwardChain,
    chainLength: backwardChain.length + forwardChain.length,
    reachableDepth: backwardChain.length,
  });
}

// ---------- Tool: pot_stats ----------

export async function potStats(args: {
  period: "day" | "week" | "month";
}): Promise<unknown> {
  telemetryIncrement("pot_stats");

  const now = Date.now();
  const periodMs: Record<string, number> = {
    day: 86400_000,
    week: 604800_000,
    month: 2592000_000,
  };
  const cutoff = now - (periodMs[args.period] ?? periodMs.day);

  const entries = potLog.filter((e) => e.createdAt >= cutoff);
  const turboCount = entries.filter((e) => e.mode === AdaptiveMode.TURBO).length;
  const fullCount = entries.filter((e) => e.mode === AdaptiveMode.FULL).length;
  const totalSwaps = entries.length;

  return serialize({
    period: args.period,
    totalSwaps,
    turboCount,
    fullCount,
    turboRatio: totalSwaps > 0 ? +(turboCount / totalSwaps).toFixed(4) : 0,
    currentMode: adaptiveSwitch.getCurrentMode(),
    windowStart: new Date(cutoff).toISOString(),
    windowEnd: new Date(now).toISOString(),
  });
}

// ---------- Tool: pot_health ----------

export async function potHealth(): Promise<unknown> {
  telemetryIncrement("pot_health");

  let timeStatus = "unknown";
  let synthSources = 0;
  try {
    const synth = await Promise.race([
      timeSynth.synthesize(),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 5000)
      ),
    ]);
    if (synth && synth.sources >= 2) {
      timeStatus = "healthy";
      synthSources = synth.sources;
    } else {
      timeStatus = "degraded";
      synthSources = synth?.sources ?? 0;
    }
  } catch {
    timeStatus = "unhealthy";
  }

  let latestBlock = 0;
  let syncStatus = "unknown";
  try {
    const query = `{ _meta { block { number } hasIndexingErrors } }`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(SUBGRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (resp.ok) {
      const json = (await resp.json()) as {
        data?: { _meta?: { block?: { number: number }; hasIndexingErrors?: boolean } };
      };
      latestBlock = json.data?._meta?.block?.number ?? 0;
      syncStatus = json.data?._meta?.hasIndexingErrors ? "indexing_errors" : "synced";
    }
  } catch {
    syncStatus = "unreachable";
  }

  const uptimeMs = Date.now() - startedAt;

  return serialize({
    status: timeStatus === "healthy" ? "ok" : timeStatus,
    timeSources: { status: timeStatus, activeSources: synthSources },
    subgraph: { latestBlock, syncStatus },
    server: {
      uptime: uptimeMs,
      uptimeHuman: `${(uptimeMs / 3600000).toFixed(1)}h`,
      potCount: potLog.length,
      currentMode: adaptiveSwitch.getCurrentMode(),
      signerPubKey: potSigner.getPubKeyHex(),
    },
  });
}
