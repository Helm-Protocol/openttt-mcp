# PLAN — Claude Build Day "Bob vs Eve" 프로덕션 시연 (2026-09-23)

> 작성 15:50 KST. 실측=[MEASURED] (이 세션 도구출력) · 목표=[TARGET] · 근거없음=[REMOVE].
> 승인 전 구현 0줄. 이 문서가 계획이고, 파일 쓰기 시작이 실행이다(R09).

## 0. 결론 먼저

**프로덕션 레벨로 갈 수 있다. 단, 지금 있는 것만으로는 "DB 방어"를 말할 수 없다.**
0.4.0 패키지는 *레코드·세션·재사용* 을 판정한다. *누가 무엇을 할 권한이 있나* 는 판정하지 않는다.
감사관 P0 4건은 tools.ts 원문으로 전부 참으로 확인됐다 [MEASURED]:

| P0 | 코드 실측 | 위치 |
|---|---|---|
| 권한 경계 없음 | `issuerPubKey`를 호출자가 넘기면 그걸로 검증한다. 공격자가 자기 issuer 키로 서명한 레코드도 `intact` | `tools.ts:590` `args.issuerPubKey ? Buffer.from(...) : potSignerPublicKeyRawV08` |
| 작업 결속 없음 | `ctxId`는 호출자가 준 16옥텟 그대로. 어떤 작업과도 대조 안 함 | `tools.ts:545-552`, `index.ts:213` |
| 시간 정책 호출자 의존 | `nowTaiUs`와 `maxSkewUs`를 **둘 다** 호출자가 줄 때만 신선도 검사 | `tools.ts:591-593` |
| 누구나 발급 | `pot_generate_v2`는 아무 holder 키로든 서버 issuer 서명 레코드를 발급 | `tools.ts:541-573` |

있는 것(작동 확인 [MEASURED]): TLS1.3 exporter 바인딩(교차세션 reject), `(ctx_id,nonce)` Redis 원자 claim(원장 불가=reject), 옥텟 0-79 SHA-256 무결성, 0-115 Ed25519 issuer 서명, `TTTPS_V2_REQUIRE_BINDING=1` fail-closed.

## 1. 운영 현장 실측 [MEASURED 15:36-15:48 KST]

```
컨테이너   openttt-mcp-canary (image openttt-mcp:draft11-v2) · host network · restart=no
상태       Up 14h · UNHEALTHY (failing streak 5018)
원인       HEALTHCHECK가 http://localhost:3000 을 찌름, 서버는 HTTPS 8443 → 헬스체크 오배선(서버 결함 아님)
env        PORT=8443 · TTTPS_V2_REQUIRE_BINDING=1 · TTTPS_REQUIRE_REPLAY_LEDGER=1 · REDIS_URL=redis://127.0.0.1:6380
Redis      127.0.0.1:6380 PONG
dist       9/22 16:20 빌드 · pot_verify_v2 탑재 · 그러나 /health·serverInfo는 "0.3.2" 광고(bd4ccb8 미반영)
TLS cert   /tmp/openttt-mcp-tls.cq0F1a/server.crt = 자체서명 CN=localhost, 만료 2026-09-23 16:32 UTC (= 9/24 01:32 KST)
외부노출   35.208.129.147:8443 → 응답 없음(방화벽 미개방 추정, gcloud 계정 없어 규칙 미확인). nginx 443은 8443 프록시 없음
레이트리밋 POST는 IP당 하루 100회(FREE_TIER_LIMIT 기본 100) → 관객 NAT 뒤에서 100회 넘으면 429
Lean       TTTPS v2 180옥텟 레코드 전용 .lean 파일 0건 (kenosian-lean4 grep)
```

리포 상태: `bd4ccb8` 푸시 완료(버전광고 0.4.0·README·CHANGELOG), typecheck 0 · jest 56/56 · `tls_v2_integration.mjs` PASS · 라이브 HTTPS 8443 리허설 PASS(TLS1.2 거부 확인).

## 2. 구현 설계 — 패키지 안에 넣는다 (Jay: "Canary 말고 NPM 프로덕션에서")

### 2.1 새 MCP 툴 `pot_gated_action_v2` (tools.ts + index.ts)
입력: `potRecordV2`(hex 360) · `bindingProof`(hex 128|64) · `action{subject, verb, target, body, runId}`
판정 순서(전부 쓰기 **이전**, 첫 실패에서 즉시 reject, 사유코드 1개):

1. `TLS_BINDING_MISSING` — bindingProof 없음 또는 live exporter 없음(stdio/프록시 종단)
2. `SIGNATURE_INVALID` — 무결성 태그/issuer 서명 실패. **issuerPubKey 인자 무시**, 서버 키만(`TTTPS_STRICT_ISSUER=1`)
3. `STALE` — 서버 시각(`Date.now()`→TAI 근사, 또는 openttt 합성시각) vs `ts_tai_us`, 허용오차 env `TTTPS_MAX_SKEW_US`(기본 5_000_000)
4. `HOLDER_UNAUTHORIZED` — `holder_auth_data` ∉ env `TTTPS_TRUSTED_HOLDERS`(hex,콤마) 또는 verb ∉ 그 holder 허용 verb
5. `ACTION_CONTEXT_MISMATCH` — `SHA-256(canonical_json(action))[0:16] ≠ ctx_id`
6. `TLS_BINDING_MISMATCH` — exporter 기반 holder proof 검증 실패
7. `REPLAY` / `LEDGER_UNAVAILABLE` — `(ctx_id,nonce)` Redis `SET NX`
8. 통과 시에만 canary 실행: Redis 해시 `demo:canary:<target>` 한 필드 갱신(`HSET`), 전후 `SHA-256(HGETALL 정렬직렬화)` 기록

응답(승인·거부 공통): `{verdict, reason_code, case_id, state_hash_before, state_hash_after, latency_us, receipt_id}`.
거부인데 `before≠after`면 툴 자체가 `verdict:"FAIL_INVARIANT"`를 낸다(워룸이 즉시 FAIL 표시).
모든 판정을 Redis 스트림 `demo:warroom`에 XADD(비밀 없음: 레코드 hex·사유·해시·지연만).

### 2.2 Bob 클라이언트 `scripts/bob_client.mjs`
행사용 Ed25519 키 생성(개인키는 Bob 노트북 파일만) → HTTPS 8443에 **단일 TLS 소켓**(https.Agent keepAlive, maxSockets 1)로 연결 → `pot_generate_v2(ctxId=SHA256(action)[0:16], holderAuthData=BobPub)` → 같은 소켓의 `exportKeyingMaterial`로 exporter → `computeV2BindingInput` 서명 → `pot_gated_action_v2` 1회 → receipt 출력·공개용 JSON(레코드 hex+proof) 저장.

### 2.3 Eve 공격 클라이언트 `scripts/eve_attacks.mjs` (관객용 CLI, case_id 자동)
E1 다른 TLS 세션에서 Bob 레코드+proof 재제출 → 기대 `TLS_BINDING_MISMATCH`
E2 Bob 동일 연결 재전송(Bob 스크립트 옵션) → `REPLAY`
E3 레코드 1옥텟 변조 → `SIGNATURE_INVALID`
E4 action 내용 교체(target/amount) → `ACTION_CONTEXT_MISMATCH`
E5 Eve 자기 holder 키로 `pot_generate_v2` 발급 후 정상 바인딩 → `HOLDER_UNAUTHORIZED` (★가장 중요, 현재 0.4.0은 이걸 `intact`로 통과시킨다)
E6 Eve 자기 issuer 키 레코드 + `issuerPubKey` 인자 → `SIGNATURE_INVALID`
E7 ts_tai_us 1시간 과거 → `STALE`
E8 (선택) Redis 정지 → `LEDGER_UNAVAILABLE` (fail-closed 시연, 운영 Redis 6380은 다른 서비스 공유 여부 확인 후)

### 2.4 워룸 `scripts/live_war_room.mjs` (ASCII, Redis 스트림 tail)
```
┌─ TTTPS GATE · LIVE ───────────────────────────────────────────┐
│  APPROVED  1      REJECTED  27      DRIFT AFTER REJECT  0      │
│  canary state  a8f3…e411  →  a8f3…e411   (unchanged)           │
├─ TAPE ────────────────────────────────────────────────────────┤
│ 15:58:02.114  E1  TLS_BINDING_MISMATCH   1.9ms   a8f3…=a8f3…   │
│ 15:58:03.402  E5  HOLDER_UNAUTHORIZED    1.2ms   a8f3…=a8f3…   │
├─ LATENCY (server-measured, this run only) ────────────────────┤
│  p50 NOT MEASURED   p99 NOT MEASURED   (n=0)                   │
└───────────────────────────────────────────────────────────────┘
```
숫자는 스트림에서 읽은 것만. 응답 없는 케이스는 `UNKNOWN`. 지연은 서버 `latency_us` 실측치 누적 후에만 p50/p99 표시.

### 2.5 테스트·배포
- jest: 사유코드 8개 각 1케이스 + 불변식(거부 시 해시 동일) 1케이스 — `__tests__/gated_action_v2.test.ts`
- `scripts/tls_v2_integration.mjs`를 확장해 E1~E7 루프백 자동 리허설(`GATED_ACTION_REHEARSAL_PASS` 한 줄)
- Dockerfile: HEALTHCHECK를 `https://localhost:${PORT}/health`(rejectUnauthorized false)로, `FREE_TIER_LIMIT` env 노출
- 컨테이너 재기동: `--restart unless-stopped`, `FREE_TIER_LIMIT=100000`, `TTTPS_TRUSTED_HOLDERS=<BobPub>`, 새 cert
- npm 0.4.1 publish는 시연 **후** 또는 Jay 별도 승인(시연은 서버 dist로 충분)

## 3. 접속 경로 결정(Jay 결정 필요)

| 옵션 | 장점 | 필요 승인/작업 |
|---|---|---|
| A. 서버 8443 공개 | 관객이 진짜 운영 호스트를 공격, "프로덕션" 문장이 참 | GCP 방화벽 8443 개방(이 박스 gcloud 미로그인 → 콘솔) · 실도메인 cert(§1 자체서명은 오늘밤 만료) · 레이트리밋 상향 |
| B. 노트북 로컬 | 네트워크 리스크 0, 관객은 같은 코드에 로컬 접속 | 없음. "프로덕션 코드·프로덕션 플래그"는 참, "프로덕션 호스트"는 아님 |
| 권장 | **A 준비 + B 폴백** 둘 다 같은 스크립트 | — |

## 4. 타입폼 문구 Claims Ledger (문서 추가분 대조)

| 문구 | 판정 | 처리 |
|---|---|---|
| TLS 1.3 RFC 5705 session binding · atomic replay ledger · fail-closed | [MEASURED] 코드·라이브 리허설 | 유지 |
| 1-byte payload mutation → hash failure | [MEASURED] 옥텟 0-79 SHA-256 + jest mutation 테스트 | 유지("Lean" 수식어 제거) |
| **Lean 4 formal proofs (sorryAx: 0)** | [REMOVE] v2 레코드 전용 Lean 파일 0건. 인접 파일(QEd24WireFormat 등)은 sorry 포함 | 삭제. 오늘 LEAN-BIND로 레이아웃 원자(180=80+32+4+64, 오프셋 비중첩) decidable 증명 만들면 "layout invariants machine-checked"로만 |
| **sub-millisecond** | [TARGET] 미측정 | 워룸 실측 p50/p99 나온 뒤에만. 그 전 문구는 "server-measured latency shown live" |
| "guarantees zero state mutation … before unverified tool calls reach MCP servers" | [REMOVE] 현재 0.4.0엔 작업 게이트가 없다 | §2.1 구현·불변식 테스트 PASS 후 "rejected requests leave protected state unchanged (hash-verified live)" |
| "hardened security proxy for MCP tool execution" | [REMOVE] 프록시 아님, MCP 서버 내 툴 | "MCP server with a cryptographic action gate" |

## 5. 순서와 시간(추정, [TARGET])

1. 승인 → §2.1 툴 + jest (60분)  2. Bob/Eve 스크립트 + 루프백 리허설 (45분)  3. 워룸 (30분)
4. Dockerfile·컨테이너 재기동·8443 라이브 리허설 (20분, 배포 승인)  5. 타입폼 문구 교정본 전달 (10분)

## 6. Jay에게 필요한 답 (한 번에)
1. 시연 시각과 장소 네트워크(관객이 외부 IP:8443 접속 가능한가) → 옵션 A/B
2. §2 설계 승인(툴 이름·사유코드·env 이름 포함) — 승인 즉시 착수
3. 배포 경계: 컨테이너 재기동 + (A면) 방화벽 8443 개방 + 실도메인 cert 승인
4. npm 0.4.1 publish는 시연 후로 미룸(동의?)
5. Codex 로그에 npm 우회 토큰 원문 노출 → 시연 후 회전 권고

## 7. 제미니 문서 차용 판정 (1T_7UWgNY…, 15:52 KST 대조)

**코드는 0줄 차용.** 이유(원문 대조 [MEASURED]):
- `generate_bob_token.mjs`: 프레임 레이아웃이 draft-11과 다르다(버전 2옥텟 `0x000b`, nonce 12옥텟, "bob@kenosian.com" 문자열 identity). 실제 `pot_record_v2.ts`는 version 1옥텟·nonce 16·holder_auth_data 32·SHA-256 무결성·Ed25519 issuer 서명. 이 프레임은 진짜 `pot_verify_v2`에 넣으면 `rejected`.
- "TLS 바인딩" = `sha256("TLS13_EXPORTER_SESSION_BOB_SECRET_KEY")` 상수. exporter 아님.
- 세션탈취 판정 = `clientIp !== "127.0.0.1"`. 암호학 아님.
- `ENGINE LATENCY 0.001 ms`, `sorryAx: 0`, `BLOCKED (100.0%)` 기본값 — 전부 하드코딩(측정 없음).
- replay 원장 = 프로세스 내 `Set`. Redis 원자 claim 아님. 패키지 import 0건.

**차용하는 것(운영 구조):**
| 항목 | 채택 형태 |
|---|---|
| 좌/우 2화면 — 좌 워룸, 우 "참가자 타격 가이드" | 채택. 우측 가이드는 §8 형식으로 다시 씀(진짜 엔드포인트·진짜 레코드·진짜 툴 호출) |
| 코디네이터 구두 멘트("3분 라이브 침투 챌린지 피칭 시간") | 채택, 문구는 Claims Ledger 통과본으로 |
| 공격 3종 메뉴(세션탈취·재전송·1옥텟 변조)로 관객 진입장벽 낮추기 | 채택 + E5(자기 키 발급)를 4번째 "고급" 공격으로 |
| ANSI 컬러 대시보드·큰 숫자·실시간 테이프 | 채택. 단 숫자는 스트림 실측만, 지연은 n≥1 이후 |
| 타임라인 15:00 셋업 / 16:30-18:30 챌린지 | **확인 필요** — 이게 오늘 실제 일정이면 §9 티어로 간다 |

## 8. 우측 화면 "타격 가이드" (진짜 엔드포인트 버전, 초안)
```
  @helm-protocol/ttt-mcp@0.4.0  ·  LIVE GATE CHALLENGE
  Target : https://api.kenosian.com:8443/mcp   (TLS 1.3 only, real cert)
  Tool   : pot_verify_v2   (MCP JSON-RPC tools/call)
  Bob's used record (hex, 360 chars) : <BOB_RECORD_HEX>
  Bob's used binding proof (hex)     : <BOB_PROOF_HEX>
  1) Session hijack : submit Bob's record+proof from YOUR machine        → expect TLS binding reject
  2) Replay         : Bob re-submits on his own live connection         → expect "replay detected"
  3) Tamper         : flip any one hex pair in the record, resubmit      → expect "integrity mismatch"
  4) Advanced       : mint your own record via pot_generate_v2 + bind it → (Tier 2 only) HOLDER_UNAUTHORIZED
  Screen shows the server's actual verdict JSON. Nothing is simulated.
```
관객용 `npx`/`curl` 한 줄 클라이언트(`scripts/eve_attacks.mjs`)가 TLS 연결·JSON-RPC 포장을 대신한다(curl 단독으로는 MCP 세션 초기화가 번거롭다).

## 9. 시간 티어 (16:30 KST 창이 실제라면)

| 티어 | 내용 | 새 코드 | 16:30 가능? |
|---|---|---|---|
| **T1 (오늘 확정 가능)** | 진짜 서버 `pot_verify_v2`에 대한 공격 1·2·3 라이브 + 워룸(서버 응답 실측 표시) + Bob 클라이언트(진짜 exporter proof) | Bob/Eve 클라이언트·워룸 스크립트만(패키지 무변경) | 예(스크립트 3개, ~60분) — 16:30엔 빠듯, 17:00 안정 |
| **T2** | `pot_gated_action_v2` 권한경계·작업결속·서버시간·canary 해시 불변식(§2.1) | tools.ts/index.ts + jest | 아니오. 시연 중 백그라운드 구현 → 18:00 전 라이브 전환 시도 |
| T3 | Dockerfile 헬스체크·컨테이너 재기동·실도메인 cert·방화벽 | 배포(승인) | T1과 동시(20분), 승인 즉시 |

T1에서 정직하게 말할 수 있는 것: "record integrity · issuer signature · TLS 1.3 channel binding · replay ledger, all enforced by the published package on a live host."
T1에서 말하면 안 되는 것: DB 방어·권한·zero-mutation(T2 전), sub-ms(측정 전), Lean(파일 없음).

### 7.1 제미니 문서 후반부 추가 판정
- 18:30 발표 스크립트의 "차단율 100%, 평균 지연 0.001ms, 상태 변이 0바이트, Lean 4 sorryAx: 0" → 전부 [REMOVE]. 대체: 워룸이 그 시점에 실제로 보여주는 숫자만 읽는다("지금 화면의 거부 N건, 승인 1건, 거부 후 상태 해시 불변 — 전부 서버 응답 그대로").
- 19:30 IETF 메일(Lars 스레드 "Verifiable / Attestation vs Recomputation") → 시연과 별건. 문구는 나쁘지 않으나 발송은 Jay 결정(R10③). 계획서 범위 밖.
