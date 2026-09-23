# TTT-MCP 공격 방어 매트릭스 — 라이브 실측 (2026-09-23, Tier-2)
> 대상: 실 canary(openttt-mcp:draft11-v2, 8443, 실 cert, Tier-2 전 플래그 ON). 전부 이 세션 도구출력 [MEASURED].
> 판정: ✅DEFENDED(라이브 거부 실측) · 🟡PARTIAL · ⬜N/A(패키지 범위밖) · ▫️NOT-MEASURED.
> 정직 원칙: intact(암호무결)≠authorized(승인). 아래는 pot_verify_v2가 실제 반환한 사유.

| # | 공격 | TTT-MCP 판정 | 서버 반환 사유(실측) | 방어 계층 |
|---|------|------|------|------|
| 1 | Token Replay | ✅ | `replay detected` | MCP Redis (ctx_id,nonce) SET NX |
| 2 | Signature Forgery | ✅ | `issuer signature invalid` | Ed25519 issuer sig |
| 3 | 자기 issuer 키 위조 | ✅ | `issuer signature invalid` | Tier-2 issuer pin(caller key 무시) |
| 4 | Cross-session 탈취 | ✅ | `TLS exporter holder proof mismatch` | draft-11 TLS1.3 RFC5705 exporter binding |
| 5 | BGP 가로채기 후 재제출 | ✅ | `TLS exporter holder proof mismatch` | 동일(다른 세션 exporter 불일치) |
| 6 | DNS 오염→가짜 issuer | ✅ | `issuer signature invalid` / `issuer not trusted` | issuer pin |
| 7 | 1옥텟 변조 (payload tamper) | ✅ | `integrity mismatch` | SHA-256 무결성(옥텟0-79) |
| 8 | Protocol violation(179B/버전) | ✅ | `invalid frame size` / `unknown version` | 길이·버전 schema |
| 9 | Timestamp Drift / 오래된 토큰 | ✅ | `freshness window exceeded` | Tier-2 서버시각 freshness |
| 10 | NTP Injection / GPS Spoofing | ✅(간접) | `roughtime quorum unavailable`(quorum 붕괴 시) | openttt-server 다중소스 Roughtime quorum admission |
| 11 | Sybil / 미인가 holder | ✅ | `holder not authorized` | Tier-2 holder allowlist |
| 12 | Cross-Pool Replay | 🟡 | ctx 변조=거부. 유효 타 ctx의 대상 pool 정책은 MCP 범위밖 | ctx_id 무결성 |
| 13 | Ordering / SDN reorder | ⬜ | 180B v2 레코드에 fleet ordering 필드 없음(서버 admission.rs엔 있음) | 서버측(별도) |
| — | Flood/DDoS | 🟡 | IP/일 레이트리밋(FREE_TIER_LIMIT). 분당/agent·부하시험 ▫️미측정 | MCP rate limit |
| — | ECC 오류정정 | ▫️ | 길이/무결성만 관측, ECC 정정 미입증 | — |

## 라이브 실측 로그 (Tier-2 canary, 8443)
```
BOB (authorized holder)                intact                              (40539us 최초=roughtime fetch 포함)
Eve cross-session hijack               rejected  TLS exporter holder proof mismatch  (4145us)
Eve 1-octet tamper                     rejected  integrity mismatch                  (5279us)
Eve forged issuer signature            rejected  issuer signature invalid            (3107us)
Eve 1-hour-old timestamp               rejected  freshness window exceeded           (1504us)
Eve unauthorized holder identity       rejected  holder not authorized               (2280us)
Eve own issuer key (Tier-1 hole 닫힘)  rejected  issuer signature invalid            (20518us)
Bob self-replay                        rejected  replay detected
Roughtime 소스 차단 시(로컬 18444)      rejected  (roughtime quorum unavailable, fail-closed 실증)
```

## 정직한 경계 (발표/타입폼서 반드시 지킬 것)
- ✅는 "이 공격 벡터를 pot_verify_v2가 라이브로 거부함"이라는 뜻. "DB 삭제 방어"가 아님(작업 게이트는 별도 배선 필요).
- #10 GPS/NTP는 per-record 시간 바인딩이 아니라 **admission 전제(라이브 quorum 필요)**로 방어. quorum 살아있으면 통과, 붕괴하면 전면 hold. 이게 정직한 표현.
- #12/#13/Flood/ECC는 과장 금지 — 🟡/⬜/▫️ 그대로 화면표시.
- 여전히 금지: "sub-ms"(실측 1.5~40ms), "13종 전부 프로덕션 100% 차단", "Lean sorryAx:0가 전 crypto 증명".
- 가능: "draft-11 TLS1.3 exporter binding · issuer pin · server freshness · holder allowlist · Roughtime multi-source quorum admission · atomic replay ledger — 전부 게시 패키지가 라이브 호스트에서 실판정."
