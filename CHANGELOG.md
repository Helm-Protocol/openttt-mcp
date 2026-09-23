# Changelog

All notable changes to `@helm-protocol/ttt-mcp` are documented here.

## [0.4.2] - 2026-09-23

### Changed
- Admission now consumes `chain_valid` (roughtime_ok AND non-zero multi-source Roughtime D-chain digest) from the time authority's `/pot/status`, not just the boolean — a single reachable time source no longer satisfies admission (Sybil / GPS / NTP time-source resistance). Falls back to `roughtime_ok` for older servers.
- `formal` receipt is now explicit that TLA+<->Lean<->runtime is provenance, not an end-to-end 1:1 machine proof (`binding_status`, `lean.abstraction`, `tla.method`, `revision`).

## [0.4.1] - 2026-09-23

### Added — draft-11 Tier-2 admission (all env-gated, default off; unchanged verdict path when unset)

- **Server-decided freshness** (`TTTPS_ENFORCE_FRESHNESS=1`, `TTTPS_MAX_SKEW_US`, default 60s): the verifier uses its own clock and tolerance; caller-supplied `nowTaiUs`/`maxSkewUs` are ignored so an attacker cannot choose the clock.
- **Issuer pinning** (`TTTPS_PIN_SELF_ISSUER=1` or `TTTPS_TRUSTED_ISSUERS=<hex,...>`): caller-supplied `issuerPubKey` is ignored; the signature must verify against a pinned key, else `issuer not trusted`.
- **Holder allowlist** (`TTTPS_TRUSTED_HOLDERS=<hex,...>`): a cryptographically valid record from an unlisted holder is rejected `holder not authorized`.
- **Roughtime quorum admission** (`TTTPS_REQUIRE_ROUGHTIME_QUORUM=1`, `TTTPS_ADMISSION_STATUS_URL`): the gate admits only while the time authority reports a live multi-source Roughtime quorum; degraded consensus fails closed.
- **Verdict audit stream** for war-room telemetry (`TTTPS_AUDIT_STREAM`, default `tttps:audit:v2`) with server-measured latency; fire-and-forget, never alters the verdict.
- **Formal-verification provenance** on `pot_verify_v2` responses (`formal`): the TLA+ model, the Lean 4 module (`KLean.TTTPS.Core`, sorry 0 / axiom `propext`), and the kvault anchor, with an explicit `binding_status` = provenance-only (not an end-to-end 1:1 proof) and honest scope.

### Fixed

- `Dockerfile` HEALTHCHECK now follows `PORT` and uses HTTPS when a TLS cert is configured.
- Removed a stale "O(1) ... 2^-256" phrase from the `pot_query` description.

## [0.4.0] - 2026-09-22

### Added — draft-helmprotocol-tttps-11 PoT Record v2 (canonical wire profile)

- **New tool `pot_generate_v2`** — emits the draft-11 180-octet PoT Record v2 core: SHA-256 integrity over octets 0-79 and Ed25519 issuer authentication over octets 0-115. `pot_record_v2.ts` implements encode/decode/verify.
- **New tool `pot_verify_v2`** — verifies the v2 core and, optionally, a 64-octet Ed25519 or 32-octet HMAC TLS binding proof. Binding verification uses the TLS 1.3 keying-material exporter (`EXPORTER-TTTPS-v2-Binding`, 32 octets) of the live session; a proof computed under a different session is rejected.
- **TLS-bound HTTPS ingress** — when `MCP_TLS_CERT_FILE` and `MCP_TLS_KEY_FILE` are set, the HTTP transport runs a TLSv1.3-only HTTPS server and threads the per-connection exporter to `pot_verify_v2` via `AsyncLocalStorage` (`tls_exporter.ts`, `transport_context.ts`).
- **`TTTPS_V2_REQUIRE_BINDING=1`** — fail-closed mode: binding proof becomes mandatory and stdio / plain-HTTP requests (no TLS exporter) are refused.
- **Replay protection** for v2 claims keyed on `(ctx_id, nonce)` with `TTTPS_REPLAY_TTL_SECONDS` (default 86400).
- `scripts/tls_v2_integration.mjs` — live TLS 1.3 round-trip check (record → exporter → binding proof → verify → cross-session reject).

### Changed

- Draft-08 (`pot_verify_v08`) is retained for legacy interoperability only; draft-11 v2 is the canonical profile.
- Tool count 8 → 10. Server advertises version 0.4.0 (McpServer metadata, `/health`, `server.json`).
- CI: npm trusted publishing via GitHub OIDC with token fallback.

## [0.3.4] - 2026-08-01

### Changed

- Depend on `openttt` ^0.3.0 for Roughtime-verified time sources.

## [0.3.3] - 2026-08-01

### Fixed

- Published package was missing `pot_record_v08.js`; `pot_record_v08.ts` added to the esbuild entry list.

## [0.3.2] - 2026-07-30

### Added — draft-helmprotocol-tttps-08 §3 Payload Digest

- **`contentDigest` parameter on `pot_generate`** — caller-supplied SHA-256 digest of the content being attested. When supplied, and the local time synthesis meets the spec's own requirements (≥3 independent sources, a representable error bound), the response includes a spec-conformant `potRecordV08` binary record (184 or 216 octets, hex-encoded); otherwise `potRecordV08Error` explains why not. The server never sees the content itself, only its digest.
- **New tool `pot_verify_v08`** — recomputes the record's Commitment (draft-08 §3.3.2, algorithm 0x0001, SHA-256) and Ed25519 signature, and, if `content` is supplied, checks it against the record's Payload Digest field.
- **`pot_record_v08.ts`** — record encode/decode/commitment/sign/verify, tested byte-exact against both Appendix A test vectors of draft-helmprotocol-tttps-08.

## [0.3.1] - 2026-07-18

### Added — TTT Seal Layer

- **`_tttps_freshness` on every tool response** — all MCP tool responses now include a freshness stamp: `{ age_ms, stratum, sources, ttlMs }`. `age_ms` = milliseconds since last PoT was generated. `ttlMs` = suggested MCP cache TTL (aligns with MCP RC 2026-07-28 `ttlMs` concept). Only populated after first `pot_generate` call.

## [0.3.0] - 2026-05-29

### Added — Amnesia Prevention P1~P5

- **P1: `pot_checkpoint` tool** — 7번째 MCP tool로 등록. `checkpointId`, `eventCount`, `chainIntact`, `nextCheckpointHint`, `rollup`, `summary`, `generatedAt` 반환. 컨텍스트 압축 후 워크플로우 히스토리 복원용.
- **P2: depth별 압축** — `compressEntry(entry, depth)` 함수 신규 추가. depth 1-5: full / 6-20: compact / 21-50: minimal / 51+: rollup string. `pot_graph` 및 `pot_checkpoint`에 적용. 대규모 체인 탐색 시 토큰 폭발 방지.
- **P3: 오프라인 폴백** — `potGenerate`에서 `TimeSynthesis` 실패 시 stratum:16(RFC 5905 unsynchronized) fallback PoT 자동 생성. throw 대신 로컬 타임스탬프 기반 폴백 반환.
- **P4: DeFi / Claude Code 경로 분리** — DeFi 파라미터(txHash+chainId+poolAddress) 존재 시에만 블록 검증 호출. Claude Code 경로(eventId만)에서는 현재 모드 유지. 불필요한 mode 전환 방지.
- **P5: chainBroken 감지** — `evictedEventIds Set` 신규 추가(최대 1000개). ring buffer eviction 시 evictedEventIds에 자동 추적. `pot_graph` 반환값에 `chainBroken`, `brokenAt` 포함.

### Also Added
- O(1) 역방향 인덱스: `potByPrevEventId` Map으로 forward chain 탐색 O(n)→O(1) 개선
- `evictedEventIds` 자체도 bounded(1000개 상한)하여 메모리 누수 방지

## [0.2.0] - 2026-05-28

### Changed
- License: MIT → BSL-1.1 (free for research/personal/dev; commercial license required for production trading systems)
- Free tier: 100 calls/day per IP, enforced via `auth.ts` rate limiter connected to HTTP server
- Health endpoint version bumped to 0.2.0

### Added
- `auth.ts`: in-memory rate limiter (`checkRateLimit`, `resolveApiKey`). IP-based bucketing, midnight UTC reset, API key bypass for paid tier
- `ADDITIONAL_USE_GRANT.md`: explicit free-tier conditions (research/personal/dev free; hedge funds/OTC/DEX production require commercial license)
- `.claude-plugin/marketplace.json`: Claude Marketplace listing with tool manifest
- `CHANGELOG.md`: this file

### Fixed
- `auth.ts` was created but not imported in `index.ts` — rate limiting is now active for all POST requests in HTTP mode
- Health endpoint response version was stale (0.1.5 → 0.2.0)

## [0.1.x] - Prior releases

See git log for full history of v0.1.x changes (Smithery.ai config, esbuild migration, dependency bumps).
