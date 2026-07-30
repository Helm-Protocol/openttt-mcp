# Article 50(2) AI Act — Technical Compliance Statement

**Provider**: Kenosian LLC (operating as Helm Protocol)  
**Contact**: peter@kenosian.com  
**Protocol**: Trusted Time Token Protocol Specification (TTTPS), draft-helmprotocol-tttps  
**Implementation**: [@helm-protocol/ttt-mcp](https://github.com/Helm-Protocol/openttt-mcp) v0.3.2  
**IETF status**: Independent Submission Editor (ISE) review — draft-helmprotocol-tttps-07; revision -08 in preparation

---

## §1. Role and Scope

Kenosian LLC is a **third-party provider of content provenance infrastructure**, not a provider of a generative AI system. Our role is analogous to a Certificate Authority in the TLS/PKI ecosystem: we provide the cryptographic infrastructure that makes AI-generated content verifiably attributable in time, without operating the content-generating system itself.

The Code of Practice on Transparency of AI-Generated Content (FAQ, Section 1) identifies as eligible signatories "Technology providers of marking and detection solutions, who develop or have developed technical tools, services or infrastructure for the marking, provenance, watermarking and/or detection of AI-generated or manipulated content." TTTPS addresses the **provenance** category: external, machine-readable time-attestation records.

---

## §2. Article 50(2) Criterion Mapping

> **NOTE — implementation status as of 2026-07-31.**
> Reference implementation v0.3.2 (released 2026-07-30) exposes a `contentDigest`
> parameter on `pot_generate`, accepting a caller-supplied SHA-256 hex digest.
> This digest is encoded in the Payload Digest field of the wire-format PoT Record v08
> (184 octets base / 216 octets with extensions), binding the attestation to a specific
> content artefact rather than only to TLS session credentials.
> The wire format and field definitions are specified in draft-helmprotocol-tttps-08,
> which is in preparation for submission to the IETF Independent Submission Editor track.
> The published ISE-reviewed specification remains draft-helmprotocol-tttps-07.

Article 50(2) of the AI Act requires that marking measures be **effective, interoperable, robust, and reliable** as far as technically feasible.

### §2.1 Effective

A TTTPS Proof-of-Time (PoT) record provides tamper-evident temporal attestation. As of v0.3.2, the `pot_generate` tool accepts a `contentDigest` parameter: a 64-character lowercase hexadecimal SHA-256 digest of the content to be attested. This digest is encoded in the Payload Digest field of the PoT Record v08 wire format, binding the attestation record directly to a specific content artefact.

The `pot_verify_v08` tool returns a `payloadDigestMatchesContent` boolean: when the caller supplies the original content and the PoT record, the tool independently recomputes the digest and confirms whether the attested digest matches. This creates a machine-readable, independently verifiable attestation that a specific content artefact existed at a verifiable point in time.

The record's integrity is protected by an integrity tag computed over the record header, ensuring the record cannot be modified after issuance.

### §2.2 Interoperable

TTTPS is specified as an IETF Internet-Draft under the Independent Submission Editor track. The protocol:

- uses standard TLS 1.3 as the transport layer
- uses SHA-256 for content binding and HMAC-SHA-256 for integrity (mandatory-to-implement)
- exposes a JSON-over-HTTPS verification interface
- is implemented as an open Model Context Protocol (MCP) server with a published npm package

The MCP server interface allows any MCP-compatible AI system — including systems built on Google ADK, Anthropic Claude, and other MCP-capable hosts — to generate and verify PoT records without proprietary integration.

### §2.3 Robust

TTTPS's primary design contribution relative to in-file metadata formats (such as C2PA manifests) is **robustness across content distribution channels**.

In-file metadata is routinely stripped or corrupted during:
- screenshot or screen-recording capture
- video transcoding and format conversion
- social media upload and re-encoding
- image compression and format normalization

A TTTPS PoT record is an **external cryptographic anchor** stored independently of the content file. Because the PoT record is not embedded in the content, it is not subject to the stripping that affects in-file metadata. Verification requires only the content bytes (to recompute the SHA-256 digest) and a query to the TTTPS attestation log — neither of which depends on the content container format.

### §2.4 Reliable

TTTPS timestamps are derived from multiple independent time sources using Byzantine fault-tolerant aggregation. A single compromised time source cannot alter the attested timestamp. The protocol is designed to detect timestamp manipulation by infrastructure operators (NTP servers, BGP routers, DNS resolvers) — a threat class documented in the IETF draft as the "Strategic Channel Controller Problem."

IETF experimental deployment has produced over 70,000 attested records, providing a basis for evaluating system reliability under real-world conditions.

---

## §3. Technical Scope and Limitations

This section documents what TTTPS does **not** provide, to support accurate assessment.

**TTTPS does not perform perceptual watermarking.** A TTTPS PoT record binds a SHA-256 hash of the content at attestation time. If the content bytes change after attestation (e.g., through re-encoding, compression, or any modification), the hash will not match and the original PoT record will not verify against the modified content. TTTPS addresses provenance of an **exact byte sequence**, not perceptual similarity.

**TTTPS does not identify the generating AI system.** The PoT record attests the hash and timestamp of a content record submitted by a caller. The caller is identified only by their API key. TTTPS does not embed AI system identity, model name, or provider name in the PoT record itself.

**TTTPS does not provide perceptible markings.** There is no visible or audible mark on content. The attestation is external and requires an active verification query.

These limitations are intentional architectural choices: the design prioritises robustness and privacy-by-design (PoT records contain no content and no personal identifiers) over comprehensiveness.

---

## §4. Implementation

The reference implementation is the `@helm-protocol/ttt-mcp` MCP server v0.3.2 (GitHub: Helm-Protocol/openttt-mcp). It provides:

- `pot_generate`: generates a PoT record. Accepts a `contentDigest` parameter (64-character lowercase hex SHA-256 digest of the content artefact), encoding the digest in the Payload Digest field of the PoT Record v08 wire format. Also accepts `eventId` (session-credential binding) and `txHash` (on-chain reference).
- `pot_verify`: verifies a PoT record against the attestation log (v07 wire format).
- `pot_verify_v08`: verifies a PoT Record v08; returns `payloadDigestMatchesContent: boolean` when content bytes are supplied.
- `pot_query`: retrieves attestation records by event ID.

The package is distributed via npm (`@helm-protocol/ttt-mcp`) and is compatible with any MCP-capable host application.

**Licence**: Business Source License 1.1 (BSL-1.1), converting to Apache 2.0 on 2029-05-28. The BSL-1.1 licence permits use, modification, and redistribution for non-production and evaluation purposes; production use is subject to the licence terms.

---

## §5. Standards and Specification

| Document | Status |
|---|---|
| draft-helmprotocol-tttps-07 | IETF ISE review (accepted 2026-07-26) |
| draft-helmprotocol-tttps-08 | In preparation; adds Payload Digest field (184/216 octet record) |
| @helm-protocol/ttt-mcp v0.3.2 | Published 2026-07-30; contentDigest parameter live |
| Content binding | SHA-256 (64-hex digest, mandatory-to-implement) |
| Transport | TLS 1.3 |
| Time aggregation | Multi-source Byzantine fault-tolerant |

---

## §6. Independent Verification Procedure

To verify the claims in this document without contacting Kenosian LLC:

1. **IETF draft**: Access draft-helmprotocol-tttps-07 at `https://datatracker.ietf.org/doc/draft-helmprotocol-tttps/`
2. **Implementation**: Source code at `https://github.com/Helm-Protocol/openttt-mcp`
3. **npm package**: `https://www.npmjs.com/package/@helm-protocol/ttt-mcp` — verify version 0.3.2 and the `contentDigest` parameter in the published package
4. **contentDigest verification**: Install v0.3.2, call `pot_generate` with a `contentDigest` argument; call `pot_verify_v08` with the returned record and original content bytes to confirm `payloadDigestMatchesContent: true`
5. **Attestation log**: PoT records can be independently queried via the public verification endpoint documented in the IETF draft

---

*Last updated: 2026-07-31*
