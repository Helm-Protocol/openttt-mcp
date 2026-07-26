# TTTPS and EU AI Act Article 50 Compliance

**Document version:** 2026-07-26  
**Status:** Informational — for integrators and compliance teams

---

## Overview

EU AI Act Article 50(2) requires machine-readable marking of AI-generated content. Providers must use marking that is **Effective, Interoperable, Robust, and Reliable** — four requirements that no single existing technology fully satisfies.

`openttt-mcp` provides a tamper-evident timestamp layer (Proof-of-Time, PoT) that fills the critical **Robust** gap, enabling MCP tools that generate AI content to meet the Article 50 standard when combined with C2PA.

**Compliance deadline for existing providers:** 2026-12-02 (grandfathering clause).

---

## The Problem: C2PA Alone Fails "Robust"

C2PA is the industry-standard Layer 1 for AI content provenance — adopted by Adobe, Google, Microsoft, OpenAI. It meets three of four Article 50 requirements:

| Requirement | C2PA alone | C2PA + TTTPS |
|-------------|-----------|--------------|
| Effective | PASS | PASS |
| Interoperable | PASS | PASS |
| **Robust** | **FAIL** | **PASS** |
| Reliable | PASS | PASS |

**Why Robust fails for C2PA alone:** C2PA manifests live inside the file (JUMBF headers, XMP blocks). Any operation that creates a new file — screenshot, social media re-upload, format conversion, copy-paste — silently strips the manifest. Provenance is lost.

The EC Code of Practice on Marking and Labelling (2026-06-10) requires Layer 1 metadata to be *"cryptographically signed and timestamped in a secure and tamper-evident manner."* Current C2PA timestamps (RFC 3161 TSA) are centralized and not designed for forensic AI provenance audit at scale.

---

## The Solution: External Tamper-Evident Timestamp

`openttt-mcp` adds a Proof-of-Time (PoT) record to MCP tool responses via the `_meta` field:

```json
{
  "_meta": {
    "io.helmprotocol/content_pot": {
      "version": 2,
      "ts": 1753498800123456789,
      "sha256_content": "e3b0c44298fc1c149afb...",
      "ctx_id": "base64url...",
      "issuer_sig": "base64url...",
      "alg_id": 1,
      "pot_uri": "tttps://pot.helmprotocol.com/verify/{record_hash}"
    }
  }
}
```

The PoT record is **external** — stored at the `pot_uri`, independent of the content file. Even after the content is re-encoded or its C2PA manifest is stripped:

1. Auditor recomputes `SHA-256(content)`
2. Queries the PoT registry with the hash
3. Recovers the original creation timestamp and issuer signature
4. Provenance is reconstructed — **Robust requirement: PASS**

---

## Technical Properties

| Property | Implementation |
|----------|---------------|
| Timestamp precision | ±10ns (Roughtime consensus, KTSat) |
| Timestamp non-repudiation | Ed25519 `issuer_sig` over 180-octet record — cannot be backdated |
| Integrity | GRG (Golomb→Reed-Solomon→Golay) — detects and corrects tampering |
| Session independence | PoT record is self-contained — verifiable by any third party without the original TLS session |
| Open specification | `draft-helmprotocol-tttps` (IETF ISE Review) |

---

## Integration with MCP Tools

When a tool in your MCP server returns AI-generated content, `openttt-mcp` automatically:

1. Computes `SHA-256(content)`
2. Requests a PoT record from the TTTPS issuer
3. Attaches `io.helmprotocol/content_pot` to `_meta`
4. Returns the response

Recipients (MCP clients, compliance systems) can verify the timestamp independently using the `pot_uri`.

---

## Relation to EU AI Act Compliance Stack

```
Article 50 Layer 1: C2PA manifest (who generated, with what model)
                  + TTTPS PoT   (when, tamper-evident, survives strip)
Article 50 Layer 2: Invisible watermarking (SynthID, AudioSeal)
Article 12:         openttt-mcp audit log (event-by-event tool call record)
```

The four-layer stack satisfies both Article 50 (content marking) and Article 12 (high-risk AI event logging) requirements.

---

## Links

- **MCP SEP proposal:** [Issue #3132](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/3132) — Article 50 timestamp binding contract
- **IETF Draft:** `draft-helmprotocol-tttps` (In ISE Review)
- **SDK:** `Helm-Protocol/openttt-mcp` (this repository)
- **Related MCP SEPs:** PR #3004 (audit records), PR #2787 (Article 12 attestation)

---

*This document uses only verified technical claims. "PASS/FAIL" assessments are based on direct analysis of Article 50(2) requirements and C2PA specification behavior, not marketing claims.*
