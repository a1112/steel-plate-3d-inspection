# Runtime contracts

This directory is the language-neutral boundary between acquisition, image,
defect, business and artifact processes. JSON schemas are additive and are
versioned independently from executable names. Large capture data never enters
these JSON messages; contracts carry immutable artifact references and hashes.

Bindings:

- Rust: `app/runtime-contract`
- Python: `packages/contracts/python/steel_runtime_contracts.py`
- JSON Schema: `packages/contracts/schemas`
