# Article 50(2) AI Act — Technical Compliance Statement

**Provider**: Kenosian LLC (operating as Helm Protocol)  
**Contact**: peter@kenosian.com  
**Protocol**: Trusted Time Token Protocol Specification (TTTPS), draft-helmprotocol-tttps  
**Implementation**: [@helm-protocol/ttt-mcp](https://github.com/Helm-Protocol/openttt-mcp)  
**IETF status**: Independent Submission Editor (ISE) review — draft-helmprotocol-tttps-07

---

## §1. Role and Scope

Kenosian LLC is a **third-party provider of content provenance infrastructure**, not a provider of a generative AI system. Our role is analogous to a Certificate Authority in the TLS/PKI ecosystem: we provide the cryptographic infrastructure that makes AI-generated content verifiably attributable in time, without operating the content-generating system itself.

The Code of Practice on Transparency of AI-Generated Content (FAQ, Section 1) identifies as eligible signatories "Technology providers of marking and detection solutions, who develop or have developed technical tools, services or infrastructure for the marking, provenance, watermarking and/or detection of AI-generated or manipulated content." TTTPS addresses the **provenance** category: external, machine-readable time-attestation records.

---

## §2. Article 50(2) Criterion Mapping

> **NOTE — scope of this document.**
> This describes the record as published in draft-helmprotocol-tttps-07
> (26 July 2026): a signed time attestation bound to session credentials.
> It does not describe binding to a content digest, and must not be cited
> as evidence of content marking. A revision adding a Payload Digest field
> is in preparation; update this note when that revision is live.

Article 50(2) of the AI Act requires that marking measures be **effective, interoperable, robust, and reliable** as far as technically feasible.

### §2.1 Effective

A TTTPS Proof-of-Time (PoT) record provides tamper-evident temporal attestation. The 180-octet PoT Record v2 binds a holder's TLS session credentials (ctx\_id, nonce, holder\_auth\_data) to a cryptographically verifiable multi-source timestamp (ts, dispersion). The record's integrity is protected by an integrity\_tag computed over the record's own header (octets 0–79), ensuring the record cannot be modified after issuance.

This creates a machine-readable attestation that a specific AI system session existed at a verifiable point in time. The PoT record is independently verifiable: any downstream party can query the TTTPS attestation log with the record's ctx\_id to confirm the timestamp and holder binding.

Limitation: The published specification (draft-helmprotocol-tttps-07) attests TLS **session credentials**, not content bytes. Binding a PoT record to a specific content artefact requires the calling application to include a content identifier (such as a hash) in the ctx\_id or holder\_auth\_data field, using application-layer conventions. A future revision of the specification is expected to standardise a Payload Digest field for explicit content binding.

### §2.2 Interoperable

TTTPS is specified as an IETF Internet-Draft under the Independent Submission Editor track. The protocol:

- uses standard TLS 1.3 as the transport layer
- uses SHA-256 and HMAC-SHA256 for content binding (mandatory-to-implement)
- exposes a JSON-over-HTTPS verification interface
- is implemented as an open Model Context Protocol (MCP) server with a published npm package

The MCP server interface allows any MCP-compatible AI system to generate and query PoT records without proprietary integration.

### §2.3 Robust

TTTPS's primary design contribution relative to in-file metadata formats (such as C2PA manifests) is **robustness across content distribution channels**.

In-file metadata is routinely stripped or corrupted during:
- screenshot or screen-recording capture
- video transcoding and format conversion
- social media upload and re-encoding
- image compression and format normalization

A TTTPS PoT record is an **external cryptographic anchor** stored independently of the content file. Because the PoT record is not embedded in the content, it is not subject to the stripping that affects in-file metadata. Verification requires only the content bytes (to recompute the hash) and a query to the TTTPS attestation log — neither of which depends on the content container format.

### §2.4 Reliable

TTTPS timestamps are derived from multiple independent time sources using Byzantine fault-tolerant aggregation. A single compromised time source cannot alter the attested timestamp. The protocol is designed to detect timestamp manipulation by infrastructure operators (NTP servers, BGP routers, DNS resolvers) — a threat class documented in the IETF draft as the "Strategic Channel Controller Problem."

IETF experimental deployment has produced over 70,000 attested records, providing a basis for evaluating system reliability under real-world conditions.

---

## §3. Technical Scope and Limitations

This section documents what TTTPS does **not** provide, to support accurate assessment.

**TTTPS does not perform perceptual watermarking.** A TTTPS PoT record binds a cryptographic hash of the content at attestation time. If the content bytes change after attestation (e.g., through re-encoding, compression, or any modification), the hash will not match and the original PoT record will not verify against the modified content. TTTPS addresses provenance of an **exact byte sequence**, not perceptual similarity.

**TTTPS does not identify the generating AI system.** The PoT record attests the hash and timestamp of a content record submitted by a caller. The caller is identified only by their API key. TTTPS does not embed AI system identity, model name, or provider name in the PoT record itself.

**TTTPS does not provide perceptible markings.** There is no visible or audible mark on content. The attestation is external and requires an active verification query.

These limitations are intentional architectural choices: the design prioritises robustness and privacy-by-design (PoT records contain no content and no personal identifiers) over comprehensiveness.

---

## §4. Implementation

The reference implementation is the `@helm-protocol/ttt-mcp` MCP server (GitHub: Helm-Protocol/openttt-mcp). It provides:

- `pot_generate`: generates a PoT record binding a content hash to a multi-source timestamp
- `pot_verify`: verifies a PoT record against the attestation log
- `pot_query`: retrieves attestation records by event ID

The package is distributed via npm and is compatible with any MCP-capable host application.

**Licence**: Business Source License 1.1 (BSL-1.1), converting to Apache 2.0 on 2029-05-28. The BSL-1.1 licence permits use, modification, and redistribution for non-production and evaluation purposes; production use is subject to the licence terms.

---

## §5. Standards and Specification

| Document | Status |
|---|---|
| draft-helmprotocol-tttps-07 | IETF ISE review (as of 2026-07-26) |
| Content binding | SHA-256 + HMAC-SHA256 |
| Transport | TLS 1.3 |
| Time aggregation | Multi-source Byzantine fault-tolerant |

---

## §6. Independent Verification Procedure

To verify the claims in this document without contacting Kenosian LLC:

1. **IETF draft**: Access draft-helmprotocol-tttps-07 directly at `https://datatracker.ietf.org/doc/draft-helmprotocol-tttps/`
2. **Implementation**: The MCP server source code is available at `https://github.com/Helm-Protocol/openttt-mcp`
3. **npm package**: The package is published at `https://www.npmjs.com/package/@helm-protocol/ttt-mcp` (or the scoped equivalent)
4. **Attestation log**: PoT records can be independently queried via the public verification endpoint documented in the IETF draft
5. **EU AI Act section**: This repository's README includes an "EU AI Act Art. 50" section at `https://github.com/Helm-Protocol/openttt-mcp#eu-ai-act-art-50--ai-generated-content-transparency`

---

*Last updated: 2026-07-29*
