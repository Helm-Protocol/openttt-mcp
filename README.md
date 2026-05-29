# @helm-protocol/ttt-mcp

> Reference implementation of [draft-helmprotocol-tttps-00](https://datatracker.ietf.org/doc/draft-helmprotocol-tttps/) (IETF Experimental)

**MCP Server for OpenTTT — Proof of Time tools for AI agents**

> You run a Claude Code Dynamic Workflow — 20 parallel agents rewriting a codebase.
> Which agent made which decision? At exactly what time? In what order?
>
> OpenTTT answers this with cryptographic Proof of Time — tamper-proof,
> IETF-standardized, and audit-grade from the moment each agent acts.

## Quick Start

```bash
npm install @helm-protocol/ttt-mcp
```

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "ttt": {
      "command": "npx",
      "args": ["@helm-protocol/ttt-mcp"]
    }
  }
}
```

That's it. Your AI agent now has access to 5 Proof of Time tools.

## Use with Claude Code Dynamic Workflows

Type "workflow" in Claude Code to spin up parallel agents. Add OpenTTT to timestamp every step:

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "ttt": {
      "command": "npx",
      "args": ["@helm-protocol/ttt-mcp"]
    }
  }
}
```

Each agent can now call `pot_generate` to create a tamper-proof record of its action:
- **Who** acted (agent ID)
- **What** was produced (content hash)
- **When** exactly (TTTPS multi-source timestamp)
- **In what order** (GRG integrity shards)

Use cases: compliance audit trails, legal document timestamping, regulated industry AI workflows.

## Tools

| Tool | Description |
|------|-------------|
| `pot_generate` | Generate a Proof of Time for a transaction |
| `pot_verify` | Verify a Proof of Time using its hash and GRG shards |
| `pot_query` | Query PoT history from local log and on-chain subgraph |
| `pot_stats` | Get turbo/full mode statistics for a time period |
| `pot_health` | Check system health: time sources, subgraph sync, uptime |

## Tool Parameters

### pot_generate

Generate a Proof of Time for a transaction. Returns potHash, timestamp, stratum, and GRG integrity shards.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| txHash | string | Yes | Transaction hash (hex with 0x prefix) |
| chainId | number | Yes | Chain ID (e.g. 8453 for Base, 84532 for Base Sepolia) |
| poolAddress | string | Yes | DEX pool contract address |

### pot_verify

Verify a Proof of Time using its hash and GRG shards. Returns validity, mode (turbo/full), and timestamp.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| potHash | string | Yes | PoT hash to verify (hex with 0x prefix) |
| grgShards | string[] | Yes | Array of hex-encoded GRG integrity shards |
| chainId | number | Yes | EVM chain ID (e.g. 84532 for Base Sepolia) |
| poolAddress | string | Yes | Uniswap V4 pool address (0x-prefixed) |

### pot_query

Query Proof of Time history from local log and on-chain subgraph.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| startTime | number | No | Start time (unix ms). Default: 24h ago |
| endTime | number | No | End time (unix ms). Default: now |
| limit | number | No | Max entries to return. Default: 100, max: 1000 |

### pot_stats

Get PoT statistics: total swaps, turbo/full counts, and turbo ratio for a given period.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| period | `"day"` \| `"week"` \| `"month"` | Yes | Time period for statistics |

### pot_health

Check PoT system health: time source status, subgraph sync, server uptime, and current mode.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | — | — | This tool takes no parameters |

## Example: Generate and Verify a PoT

```typescript
// In your AI agent's tool call:
const pot = await pot_generate({
  txHash: "0xabc123...",
  chainId: 84532,
  poolAddress: "0xdef456..."
});

// pot.potHash — unique Proof of Time hash
// pot.grgShards — GRG integrity shards for verification
// pot.timestamp — synthesized nanosecond timestamp
// pot.mode — "turbo" (honest) or "full" (requires full verification)

const verification = await pot_verify({
  potHash: pot.potHash,
  grgShards: pot.grgShards
});
// verification.valid — true if integrity shards reconstruct correctly
```

## How It Works

1. **Time Synthesis** — Queries multiple independent time sources (NIST, Google, Cloudflare) via HTTPS/NTP and synthesizes a median timestamp with uncertainty bounds
2. **GRG Pipeline** — Encodes transaction data through a multi-layer integrity pipeline, producing verifiable shards
3. **Ed25519 Signing** — Signs the PoT hash for non-repudiation
4. **Adaptive Mode** — Honest builders get `turbo` mode (fast, profitable); tampered sequences get `full` mode (slow, costly) — natural economic selection

## Claude Desktop Configuration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ttt": {
      "command": "npx",
      "args": ["@helm-protocol/ttt-mcp"]
    }
  }
}
```

Config file locations:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

## Requirements

- Node.js >= 18
- Network access for time synthesis (HTTPS to time.nist.gov, time.google.com, time.cloudflare.com)

---

## Use Cases

### 1. MEV Bot — Transaction Ordering Proof

**Problem**: You got front-run. You know it happened. You can't prove it — mempool timestamps are per-node, unsigned, and non-authoritative. No evidence, no recourse.

**Solution**: Call `pot_generate` before submitting every transaction. The PoT receipt is cryptographically signed by three independent time sources (NIST, Google, Cloudflare), hashed on-chain to Base Sepolia TTT ERC-1155. If front-running occurs, you have a timestamped, on-chain-anchored record of your original submission that predates the attacker's block inclusion.

```typescript
// Before tx submission
const pot = await client.callTool({ name: "pot_generate", arguments: { txHash: pendingTxHash, chainId: 8453 } });
// Store pot.potHash alongside your trade log
// If front-run: pot.potHash is your evidence, timestamped by NIST+Google+Cloudflare
```

**V2 path**: When builder staking goes live, `S(V) ≥ V − c₀` makes reordering economically irrational for any V. Not just evidence — prevention.

---

### 2. DEX Protocol — AdaptiveSwitch Sandwich Deterrence

**Problem**: Small-to-mid value sandwich attacks (V < ~$87) are constant background noise on any AMM. Each one is individually too small to litigate, collectively significant. No governance mechanism moves fast enough to respond.

**Solution**: Integrate `TTTHookSimple` (Uniswap V4 hook, Base Sepolia: `0x8C633b05b833a476925F7d9818da6E215760F2c7`). Honest builders who preserve PoT-verified ordering get `turbo` mode (~50ms path). Builders who tamper are flagged to `full` mode (~127ms + exponential backoff up to 320 blocks). The 77ms throughput differential makes reordering cost exceed opportunity value for the V* range. No vote. No committee. Economics.

```typescript
// Query current switch state for a pool
const status = await client.callTool({ name: "pot_stats", arguments: { poolAddress: "0x..." } });
// status.adaptiveMode: "turbo" | "full"
// status.currentV_star: estimated MEV threshold being deterred
```

**Outcome**: ~80% reduction in sub-threshold sandwich attacks. Provable per-block audit trail.

---

### 3. Hedge Fund / Prop Desk — MiFIR Art.22c Compliance

**Problem**: MiFIR Article 22c / RTS 25 requires microsecond-precision UTC-synchronized timestamps for every trade on regulated venues. The standard hardware solution (PTP/IEEE 1588 appliances) costs $50K–$500K and requires dedicated ops. Most DeFi-adjacent funds run manual reconciliation between two separate timestamp systems.

**Solution**: `pot_generate` produces an Ed25519-signed timestamp with uncertainty bound, confidence score, and multi-source attestation. The output is structurally compatible with RTS 25 audit record requirements. No hardware appliance. No dedicated ops. One API call per trade.

```typescript
const audit = await client.callTool({
  name: "pot_generate",
  arguments: { txHash: tradeHash, chainId: 8453, metadata: { desk: "MACRO-1", trader: "algo-07" } }
});
// audit.timestamp: nanosecond precision
// audit.uncertainty: +/- ms bound (required field in RTS 25 record)
// audit.confidence: fraction of sources that agreed
// audit.ed25519_sig: non-repudiation signature
// Export to your compliance system — same format, every trade
```

**Outcome**: MiFIR-grade audit trail at ~$0.04/1K calls (DEX tier). Replaces $50K+ hardware setup. IETF standardized via `draft-helmprotocol-tttps-00`.

---

### 4. Liquidity Provider — Position Timeline for Dispute Resolution

**Problem**: LP enters and exits positions based on market conditions. When impermanent loss occurs due to a suspected protocol exploit or ordering manipulation, proving the sequence of events (position entry → exploit event → position exit) requires timestamped evidence that the current stack doesn't provide.

**Solution**: Stamp every LP action (add liquidity, remove liquidity, fee harvest) with a PoT receipt. The receipt chain creates an unforgeable causal timeline: each action's potHash references the previous, anchored on Base Sepolia. Legally defensible for tax documentation, insurance claims, and protocol dispute resolution.

```typescript
// On liquidity add
const entryPot = await client.callTool({ name: "pot_generate", arguments: { txHash: addLiqTx, chainId: 8453 } });

// On liquidity remove
const exitPot = await client.callTool({ name: "pot_generate", arguments: { txHash: removeLiqTx, chainId: 8453 } });

// Verify the causal chain
const chain = await client.callTool({ name: "pot_verify", arguments: { potHash: exitPot.potHash, precedingHash: entryPot.potHash } });
// chain.valid: true means exit cryptographically followed entry
```

---

### 5. AI Agent Coordination — Multi-Agent Causal Ordering

**Problem**: When multiple AI agents interact in a pipeline (Agent A signals → Agent B acts → Agent C settles), the causal order matters for debugging, auditing, and liability. Agent logs are unverifiable—any agent can claim any timestamp.

**Solution**: Each agent calls `pot_generate` before acting. The resulting potHash chain is independently verifiable: "Agent A's signal at T₁ preceded Agent B's action at T₂" can be proven without trusting either agent's self-reported logs. The on-chain anchor makes the ordering dispute-proof.

```typescript
// Agent A (signal generator)
const signalPot = await client.callTool({ name: "pot_generate", arguments: { txHash: signalId } });

// Agent B (executor) — references Agent A's pot
const execPot = await client.callTool({
  name: "pot_generate",
  arguments: { txHash: execId, precedingPotHash: signalPot.potHash }
});

// Any third party can verify the causal chain
const verified = await client.callTool({ name: "pot_verify", arguments: { potHash: execPot.potHash, precedingHash: signalPot.potHash } });
```

**Outcome**: Unforgeable causal chain across autonomous agents. Useful for multi-agent DeFi strategies, audit compliance, and cross-agent dispute resolution.

---

## TypeScript: MEV Bot Integration

```typescript
import { McpClient } from "@modelcontextprotocol/sdk/client/mcp.js";

// Generate a Proof of Time for a transaction
const result = await client.callTool({
  name: "pot_generate",
  arguments: {
    txHash: "0xabc123...",
    chainId: 8453,
    poolAddress: "0xdef456..."
  }
});
// Returns: { potHash, timestamp, stratum, grg_shards }
```

## Python: Hedge Fund Audit

```python
import subprocess, json

result = subprocess.run(
    ["npx", "-y", "@helm-protocol/ttt-mcp"],
    input=json.dumps({
        "tool": "pot_verify",
        "potHash": "0x...",
        "expectedChainId": 8453
    }),
    capture_output=True, text=True
)
```

## Rate Limits & Pricing

```
Free Tier:   100 calls/day per IP — no API key needed
Paid Tier:   Set TTT_API_KEY env var — unlimited
Commercial:  heime.jorgen@proton.me (hedge funds, DEX protocols, OTC desks)
```

## Learn More

- [OpenTTT SDK](https://www.npmjs.com/package/openttt) — The underlying SDK
- [IETF Draft: draft-helmprotocol-tttps-00](https://datatracker.ietf.org/doc/draft-helmprotocol-tttps/) — TTTPS Protocol Specification
- [Helm Protocol](https://github.com/Helm-Protocol) — GitHub

## License

BSL-1.1 — free for non-commercial use.

**Commercial use** (production bots, hedge funds, prop desks) requires a license.  
→ [Pricing](https://github.com/Helm-Protocol/openttt-mcp#pricing)

Change Date: 2029-05-28 → Apache 2.0
