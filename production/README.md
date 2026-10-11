# Customer-local 180B v2 service

This extends the existing OpenTTT AMI. It preserves `openttt-server.service`,
its signer and its local storage, and adds `openttt-v2.service` on TLS TCP8090.
The new API handles real customer event bytes rather than the canary accounts.
The existing 143B routes are not migrated or padded into v2. Restrict legacy
8082/TCP and 8443/UDP to loopback/maintenance; the default new delivery exposes
only 8090/TCP to approved private client CIDRs plus administrative SSH.

## Security and operating boundary

- Native Rust validates 180B layout, issuer signature, event context, freshness
  and Ed25519 holder proof. Node terminates actual TLS1.3 and supplies its exporter
  only through private pipes. No exporter HTTP header is accepted.
- `event_b64` is canonical base64 of opaque event bytes (maximum32768 bytes).
  Its SHA256 prefix16 is the signed context ID. Full event/record SHA256 digests
  are included in the signed admission receipt. This profile deliberately binds
  exact bytes, not natural-language meaning or arbitrary JSON canonicalization.
- `/v2/seal` requires the per-instance admin bearer token; it signs a record for
  the supplied32-byte Ed25519 holder public key. The issuer remains customer-local.
  No public demo issuance route or canary DB exists in this service.
- `/v2/verify` requires a holder signature using the live direction0 exporter.
  The caller sends event bytes, `record_hex`, and `binding_proof`.
- SQLite WAL with `synchronous=FULL` claims a domain/context/nonce atomically
  with the signed receipt before responding. It survives process/instance restart.
  It is a single-node backend, not shared cluster replay protection. Do not clone
  a configured gateway with the same identity across independent stores.
- The receipt ID must be unique in the customer's application transaction.
  The service cannot atomically commit an arbitrary external business database.
  A lost response may consume a nonce; reissue only under application idempotency
  policy. Local receipts are retained in `admission.sqlite` for administrative
  recovery. The nonce index expires only after the signed validity window plus
  safety margin; the persisted clock high-water mark rejects backward steps.
  Receipts are retained separately. Never delete state with live signed tokens.
- The service reads Linux `CLOCK_TAI` and refuses admission if its TAI offset is
  not configured. It requires a synchronized chrony source with a recent tracking
  sample and derives dispersion from root delay, root dispersion and system offset
  (maximum1000us for this fixed profile). Configure chrony/leap information and validate the time source
  in the customer environment. This is not a Roughtime quorum implementation.
  Leap-smearing time sources cannot establish true TAI during their smear window;
  configure a non-smearing source for continuous TAI operation across leap events.
- L4 generic XDP rate limits IPv4 TCP8090/8443. It does not verify encrypted TLS,
  guarantee an exact multicore packet rate, cover IPv6, or stop volumetric DDoS.
- TLS certificates and sealing credentials are generated per instance. Replace
  the initial self-signed certificate with a customer certificate or pin it via
  an authenticated administrative channel before sending events. Use direct TLS
  termination or an L4 TCP passthrough; L7 exporter header delegation is unsupported.
- No MemoryDB provisioning, central-server dependency, or customer telemetry export.

## Administration

Use SSH with the launch key or customer-provisioned SSM permissions. Read the
sealing token only in that authenticated session (`sudo cat /var/lib/openttt/v2/seal-token`),
store it in the customer's secret manager, and never send it to the vendor.
Set customer configuration in `/etc/openttt/v2/service.env`, then restart
`openttt-v2.service`. The defaults use `/etc/openttt/v2/tls.crt` and `tls.key`.
Health: `GET https://<private-instance>:8090/health`. Issuer: `GET /v2/issuer`.
Legacy requests to `/v1/legacy` or `seal_143b` on the new gate return410.

Back up the signer, TLS identity and SQLite database using SQLite's backup API,
not a live partial copy of its main file. Restore the same signer and replay
database together. For multi-node customer deployment, use the separately
prepared MemoryDB integration and customer business idempotency design; it is
not enabled or billed by this AMI update.

## Marketplace usage and customer IAM

Each successful v2 seal durably records one metered unit before acknowledgement.
`openttt-v2-metering.service` reports closed UTC hourly buckets for the existing
product code and the current t3.micro/t3.small/t3.medium dimension. It uses only
the customer's EC2 instance IAM role (`aws-marketplace:MeterUsage`) and checks
subscription/permissions with a zero-quantity DryRun. Network/IAM failures keep
the same counts for retry; records older than the API's six-hour reporting limit
are retained for reconciliation. Monitor the unit journal; offline verification
still works, but Marketplace usage reporting requires access to AWS endpoints.
The signer, local admission and replay remain independent of that network path.
No seller keys, new AWS resources or MemoryDB are installed. Paid MeterUsage
cannot be demonstrated on an un-ingested seller image; buyer billing requires
Marketplace ingestion, a subscribed buyer launch and its instance role.
