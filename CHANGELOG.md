# Changelog

All notable changes to `@helm-protocol/ttt-mcp` are documented here.

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
