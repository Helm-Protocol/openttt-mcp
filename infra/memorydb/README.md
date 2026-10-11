# MemoryDB onboarding preparation

No AWS resource is created by these files. `enabled` defaults to false.
Do not run `terraform apply`, buy reserved nodes, create secrets or deploy paid networking before client onboarding.
The production backend is customer-account MemoryDB. Local stores and isolated Redis are development only.

## Components prepared

- `demo/memorydb_replay.mjs`: explicit lazy cluster connection, TLS certificate validation,
  primary command routing, atomic SET NX PX, no offline queue or local fallback.
- `rust-reference/src/replay.rs`: typed atomic local claim contract and shared freshness/TTL calculation.
  Local claims are process-local development facilities, not production restart guarantees.
- `main.tf`: opt-in MemoryDB cluster referencing existing customer private subnets, security groups,
  reviewed ACL and a noeviction parameter group. No credentials are embedded or output.

## Production admission contract

Authenticate and validate the exact record, holder, direction, action and real exporter first.
Obtain replay lifetime from the same freshness policy. Derive a domain from trusted tenant + full issuer identity;
never let the request choose a new domain to evade replay state. Pass decoded context/nonce and lifetime to claim.
A new claim permits the application's idempotent effect workflow; already_seen denies replay.
Store unavailable / response unknown returns a service error without performing the effect.
Do not delete or retry a possibly successful claim to make a request pass.

This adapter is intentionally not activated in the in-memory canary: that would not demonstrate
cross-node durable business commitment. The client application must supply its transactional/idempotency boundary.
Before connecting production traffic, verify the server's noeviction policy, TTL policy, trust domain,
failover behavior, timeouts, business commit recovery, live-claim transfer and rollback.
Regional shared state is not a promise of atomic multi-region claims.

## Onboarding only

1. Choose the customer's AWS region/account, private subnets across AZs, permissions, ACL credentials,
   node sizing, noeviction parameter group and KMS policy. Parameter group settings require runtime verification.
2. Review a plan with enabled=true. Cluster creation is paid even with no requests.
3. Supply credentials through the customer's secret delivery mechanism; connect explicitly.
4. Run bounded real MemoryDB failover/concurrency/ambiguous-response verification and application commit recovery.
5. Drain/transfer all live claims before routing traffic. Do not rely on an environment-variable flip alone.

No Terraform validation or actual MemoryDB integration is claimed by the presence of these templates.
