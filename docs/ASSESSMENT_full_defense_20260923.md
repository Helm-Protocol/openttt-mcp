# ASSESSMENT — openttt-server ↔ TTT-MCP 전 방어 연동 실측 (2026-09-23 16:20 KST)
> 전부 이 세션 도구출력 [MEASURED]. 복사해서 감사용.

## 1. Jay 주장 검증 결과 — 대부분 사실

| 주장 | 검증 | 근거(파일:함수/커밋) |
|---|---|---|
| Codex가 Roughtime dchain-Quorum uniqueness 구현 | **참** | `openttt-server/src/roughtime_probe.rs`: `probe_chain_quorum_and_dchain`(:345) · `compute_dchain_digest`(:877) · `verify_chain_packet_level`(:1075). 커밋 `4547ee2 Add authorized unique peer quorum`, `10aaf96 Harden authorized quorum`, `1238304 Expand Sybil admission regression matrix`, `15996ad merge Roughtime quorum+chain (draft-07 §8.2)` |
| draft-11 TLS 바인딩 키 구현 | **참(두 곳)** | (a) MCP `pot_record_v2.ts` EXPORTER-TTTPS-v2-Binding 32옥텟(이미 라이브·Tier1) (b) server `admission.rs` `SessionOpenChallenge.channel_binding:[u8;32]` = QUIC TLS exporter |
| Sybil/quorum uniqueness | **참** | `admission.rs`: 물리엔티티 기준 dedup(`physical_entity_id`), 테스트 `physical_duplicates_do_not_inflate_quorum`(:821)·`replay_nonce_is_rejected...`(:929)·`quorum_collapse_is_hold...`(:953) |
| TLA+ → Lean, TTTPS Lean이 kvault에 연동 | **부분 참** | `KLean/TTTPS/Core.lean` sorry=0 axiom=0(kernel-standard, propext만). 정리 5개: `zero_state_preservation`·`invalid_ingress_no_mutation`·`valid_ingress_commit_delta`·`parse_is_deterministic`·`parsed_record_has_fixed_size`. kvault 영수증 anchored(receipt_id 33108706…). **단** 이 증명은 "180옥텟 고정파싱 + 무효입력시 상태불변" 경계만. 스스로 "cryptographic security나 wire interop은 주장 안 함"이라 명시. TLA+ .tla 파일은 이 박스에서 못 찾음(미확인) |

## 2. 진짜 병목 — 외부감사가 옳다

**openttt-server의 강한 방어(Roughtime 체인·quorum·Sybil)가 TTT-MCP v2 검증경로에 연결 안 돼 있다.**
- `openttt-mcp/tools.ts`에 `chain_digest|quorum|roughtime|dchain` grep = **0건**.
- `pot_verify_v2`는 로컬 암호검사만: integrity(SHA256) + issuer Ed25519 sig + TLS exporter binding + Redis replay. (Tier1, 이미 라이브·검증됨)
- 180옥텟 v2 레코드 레이아웃엔 **chain_digest 필드가 없다**(version/type/alg/ts/dispersion/ctx_id/nonce/holder/integrity/issuerKeyId/issuerSig). 그래서 per-record Roughtime 바인딩은 wire 변경 없이는 불가.

## 3. 13종 매트릭스 — 오늘 정직한 라이브 판정 가능표

| 공격 | 지금 어디가 막나 | 오늘 TTT-MCP서 라이브 증명? |
|---|---|---|
| Token Replay | MCP replay ledger(Redis NX) | ✅ (Bob self-replay=rejected 실측) |
| Signature Forgery | MCP Ed25519 issuer sig | ✅ (Eve forge=rejected 실측) |
| Cross-session/BGP/DNS(가로채기·재서명) | MCP TLS1.3 exporter binding + issuer sig | ✅ (Eve hijack=rejected 실측) |
| Protocol Violation | MCP 길이/버전 schema | ✅ (179B/미지원버전 거부) · ECC정정은 ❌미입증 |
| Timestamp Drift/NTP Injection | **서버시각 freshness 강제 필요(Tier2)** | ⚠️ 현재 호출자 시간의존 → Tier2로 서버강제하면 ✅ |
| Issuer 위조(자기 키+issuerPubKey 인자) | **신뢰 issuer 고정 필요(Tier2)** | ⚠️ 현재 intact(구멍) → Tier2 pinning하면 ✅ |
| Sybil / Cross-Pool / Ordering | openttt-server admission quorum | ⚠️ 서버엔 있음, MCP 미연동 → 서버 위임 필요 |
| GPS Spoofing | server Roughtime ≥3 소스 chain spread | ⚠️ 서버엔 있음, per-record 바인딩 불가 → 서버 freshness로 간접 |
| Flood/DDoS | MCP IP/일 레이트리밋 | ⚠️ 분당/agent별·부하시험 미측정 |

✅=오늘 라이브 · ⚠️=Tier2/서버위임 필요 · ❌=아키텍처상 미지원

## 4. 오늘 실행 계획(승인됨, 정직 범위)
- **Tier2 (MCP 로컬, 오늘 구현+테스트 확실)**: ①신뢰 issuer 고정(`TTTPS_TRUSTED_ISSUERS`, issuerPubKey 인자 무시) ②서버시각 freshness 강제(`TTTPS_ENFORCE_FRESHNESS`+`TTTPS_MAX_SKEW_US`, 서버 clock) ③holder allowlist(`TTTPS_TRUSTED_HOLDERS`) ④작업 결속(ctxId=SHA256(action)). → 감사 top-2(freshness·issuer) + 위조·Sybil-lite 닫음.
- **서버 위임(가능하면)**: MCP verify가 `api.kenosian.com/pot/verify`·`/pot/chain` 호출해 Roughtime chain_digest·quorum 판정을 verdict에 합류. per-record 바인딩 불가는 명시.
- **정직 매트릭스 라이브 체커**: 13행 각 DEFENDED/PARTIAL/N-A/NOT-MEASURED + 실행커맨드. 워룸이 서버 실판정만 표시.
- **삭제 유지**: sub-ms·Lean sorryAx:0(전체 crypto)·zero-mutation(DB)·"13종 전부 프로덕션 차단"은 과장.

## 5. 터미널 복사
tmux `mouse on`이야. 드래그하면 tmux 복사모드로 들어가 클립보드 안 갈 수 있어. **Shift+드래그**로 선택하면 tmux 우회하고 터미널 네이티브 복사가 돼(SSH 클라 클립보드로). 또는 이 .md 파일들을 열어서 복사해.
