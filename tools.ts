// @helm-protocol/ttt-mcp — Tool implementations for Proof of Time MCP Server
// Uses OpenTTT SDK: TimeSynthesis, IntegrityPipeline, PotSigner, AdaptiveSwitch

import { TimeSynthesis, GrgPipeline, PotSigner, AdaptiveSwitch, AdaptiveMode, Block, TTTRecord } from "openttt";
import { telemetryIncrement } from "./telemetry";
import Redis from "ioredis";

// ---------- Redis (optional persistence) ----------

export const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
redis.on("error", () => {}); // silent — Redis is optional persistence

// ---------- Shared Instances ----------

const timeSynth = new TimeSynthesis();
const adaptiveSwitch = new AdaptiveSwitch();
const potSigner = new PotSigner(); // ephemeral Ed25519 keypair per server session
const startedAt = Date.now();

// In-memory PoT anchor log (bounded ring buffer)
const POT_LOG_MAX = 10000;
const potLog: PotAnchorEntry[] = [];

// O(1) forward and backward causal chain indexes
const potByEventId = new Map<string, PotAnchorEntry>();
const potByPrevEventId = new Map<string, PotAnchorEntry[]>(); // reverse index for O(1) forward chain

// P5: evicted eventId tracker — detects chainBroken state after ring buffer overflow
const evictedEventIds = new Set<string>(); // bounded at 1000 entries
const EVICTED_MAX = 1000;

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

// P2: Depth-based entry compression to prevent token explosion in large chain traversals
// depthThreshold overrides: calculated from maxTokens ÷ estimated entries when provided
function compressEntry(entry: PotAnchorEntry, depth: number, depthThreshold?: { compact: number; minimal: number; rollup: number }): unknown {
  const t = depthThreshold ?? { compact: 5, minimal: 20, rollup: 50 };
  if (depth <= t.compact) return entry; // full
  if (depth <= t.minimal) return {      // compact
    eventId: entry.eventId,
    potHash: entry.potHash,
    timestamp: entry.timestamp,
    prevEventId: entry.prevEventId,
  };
  if (depth <= t.rollup) return {       // minimal
    eventId: entry.eventId,
    timestamp: entry.timestamp,
  };
  // rollup string for deep ancestry — one line per event
  return `${entry.eventId ?? "?"}@${entry.timestamp}`;
}

// P2: Derive compression thresholds from maxTokens.
// Rough char-per-entry estimates: full≈300chars, compact≈120chars, minimal≈60chars, rollup≈30chars
// charBudget = maxTokens × 4 (token≈4chars heuristic)
function depthThresholdFromTokens(maxTokens: number, entryCount: number): { compact: number; minimal: number; rollup: number } {
  const charBudget = maxTokens * 4;
  // Proportional depth allocation: 60% budget for full, next 25% for compact, next 10% for minimal
  const fullBudget = charBudget * 0.60;
  const compactBudget = charBudget * 0.25;
  const minimalBudget = charBudget * 0.10;

  const fullDepth = Math.max(1, Math.floor(fullBudget / 300));
  const compactDepth = fullDepth + Math.max(0, Math.floor(compactBudget / 120));
  const minimalDepth = compactDepth + Math.max(0, Math.floor(minimalBudget / 60));

  // Cap at entryCount to avoid useless expansion
  return {
    compact: Math.min(fullDepth, entryCount),
    minimal: Math.min(compactDepth, entryCount),
    rollup: Math.min(minimalDepth, entryCount),
  };
}

// ---------- DAG Restoration (called by index.ts on startup) ----------

// Restores a persisted entry directly into in-memory structures.
// Used by restoreDAGFromRedis() in index.ts to rebuild DAG after server restart.
export function restoreDagEntry(entry: {
  eventId: string;
  prevEventId?: string | null;
  potHash: string;
  timestamp: string;
  stratum: number;
  mode: string;
  createdAt: number;
  chainId?: number | null;
  poolAddress?: string | null;
}): void {
  if (potByEventId.has(entry.eventId)) return; // already present (duplicate key)

  const e: PotAnchorEntry = {
    potHash: entry.potHash,
    timestamp: entry.timestamp,
    stratum: entry.stratum,
    mode: entry.mode,
    chainId: entry.chainId ?? undefined,
    poolAddress: entry.poolAddress ?? undefined,
    eventId: entry.eventId,
    prevEventId: entry.prevEventId ?? undefined,
    createdAt: entry.createdAt,
  };

  // Respect ring buffer limit during restore
  if (potLog.length >= POT_LOG_MAX) {
    const evicted = potLog.shift()!;
    if (evicted.eventId) {
      potByEventId.delete(evicted.eventId);
      evictedEventIds.add(evicted.eventId);
      if (evictedEventIds.size > EVICTED_MAX) {
        const first = evictedEventIds.values().next().value;
        if (first !== undefined) evictedEventIds.delete(first);
      }
    }
    if (evicted.prevEventId) {
      const siblings = potByPrevEventId.get(evicted.prevEventId);
      if (siblings) {
        const filtered = siblings.filter((s) => s !== evicted);
        if (filtered.length === 0) potByPrevEventId.delete(evicted.prevEventId);
        else potByPrevEventId.set(evicted.prevEventId, filtered);
      }
    }
  }

  potLog.push(e);
  potByEventId.set(entry.eventId, e);
  if (entry.prevEventId) {
    const bucket = potByPrevEventId.get(entry.prevEventId) ?? [];
    bucket.push(e);
    potByPrevEventId.set(entry.prevEventId, bucket);
  }
}

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

  // P3: Offline fallback — stratum 16 = unsynchronized (RFC 5905)
  let pot;
  let isOfflineFallback = false;
  try {
    pot = await timeSynth.generateProofOfTime();
  } catch {
    isOfflineFallback = true;
    const nowMs = BigInt(Date.now());
    pot = {
      timestamp: nowMs * 1_000_000n,
      stratum: 16,
      uncertainty: 999_999_999,
      confidence: 0,
      sources: 0,
      nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"),
      expiresAt: (nowMs + 300_000n) * 1_000_000n,
      sourceReadings: [],
    };
  }

  const potHash = TimeSynthesis.getOnChainHash(pot);

  // Integrity shards only when DeFi params present
  let grgShards: string[] = [];
  let currentMode: AdaptiveMode;

  if (args.txHash && args.chainId != null && args.poolAddress) {
    const txData = new TextEncoder().encode(args.txHash);
    grgShards = GrgPipeline.processForward(txData, args.chainId, args.poolAddress)
      .map((s: Uint8Array) => Buffer.from(s).toString("hex"));

    // P4: AdaptiveSwitch.verifyBlock — called for DeFi path where block context is available
    // Construct synthetic Block and TTTRecord from available DeFi parameters.
    // txHash is used as a single-element txOrder; block timestamp derived from PoT.
    const syntheticBlock: Block = {
      timestamp: Number(pot.timestamp / 1_000_000n), // ns → ms
      txs: [args.txHash],
      data: new TextEncoder().encode(args.txHash),
    };
    const syntheticTTTRecord: TTTRecord = {
      time: Number(pot.timestamp / 1_000_000n),
      txOrder: [args.txHash],
      grgPayload: [],
    };
    currentMode = adaptiveSwitch.verifyBlock(syntheticBlock, syntheticTTTRecord, args.chainId, args.poolAddress);
  } else {
    // Claude Code workflow path: no block data available; use current mode as-is
    currentMode = adaptiveSwitch.getCurrentMode();
  }

  const signature = potSigner.signPot(potHash);

  const entry: PotAnchorEntry = {
    potHash,
    timestamp: pot.timestamp.toString(),
    stratum: pot.stratum,
    mode: currentMode,
    chainId: args.chainId,
    poolAddress: args.poolAddress,
    eventId: args.eventId,
    prevEventId: args.prevEventId,
    createdAt: Date.now(),
  };

  // Ring buffer eviction — keep indexes consistent + track evicted eventIds for P5
  if (potLog.length >= POT_LOG_MAX) {
    const evicted = potLog.shift()!;
    if (evicted.eventId) {
      potByEventId.delete(evicted.eventId);
      // P5: Track evicted eventIds to detect chain breaks
      evictedEventIds.add(evicted.eventId);
      if (evictedEventIds.size > EVICTED_MAX) {
        const first = evictedEventIds.values().next().value;
        if (first !== undefined) evictedEventIds.delete(first);
      }
    }
    if (evicted.prevEventId) {
      const siblings = potByPrevEventId.get(evicted.prevEventId);
      if (siblings) {
        const filtered = siblings.filter((e) => e !== evicted);
        if (filtered.length === 0) potByPrevEventId.delete(evicted.prevEventId);
        else potByPrevEventId.set(evicted.prevEventId, filtered);
      }
    }
  }
  potLog.push(entry);
  if (args.eventId) potByEventId.set(args.eventId, entry);
  if (args.prevEventId) {
    const bucket = potByPrevEventId.get(args.prevEventId) ?? [];
    bucket.push(entry);
    potByPrevEventId.set(args.prevEventId, bucket);
  }

  // Redis persistence — fire-and-forget; in-memory remains authoritative on failure
  if (args.eventId) {
    redis.setex(
      `dag:${args.eventId}`,
      90 * 86400,
      JSON.stringify({
        eventId: args.eventId,
        prevEventId: args.prevEventId ?? null,
        potHash,
        timestamp: pot.timestamp.toString(),
        stratum: pot.stratum,
        mode: currentMode,
        createdAt: entry.createdAt,
        chainId: args.chainId ?? null,
        poolAddress: args.poolAddress ?? null,
      })
    ).catch(() => {});
  }

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
    ...(isOfflineFallback && { mode: "local" }),
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

  // Forward chain — O(1) via reverse index (vs O(n) linear scan)
  const forwardChain = potByPrevEventId.get(args.eventId) ?? [];

  const found = potByEventId.has(args.eventId);

  // P5: chainBroken detection — true if any ancestor was evicted from the ring buffer
  // or if the chain root's prevEventId points to an unknown entry (gap)
  const chainBroken =
    backwardChain.some((e) => e.eventId && evictedEventIds.has(e.eventId)) ||
    (cursor?.prevEventId != null && potByEventId.get(cursor.prevEventId) == null);

  // Distinguish server_restart gap from ring-buffer eviction:
  // If the oldest reachable entry has a prevEventId that is unknown AND was never tracked
  // in evictedEventIds, this gap was caused by a server restart (in-memory cleared).
  const chainRoot = backwardChain.length > 0 ? backwardChain[0] : null;
  const isServerRestart =
    chainBroken &&
    chainRoot !== null &&
    chainRoot.prevEventId != null &&
    !potByEventId.has(chainRoot.prevEventId) &&
    !evictedEventIds.has(chainRoot.prevEventId);

  const brokenAt = chainBroken
    ? isServerRestart
      ? "server_restart"
      : (backwardChain[0]?.eventId ?? null)
    : null;

  // P2: Compress entries by depth to limit response token size
  const compressedBackward = backwardChain.map((e, i) => compressEntry(e, i + 1));

  return serialize({
    eventId: args.eventId,
    found,
    backwardChain: compressedBackward,
    forwardChain,
    chainLength: backwardChain.length + forwardChain.length,
    reachableDepth: backwardChain.length,
    chainBroken,
    brokenAt,
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

// ---------- Tool: pot_checkpoint ----------

export async function potCheckpoint(args: {
  fromEventId?: string;
  toEventId?: string;
  startTime?: number;
  endTime?: number;
  maxTokens?: number;
}): Promise<unknown> {
  telemetryIncrement("pot_checkpoint");

  const now = Date.now();
  const startTime = args.startTime ?? now - 3_600_000;
  const endTime = args.endTime ?? now;

  // Determine the entries for this checkpoint
  let entries: PotAnchorEntry[];

  if (args.fromEventId && args.toEventId) {
    // Forward chain traversal: fromEventId → toEventId (max 1000 hops)
    entries = [];
    let cursor = potByEventId.get(args.fromEventId);
    const maxDepth = 1000;
    let d = 0;
    while (cursor && d < maxDepth) {
      entries.push(cursor);
      if (cursor.eventId === args.toEventId) break;
      const nexts = potByPrevEventId.get(cursor.eventId ?? "") ?? [];
      cursor = nexts[0];
      d++;
    }
  } else {
    // Time-range based
    entries = potLog.filter((e) => e.createdAt >= startTime && e.createdAt <= endTime);
  }

  const eventCount = entries.length;

  // P2: Compress entries with depth-aware rollup.
  // When maxTokens is provided, derive compression thresholds from charCount÷4 budget.
  const depthThreshold = args.maxTokens
    ? depthThresholdFromTokens(args.maxTokens, entries.length)
    : undefined;
  const compressed = entries.map((e, i) => compressEntry(e, i + 1, depthThreshold));

  // chainIntact: none of the selected entries were evicted from the ring buffer
  const chainIntact = !entries.some((e) => e.eventId && evictedEventIds.has(e.eventId));

  // nextCheckpointHint: recommend calling checkpoint every 100 events
  // Returns how many more events can be generated before next recommended checkpoint
  const nextCheckpointHint = Math.max(10, 100 - (eventCount % 100));

  const checkpointId = `ckpt_${now}_${eventCount}`;

  const firstTs = entries[0]?.timestamp ?? null;
  const lastTs = entries[entries.length - 1]?.timestamp ?? null;

  return serialize({
    checkpointId,
    eventCount,
    chainIntact,
    nextCheckpointHint,
    rollup: compressed,
    summary: `${eventCount} events from ${firstTs ?? "?"} to ${lastTs ?? "?"}`,
    generatedAt: now,
  });
}
