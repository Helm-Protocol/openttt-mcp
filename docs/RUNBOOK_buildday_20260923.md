# RUNBOOK — Build Day "Bob vs Eve" live challenge (Tier 1)
Status 2026-09-23 16:14 KST: **T1 code done, committed 0493907, pushed. Canary restarted & healthy.**

## What is live now [MEASURED]
- Container `openttt-mcp-canary` (image `openttt-mcp:draft11-v2`, host network, `--restart unless-stopped`) → **healthy**, `/health` = version 0.4.0.
- TLS: real Let's Encrypt cert `api.kenosian.com` (valid to 2026-12-10), mounted `/opt/buildday-tls`.
- Flags: `TTTPS_V2_REQUIRE_BINDING=1`, `TTTPS_REQUIRE_REPLAY_LEDGER=1`, `TTTPS_AUDIT_STREAM=tttps:audit:v2`, `FREE_TIER_LIMIT=100000`, Redis `127.0.0.1:6380`.
- Verified end to end against this canary: Bob intact + self-replay blocked; Eve hijack/tamper/forge blocked; gap intact; war room p50 6.6ms p99 8.6ms.

## Two screens
- LEFT (war room): `REDIS_URL=redis://127.0.0.1:6380 node scripts/war_room.mjs --stream tttps:audit:v2`
- RIGHT (audience guide): show `/tmp/buildday/bob_used.json` record+proof + the attack menu below.

## Run order on the day
1. Reset baseline (so counters start clean):
   `redis-cli -p 6380 DEL tttps:audit:v2; redis-cli -p 6380 --scan --pattern 'tttps:v2:replay:*' | xargs -r redis-cli -p 6380 DEL`
2. Start LEFT war room (stays running).
3. Bob's one legit action (publishes the used record+proof to the audience):
   `node scripts/bob_client.mjs --host 127.0.0.1 --port 8443 --insecure`
   (external attacker box: `--host api.kenosian.com --port 8443`, no `--insecure` — real cert)
4. Audience attacks (each hits the real canary; war room shows the real verdict):
   `node scripts/eve_attacks.mjs --host api.kenosian.com --port 8443 --only hijack`
   attacks: `hijack` (cross-session), `tamper` (1-octet), `forge` (own issuer key).
   Bob replay demo: `node scripts/bob_client.mjs ... --replay`.
5. Honest Tier-1 hole (optional, drives the Tier-2 pitch): `node scripts/eve_attacks.mjs ... --only gap`.

## What is true to say (Tier 1)
Record integrity, issuer signature, TLS 1.3 channel binding, and replay ledger are enforced
by the published 0.4.0 package on a live host; every number on screen is the server's own verdict/latency.

## What NOT to say (until Tier 2 lands)
DB protection, authorization, "zero mutation", "sub-millisecond" (measured 2–23ms), "Lean sorryAx:0"
(no Lean file for the v2 record). The `--gap` attack proves the authorization gap is real.

## BLOCKER for option A (external audience over the internet) — needs Jay
Port 8443 ingress is NOT open at the GCP firewall (this box has no gcloud login; account axcpeter@gmail.com).
Open it in the GCP console: allow tcp:8443 to this instance (35.208.129.147), ideally source-scoped to the venue.
Until then only option B (same-LAN / localhost `--insecure`) works. DNS api.kenosian.com already → 35.208.129.147.

## Rollback
`sudo docker restart openttt-mcp-canary` (same image). Prior image tag unchanged; git revert 0493907 restores pre-demo server.
