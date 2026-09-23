# Typeform text — Claims-Ledger-clean (2026-09-23)
> Every claim below maps to code + a live rehearsal on this host. Overclaims removed.

## One-paragraph
ttttps:// on MCP (npm i @helm-protocol/ttt-mcp@0.4.0) is a deterministic, cryptographically
enforced verification gate for MCP tool calls. Problem: LLM-level guardrails don't stop
session hijacking, payload tampering, or replay at the protocol layer. What it does: draft-11
180-octet PoT Record v2 with SHA-256 record integrity, Ed25519 issuer signature, native TLS 1.3
RFC 5705 exporter session binding (a proof from one session is rejected on another), and an
atomic Redis replay ledger — all fail-closed. Live at the booth: attack a real published package
on a live host and watch the server's own verdicts.

## Bullets
- Audience: MCP tool developers, AI-agent builders, security engineers.
- Problem: guardrails miss hijacking, tampering, replay at the network/protocol layer.
- Solution: draft-11 v2 record + TLS 1.3 EXPORTER-TTTPS-v2-Binding + atomic replay ledger, fail-closed.
- Live challenge: "Bob vs Eve" — reuse Bob's published record+proof and try to get past the real gate.

## H. Other (challenge details)
Interactive "Bob vs. Eve" live challenge on the published @helm-protocol/ttt-mcp@0.4.0:
- Bob (legitimate): issues one valid draft-11 180-octet v2 record bound to his live TLS 1.3 session.
- Eve (audience): cross-session TLS-exporter reuse, 1-octet record tampering, forged issuer signature.
- War room: real server verdicts (reason + server-measured latency) on a live terminal dashboard. Nothing simulated.
