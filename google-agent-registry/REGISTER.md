# Google Agent Registry 등록 가이드

## 사전 조건
1. Google Cloud 프로젝트 설정
2. `gcloud auth login`
3. IAM 역할: `roles/agentregistry.editor`
4. ttt-mcp HTTP 엔드포인트 실행 중 (PORT=8900)

## 등록 명령어

```bash
# API 활성화
gcloud services enable agentregistry.googleapis.com --project=PROJECT_ID

# MCP 서버 등록
gcloud alpha agent-registry services create ttt-mcp \
  --project=PROJECT_ID \
  --location=us-central1 \
  --display-name="OpenTTT — Proof of Time" \
  --mcp-server-spec-type=tool-spec \
  --mcp-server-spec-content=google-agent-registry/toolspec.json \
  --interfaces=url=https://api.kenosian.com/mcp,protocolBinding=JSONRPC
```

## SERVER_URL 옵션
- 운영: `https://api.kenosian.com/mcp` (PORT=8900으로 배포 후)
- 테스트: `http://35.208.129.147:8900` (GCP VM 직접)
