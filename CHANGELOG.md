# Changelog

All notable changes to `@helm-protocol/ttt-mcp` are documented here.

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
