# 🔥 TTT-MCP를 뚫어라 — LIVE CHALLENGE (2026-09-23)
Target: https://api.kenosian.com:8443/mcp  ·  TLS 1.3 only, real cert  ·  npm @helm-protocol/ttt-mcp@0.4.3

Bob(정상 에이전트)이 방금 정식 요청 1건을 통과시켰습니다. 그가 쓴 레코드와 proof를 공개합니다.
여러분의 에이전트/TLS 세션에서 다시 제출해 게이트를 뚫어보세요. 화면(좌측 워룸)에는 서버의 실제 판정만 뜹니다.

## 공개된 Bob의 사용 완료 증거
- record (hex, 360자): <BOB_RECORD_HEX>
- binding proof (hex): <BOB_PROOF_HEX>
  (bob_used.json 에 자동 기록 — 시연 직전 `node scripts/bob_client.mjs --host api.kenosian.com --port 8443` 로 새로 발급)

## 공격 메뉴 (각각 실제 서버 판정이 좌측에 찍힙니다)
```
# 1) 세션 탈취 — 다른 TLS 세션에서 Bob의 record+proof 재사용
node scripts/eve_attacks.mjs --host api.kenosian.com --port 8443 --only hijack     # 기대: TLS exporter holder proof mismatch

# 2) 1옥텟 변조 — 레코드 한 바이트 뒤집기
node scripts/eve_attacks.mjs --host api.kenosian.com --port 8443 --only tamper     # 기대: integrity mismatch

# 3) 발급자 위조 — 공격자 자기 issuer 키로 서명
node scripts/eve_attacks.mjs --host api.kenosian.com --port 8443 --only forge      # 기대: issuer signature invalid

# 4) 오래된 토큰 — 1시간 전 타임스탬프
node scripts/eve_attacks.mjs --host api.kenosian.com --port 8443 --only stale      # 기대: freshness window exceeded

# 5) 미인가 신원(Sybil) — 공격자 자기 holder 키
node scripts/eve_attacks.mjs --host api.kenosian.com --port 8443 --only holder     # 기대: holder not authorized

# 6) 재전송 — Bob 동일 연결에서 같은 토큰 두 번
node scripts/bob_client.mjs --host api.kenosian.com --port 8443 --replay           # 기대: replay detected
```
curl로도 됩니다(바인딩 proof 없으면 즉시 거부):
```
curl -k --tlsv1.3 -X POST https://api.kenosian.com:8443/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"pot_verify_v2","arguments":{"potRecordV2":"<BOB_RECORD_HEX>"}}}'
# 기대: "TLS exporter binding proof is required"
```

## 발표 펀치라인 (정직판)
"에이전트의 말을 믿고 도구를 실행하지 않습니다. 실행 전에 서명·시간·세션·재사용을 검증하고,
통과한 요청만 다음 단계로 보냅니다. 오늘 여러분이 직접 그 경계를 시험해 주세요."

## 워룸엔 이것만 (과장 금지)
- 요청별: 판정 사유 · 서버측 지연(실측 ~2-70ms) · record sha16 · nonce.
- 쓰지 말 것: "0.001ms", "DB 오염 0"(별도 action-gate/DB 배선 후에만), "13종 100%".
- 정직 경계: 토큰 바이트/세션/시간/발급자/재사용은 라이브 방어됨. **도구 인자(송금액·대상) 변조**는
  별도 action-binding(ctx_id↔요청 해시) 계층이며 이번 범위에 미포함 — 그 공격은 "다음 계층"으로 소개.
- 볼류메트릭 DDoS는 인프라 계층(게이트는 분당 429까지).
