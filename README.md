# @helm-protocol/ttt-mcp

> Reference implementation of [draft-helmprotocol-tttps-00](https://datatracker.ietf.org/doc/draft-helmprotocol-tttps/) (IETF Experimental)

**MCP Server for OpenTTT — Proof of Time tools for AI agents**

---

## The Problem: Workflow Amnesia

Every Claude Code long-horizon workflow hits the same wall: **context compression erases action history.**

Agent B has no memory of what Agent A decided. Agent A resumes after compression with no record of its own prior steps. Duplicate work. Lost decisions. State corruption.

**ttt-mcp is the external causal chain that survives context compression.**

Every workflow step is anchored to a cryptographic timestamp on an **external server** — physically separate from Claude's context window. When compression happens, agents call `pot_query(eventId)` for O(1) exact step recall and resume with full causal context.

```
Claude workflow → [context compressed] → agents call pot_query(eventId)
                                         → external server returns full timeline
                                         → workflow resumes, zero lost state
```

---

## Mathematical Guarantees

| Layer | Mechanism | Guarantee |
|-------|-----------|-----------|
| **Identity** | SHA-3 eventId (256-bit) | Collision probability 2⁻²⁵⁶ — practically zero |
| **Lookup** | O(1) exact retrieval | No context consumed by history reconstruction |
| **Ordering** | TTTPS causal timestamps | Total order on events — tamper-proof sequence proof |
| **Causal chain** | prevEventId DAG | O(depth) traversal — depth ~100 for 1B-token workflows |
| **Non-repudiation** | Ed25519 signature | Cryptographic proof of who acted when |
| **Resilience** | Erasure-coded cryptographic shards | ≥97% recovery at BER=0.05, 99.88% at BER=0.02 (theoretical) |
| **Persistence** | Redis AOF + 90-day TTL | Server survives context compression and restarts |

---

## Quick Start

### Claude Code

```bash
claude mcp add ttt -- npx -y @helm-protocol/ttt-mcp@0.3.0
```

With an API key (raises the free limit to your plan's monthly quota):
```bash
claude mcp add ttt -e TTT_API_KEY=your-key -- npx -y @helm-protocol/ttt-mcp@0.3.0
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ttt": {
      "command": "npx",
      "args": ["-y", "@helm-protocol/ttt-mcp@0.3.0"],
      "env": { "TTT_API_KEY": "your-key" }
    }
  }
}
```

### Cursor

[![Add to Cursor](https://img.shields.io/badge/Add%20to%20Cursor-1a1a1a?style=flat&logo=cursor&logoColor=white)](https://cursor.com/install-mcp?name=ttt&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBoZWxtLXByb3RvY29sL3R0dC1tY3BAMC4zLjAiXX0=)

One-click install, or add the same `mcpServers` block above to `.cursor/mcp.json`.

Free tier: 100 calls/day per IP — no signup needed.

---

## 5-Minute Test

Once connected, run this sequence in Claude:

**Step 1 — Stamp a workflow step:**

Just tell Claude naturally:
> "Stamp this step as my-first-step"
> "Record what I just did as refactor-auth-step1"

Claude calls `pot_generate` automatically. Or call it directly:
```
pot_generate(eventId: "my-first-step")
```

**Step 2 — Simulate context compression:** start a new Claude session

**Step 3 — Recover in the new session:**

Tell Claude:
> "What did I do in my-first-step?"
> "Recover my last workflow state"

Or call directly:
```
pot_query(eventId: "my-first-step")
```
→ Returns exact record. Amnesia gone.

**Step 4 — Build a causal chain:**
```
pot_generate(eventId: "step-2", prevEventId: "my-first-step")
pot_graph(eventId: "step-2", depth: 5)
```
→ Full backward chain. Cryptographically ordered.

---

## 7 Tools

| Tool | Purpose |
|------|---------|
| `pot_generate` | Stamp a workflow step with a cryptographic timestamp |
| `pot_verify` | Verify a PoT signature |
| `pot_query` | O(1) exact lookup by eventId — core amnesia recovery |
| `pot_graph` | Traverse causal DAG (backward + forward chain) |
| `pot_checkpoint` | Roll up events into a compressed summary — use every ~100 events or before long tasks |
| `pot_stats` | Server statistics and mode status |
| `pot_health` | Health check |

---

## Tool Parameters

### pot_generate

Stamp a workflow step with a cryptographic timestamp. For Claude Code: use `eventId` + `prevEventId`. For DeFi: use `txHash` + `chainId` + `poolAddress`. One of `eventId` or `txHash` is required.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| eventId | string | Either/or | Workflow step identifier. E.g. `"refactor_auth_step1"` |
| prevEventId | string | No | Previous step's eventId — links steps into a causal chain |
| txHash | string | Either/or | Transaction hash (DeFi, hex with 0x prefix) |
| chainId | number | No | EVM chain ID (DeFi) |
| poolAddress | string | No | DEX pool contract address (DeFi) |

### pot_query

Query Proof of Time records. Use `eventId` for O(1) exact lookup after context compression.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| eventId | string | No | Exact step lookup — collision probability 2⁻²⁵⁶ |
| startTime | number | No | Start time (unix ms). Default: 24h ago |
| endTime | number | No | End time (unix ms). Default: now |
| limit | number | No | Max entries to return. Default: 100, max: 1000 |

### pot_graph

Traverse the causal chain from any step. Returns backward chain (ancestors) and forward chain (descendants).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| eventId | string | Yes | Step to traverse from |
| depth | number | No | Max backward depth. Default: 10, max: 100 |

**Returns:**
- `backwardChain` — ancestors in chronological order (depth-compressed for large chains)
- `forwardChain` — steps that follow the given eventId
- `chainBroken` — `true` if a gap is detected (ancestor was evicted from ring buffer, or the chain root references an unknown entry)
- `brokenAt` — `"server_restart"` if the gap was caused by a server restart clearing in-memory state; otherwise the eventId at which the break occurred; `null` if chain is intact
- `reachableDepth` — number of ancestors successfully traversed before the gap (or chain root)

**Causal chain gap causes:**
- **`server_restart`**: the server restarted and the in-memory DAG was cleared. If Redis is available and `REDIS_URL` is set, the DAG is rebuilt from Redis on startup — reducing restart gaps.
- **Ring-buffer eviction**: the ring buffer holds the most recent 10,000 events in memory. Ancestors beyond that window show as `chainBroken: true` with `brokenAt` set to the oldest reachable eventId.

**Recovering from a gap**: call `pot_checkpoint` before long tasks to compress and preserve the chain within the token budget, or use Redis persistence to survive restarts.

### pot_verify

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| potHash | string | Yes | PoT hash to verify (hex with 0x prefix) |
| grgShards | string[] | Yes | Array of hex-encoded cryptographic integrity shards |
| chainId | number | Yes | EVM chain ID |
| poolAddress | string | Yes | Uniswap V4 pool address |

### pot_stats

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| period | `"day"` \| `"week"` \| `"month"` | Yes | Time period for statistics |

### pot_health

No parameters.

### pot_checkpoint

Creates a compressed rollup checkpoint of workflow history.

**Use when:** Approaching context limit, before long tasks, or every ~100 events.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| fromEventId | string | No | Start of range — first eventId in the causal chain to include |
| toEventId | string | No | End of range — last eventId in the causal chain to include |
| startTime | number | No | Unix ms. Default: 1 hour ago |
| endTime | number | No | Unix ms. Default: now |
| maxTokens | number | No | Approximate max tokens for rollup output. Default: 2000 |

**Returns:**
- `checkpointId` — unique checkpoint identifier
- `rollup` — compressed event history (depth-adaptive: full/compact/minimal/rollup)
- `summary` — human-readable one-line summary of the checkpoint
- `chainIntact` — whether the causal chain is unbroken
- `nextCheckpointHint` — recommended events before next checkpoint

**Depth-adaptive compression:**

| Depth | Format | ~Tokens |
|-------|--------|---------|
| 1–5 | Full entry | ~200/event |
| 6–20 | Compact (id+hash+ts) | ~80/event |
| 21–50 | Minimal (id+ts) | ~30/event |
| 51+ | Rollup string | ~10/event |

---

## Use Cases

### 1. Claude Code Workflow — Amnesia Prevention

**Problem**: A 20-agent Dynamic Workflow refactors a 500K-line codebase over hours. After each context compression, agents have no memory of what they already processed. Duplicate work. State corruption.

**Solution**: Each agent stamps its steps with `pot_generate(eventId, prevEventId)`. After compression, it calls `pot_query(eventId)` to recover its exact action history — what ran, when, in what order — from the external server. The server is outside Claude's context window; compression never touches it.

```typescript
// Agent starts a workflow step
const pot = await client.callTool({
  name: "pot_generate",
  arguments: {
    eventId: "refactor_auth_module_step3",
    prevEventId: "refactor_auth_module_step2"
  }
});
// pot.potHash — cryptographic proof this step happened at this time

// After context compression, agent recovers its history:
const history = await client.callTool({
  name: "pot_query",
  arguments: { eventId: "refactor_auth_module_step3" }
});
// history.local[0] — exact record: timestamp, prevEventId, potHash
// history.found: true — O(1) lookup, collision probability 2⁻²⁵⁶

// Traverse full causal chain:
const chain = await client.callTool({
  name: "pot_graph",
  arguments: { eventId: "refactor_auth_module_step3", depth: 20 }
});
// chain.backwardChain — all ancestor steps in chronological order
// chain.forwardChain — steps that follow this one
// chain.chainBroken — true if a gap was detected in the ancestor chain
// chain.brokenAt    — "server_restart" if the server restarted and cleared
//                     the in-memory DAG; otherwise the eventId of the oldest
//                     reachable ancestor before the gap; null if chain intact
// chain.reachableDepth — how many ancestors were recovered before the gap

// Handle a server-restart gap:
if (chain.chainBroken && chain.brokenAt === "server_restart") {
  // Server cleared in-memory state; ancestors before the gap are gone unless
  // Redis was configured (REDIS_URL) — in that case the DAG was rebuilt on
  // restart and chainBroken will be false.
  // Recover by querying the most recent checkpoint or restarting from a known step.
}
```

**Before a long task or every ~100 events — create a checkpoint:**

```typescript
// Compress workflow history before context fills up — by causal range:
const checkpoint = await client.callTool({
  name: "pot_checkpoint",
  arguments: {
    fromEventId: "refactor_auth_module_step1",
    toEventId: "refactor_auth_module_step3"
  }
});
// checkpoint.checkpointId — store this; resume from it after compression
// checkpoint.rollup — depth-adaptive compressed history (10–200 tokens/event)
// checkpoint.chainIntact: true — causal chain verified unbroken
// checkpoint.nextCheckpointHint: 87 — suggested events before next checkpoint

// Or compress by time window with a token budget:
const checkpoint = await client.callTool({
  name: "pot_checkpoint",
  arguments: {
    startTime: Date.now() - 3_600_000,  // last 1 hour
    maxTokens: 1500
  }
});

// After context compression, restore from checkpoint instead of re-querying all events:
const history = await client.callTool({
  name: "pot_query",
  arguments: { eventId: checkpoint.checkpointId }
});
// Full causal context restored in a single call
```

**Outcome**: Zero duplicate work. Full workflow timeline recoverable even after complete context resets.

---

### 2. MEV Bot — Transaction Ordering Proof

**Problem**: You got front-run. You can't prove it — mempool timestamps are per-node, unsigned, non-authoritative.

**Solution**: Call `pot_generate` before every submission. The PoT receipt is cryptographically signed using three independent time sources (NIST, Google, Cloudflare). The on-chain hash can be anchored via a separate Base Sepolia TTT ERC-1155 contract. If front-running occurs, you have a timestamped record predating the attacker's block inclusion.

```typescript
const pot = await client.callTool({
  name: "pot_generate",
  arguments: { txHash: pendingTxHash, chainId: 8453, poolAddress: "0x..." }
});
// pot.potHash — your evidence, timestamped by NIST+Google+Cloudflare
```

> **Note:** The DeFi path (`txHash` + `chainId` + `poolAddress`) requires a server-side build with the integrity-shard pipeline enabled. It is not available in the public `openttt` npm package; calls without it will throw. The Claude Code path (`eventId`) works out of the box.

---

### 3. DEX Protocol — Sandwich Deterrence

**Solution**: Integrate `TTTHookSimple` (Uniswap V4 hook, Base Sepolia: `0x8C633b05b833a476925F7d9818da6E215760F2c7`). Honest builders get `turbo` mode. Tampered sequences get `full` mode (penalty delay). Economics, not governance.

> **Note:** Shard-based verification (`pot_verify` with `grgShards`) requires a server-side build with the integrity-shard pipeline enabled — not available in the public `openttt` npm package.

---

### 4. Hedge Fund / Prop Desk — MiFIR Art.22c Compliance

**Problem**: MiFIR Article 22c / RTS 25 requires microsecond-precision UTC-synchronized timestamps. Hardware PTP appliances cost $50K–$500K.

**Solution**: `pot_generate` produces an Ed25519-signed timestamp with an uncertainty bound and multi-source attestation. Structurally compatible with the RTS 25 audit record format. One API call per trade.

```typescript
const audit = await client.callTool({
  name: "pot_generate",
  arguments: { txHash: tradeHash, chainId: 8453 }
});
// audit.timestamp: high-resolution timestamp
// audit.uncertainty: ± bound (RTS 25 uncertainty field)
// audit.confidence: fraction of sources that agreed
```

> **Precision note:** The default network time sources (Roughtime / NTP) provide a few-millisecond uncertainty bound. The MiFIR Art. 22c / RTS 25 ±1ms (and tighter) requirement is met only with an added GEO time source (KTSat); this is a roadmap configuration, not the default deployment.

**Outcome**: Structurally compatible audit trail. IETF specification: `draft-helmprotocol-tttps-00`.

---

### 5. Multi-Agent Coordination — Causal Order Proof

**Problem**: When multiple AI agents interact in a pipeline, the causal order matters for debugging and audit. Agent logs are unverifiable.

**Solution**: Each agent stamps its action with `pot_generate`. The potHash chain is independently verifiable. `pot_graph` reconstructs who did what and in what order.

---

## How It Differs — A Different Job, Not "Better"

| Tool | Integration | What it recalls | Integrity | Hot-path cost |
|------|-------------|-----------------|-----------|---------------|
| Letta (MemGPT) | owns the agent loop | self-editing semantic memory | none | embedding + vector search per memory op |
| LangGraph / LangMem | LangGraph only | graph state / semantic | none | checkpoint I/O (+ embeddings) |
| RAG / vector DB | bolt-on | fuzzy similarity | none | embed + vector search per item |
| **ttt-mcp** | **2-min MCP retrofit** | **exact causal step (by eventId)** | **Ed25519 + TTTPS timestamp** | **sign + hash + write — 0 embedding calls** |

**The cost difference is structural, not incidental.**

Letta and Mem0 treat agent memory as a semantic search problem — every recall forces an LLM embedding call and a vector search. ttt-mcp bypasses the LLM/embedding layer entirely: state recovery is an O(1) cryptographic hash lookup. Marginal cost is commodity CPU + storage, not API tokens.

**Scope**: agents stamp the steps worth checkpointing — not every token, not every query. Volume tracks decisions, not total chat traffic.

If you need fuzzy semantic search over past conversations, use Letta or a vector DB. If you need a zero-embedding, deterministic state recovery layer for long-horizon workflows that survives context compaction, use ttt-mcp.

---

## Pricing

| Tier | Price | Calls/month |
|------|-------|-------------|
| Free | $0 | 100/day per IP — no signup |
| Dev | $29/mo | 100K |
| Pro | $99/mo | 1M |
| Team | $299/mo | 10M + $0.01/1K overage |
| Enterprise | $999+/mo | 100M calls/mo · $0.001/1K overage · SLA 99.9% |
| Platform License | Negotiated ($2M+/yr) | Volume cap negotiated · native integration |

**Subscribe:**

Dev **$29/mo** · Pro **$99/mo** · Team **$299/mo** — to subscribe, email [peter@kenosian.com](mailto:peter@kenosian.com).

Enterprise & Platform License: [peter@kenosian.com](mailto:peter@kenosian.com)

Contact: peter@kenosian.com

**Quota mechanics — stdio vs HTTP:**

- **HTTP mode** (Glama / Smithery container, `PORT` set): the per-IP free tier limit (100 calls/day) is enforced locally in the server process.
- **stdio mode** (Claude Code `npx`, Claude Desktop): there is no per-IP counter. Tool calls are delegated to `api.kenosian.com` via `X-TTT-API-Key`; quota is enforced server-side against your plan's monthly allowance. Without `TTT_API_KEY` the local fallback runs with no daily cap, but plan features (server-side DAG persistence, multi-session causal chains) are unavailable.

---

## Requirements

- Node.js >= 18
- Network access for time synthesis (HTTPS to time.nist.gov, time.google.com, time.cloudflare.com)

**Time source tiers (automatic fallback):**

| Tier | Source | Stratum | Notes |
|------|--------|---------|-------|
| 1 (preferred) | PTP / hardware clock | 0–1 | Requires local PTP daemon |
| 2 | Roughtime / NTP (NIST, Google, Cloudflare) | 2–4 | Default for most deployments |
| 3 (offline fallback) | Local system clock | 16 | RFC 5905 unsynchronized stratum — used when all network sources are unreachable |

The server falls through to stratum 16 automatically; no manual configuration needed. The `stratum` field in every `pot_generate` response indicates which tier was used.

**Redis persistence (optional):**

Redis is not required. The in-memory DAG is authoritative at runtime. If `REDIS_URL` is set, events are written to Redis with a 90-day TTL and the DAG is rebuilt from Redis on server restart — reducing `server_restart` chain gaps. Without Redis, the in-memory DAG is cleared on restart.

---

## Production Tips

**Cold Start warm-up** — On first startup, BatchSigner requires one request to initialize. Call `pot_health` or send a single dummy `pot_generate` before your load balancer health check goes live. Without this, the first request may see p99 ~500ms; subsequent requests stabilize to <10ms.

```bash
# Kubernetes / Docker: add to your startup script
curl -s http://your-server/pot/health > /dev/null
```

---

## Learn More

- [OpenTTT SDK](https://www.npmjs.com/package/openttt) — The underlying SDK
- [IETF Draft: draft-helmprotocol-tttps-00](https://datatracker.ietf.org/doc/draft-helmprotocol-tttps/) — TTTPS Protocol Specification
- [Helm Protocol](https://github.com/Helm-Protocol) — GitHub

## License

BSL-1.1 — free for non-commercial use.

**Commercial use** (production bots, hedge funds, prop desks) requires a license.

Change Date: 2029-05-28 → Apache 2.0
