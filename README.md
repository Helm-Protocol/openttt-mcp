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
| **Resilience** | Golay cryptographic shards | ≥97% recovery at BER=0.05, 99.88% at BER=0.02 |
| **Persistence** | Redis AOF + 90-day TTL | Server survives context compression and restarts |

---

## Quick Start

### Claude Code

```bash
claude mcp add ttt -- npx -y @helm-protocol/ttt-mcp@0.3.0
```

With API key (unlimited calls):
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
      "args": ["-y", "@helm-protocol/ttt-mcp"],
      "env": { "TTT_API_KEY": "your-key" }
    }
  }
}
```

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
- `rollupSummary` — compressed event history (depth-adaptive: full/compact/minimal/rollup)
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
// checkpoint.rollupSummary — depth-adaptive compressed history (10–200 tokens/event)
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

**Solution**: Call `pot_generate` before every submission. The PoT receipt is cryptographically signed by three independent time sources (NIST, Google, Cloudflare), anchored on Base Sepolia TTT ERC-1155. If front-running occurs, you have a timestamped, on-chain record predating the attacker's block inclusion.

```typescript
const pot = await client.callTool({
  name: "pot_generate",
  arguments: { txHash: pendingTxHash, chainId: 8453, poolAddress: "0x..." }
});
// pot.potHash — your evidence, timestamped by NIST+Google+Cloudflare
```

---

### 3. DEX Protocol — Sandwich Deterrence

**Solution**: Integrate `TTTHookSimple` (Uniswap V4 hook, Base Sepolia: `0x8C633b05b833a476925F7d9818da6E215760F2c7`). Honest builders get `turbo` mode. Tampered sequences get `full` mode (penalty delay). Economics, not governance.

---

### 4. Hedge Fund / Prop Desk — MiFIR Art.22c Compliance

**Problem**: MiFIR Article 22c / RTS 25 requires microsecond-precision UTC-synchronized timestamps. Hardware PTP appliances cost $50K–$500K.

**Solution**: `pot_generate` produces an Ed25519-signed timestamp with uncertainty bound and multi-source attestation. Structurally compatible with RTS 25 audit record requirements. One API call per trade.

```typescript
const audit = await client.callTool({
  name: "pot_generate",
  arguments: { txHash: tradeHash, chainId: 8453 }
});
// audit.timestamp: nanosecond precision
// audit.uncertainty: ±ms bound (RTS 25 required field)
// audit.confidence: fraction of sources that agreed
```

**Outcome**: MiFIR-grade audit trail. IETF standardized via `draft-helmprotocol-tttps-00`.

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

**Subscribe instantly:**

[![Dev $29/mo](https://img.shields.io/badge/Dev-$29%2Fmo-1a1a1a?style=flat)](https://buy.paddle.com/product/pri_01kswrh5mb6pmp0fxdsnkaxxg7)
[![Pro $99/mo](https://img.shields.io/badge/Pro-$99%2Fmo-1a1a1a?style=flat)](https://buy.paddle.com/product/pri_01kswrh5svjsjcw01reh3sa0hh)
[![Team $299/mo](https://img.shields.io/badge/Team-$299%2Fmo-1a1a1a?style=flat)](https://buy.paddle.com/product/pri_01kswrh5zvjbp4xsw59tb5wq3f)

Enterprise & Platform License: [peter@kenosian.com](mailto:peter@kenosian.com) · Full pricing: [kenosian.com/pricing](https://kenosian.com/pricing.html)

Contact: peter@kenosian.com

---

## Requirements

- Node.js >= 18
- Network access for time synthesis (HTTPS to time.nist.gov, time.google.com, time.cloudflare.com)

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
