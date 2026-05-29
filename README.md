# @helm-protocol/ttt-mcp

> Reference implementation of [draft-helmprotocol-tttps-00](https://datatracker.ietf.org/doc/draft-helmprotocol-tttps/) (IETF Experimental)

**MCP Server for OpenTTT — Proof of Time tools for AI agents**

---

## The Problem: Workflow Amnesia

Large Claude Code workflows — 20-agent Dynamic Workflows, multi-day multi-session projects, 100K+ token contexts — all face the same failure mode: **context compression erases action history.**

Agent B has no memory of what Agent A decided. Agent A resumes after compression with no record of its own prior steps. Duplicate work. Lost decisions. State corruption.

**ttt-mcp is the external nervous system that survives context compression.**

Every workflow step is anchored to a cryptographic timestamp on an **external server** — physically separate from Claude's context window. When compression happens, agents query their exact action history through the MCP tools and resume with full causal context.

```
Claude workflow → [context compressed] → agents call pot_query(eventId)
                                         → external server returns full timeline
                                         → workflow resumes, zero lost state
```

---

## Mathematical Guarantee

| Layer | Mechanism | Guarantee |
|-------|-----------|-----------|
| **Identity** | SHA-3 eventId (256-bit) | Collision probability 2⁻²⁵⁶ ≈ 0 — practically 100% exact step recall |
| **Ordering** | TTTPS causal timestamps | Total order on events — tamper-proof sequence proof |
| **Causal chain** | prevEventId DAG | O(depth) traversal — depth ~100 for 1B-token workflows |
| **Fingerprint** | Multi-layer cryptographic pipeline | Formally bounded tamper-evident step identity |
| **Non-repudiation** | Ed25519 signature | Cryptographic proof of who acted when |

---

## Quick Start

```bash
# Claude Desktop
```json
{
  "mcpServers": {
    "ttt": {
      "command": "npx",
      "args": ["-y", "@helm-protocol/ttt-mcp"]
    }
  }
}
```

Add `TTT_API_KEY` for unlimited calls (free tier: 100 calls/day per IP).

---

## Tools

| Tool | Description |
|------|-------------|
| `pot_generate` | Stamp a workflow step with eventId + prevEventId (builds causal chain) |
| `pot_verify` | Verify a Proof of Time using its hash and integrity shards |
| `pot_query` | O(1) exact lookup by eventId — call this after context compression |
| `pot_graph` | Traverse full causal DAG — backward + forward chain from any step |
| `pot_stats` | Get turbo/full mode statistics for a time period |
| `pot_health` | Check system health: time sources, uptime, current mode |

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

**Solution**: Integrate `TTTHookSimple` (Uniswap V4 hook, Base Sepolia: `0x8C633b05b833a476925F7d9818da6E215760F2c7`). Honest builders get `turbo` mode. Tampered sequences get `full` mode (exponential backoff). Economics, not governance.

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

## Rate Limits & Pricing

```
Free Tier:   100 calls/day per IP — no API key needed
BOT Tier:    $199/mo — unlimited, SLA
DEX Tier:    $499/mo — unlimited, priority support
FUND Tier:   $2K+/mo — enterprise, dedicated infra
```

Get a key: [kenosian.com/pricing](https://kenosian.com/pricing)

---

## Requirements

- Node.js >= 18
- Network access for time synthesis (HTTPS to time.nist.gov, time.google.com, time.cloudflare.com)

---

## Learn More

- [OpenTTT SDK](https://www.npmjs.com/package/openttt) — The underlying SDK
- [IETF Draft: draft-helmprotocol-tttps-00](https://datatracker.ietf.org/doc/draft-helmprotocol-tttps/) — TTTPS Protocol Specification
- [Helm Protocol](https://github.com/Helm-Protocol) — GitHub

## License

BSL-1.1 — free for non-commercial use.

**Commercial use** (production bots, hedge funds, prop desks) requires a license.

Change Date: 2029-05-28 → Apache 2.0
