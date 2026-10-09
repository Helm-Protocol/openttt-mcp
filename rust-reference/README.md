# Portable Draft-13 Rust reference

`cargo test --locked --manifest-path rust-reference/Cargo.toml`
checks the fixed 180-octet codec and both published Appendix B holder vectors.
`cargo run --locked --manifest-path rust-reference/Cargo.toml --bin export-vectors`
independently regenerates public fixture values.

The `openttt-draft13-reference` binary is a private verifier process launched by
the TLS gate. Its stdin is not a public network interface. Issuer and holder
authority are pinned at process startup; the request body cannot override them.
The TLS terminator supplies the live exporter. Public callers cannot choose it.
The application gate remains responsible for serialized replay claim and commit.
