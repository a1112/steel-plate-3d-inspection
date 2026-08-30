# Runtime contracts

This directory is the language-neutral boundary between acquisition, image,
defect, business and artifact processes. JSON schemas are additive and are
versioned independently from executable names. Large capture data never enters
these JSON messages; contracts carry immutable artifact references and hashes.

Bindings:

- Rust: `app/runtime-contract`
- Python: `packages/contracts/python/steel_runtime_contracts.py`
- JSON Schema: `packages/contracts/schemas`

## Offline algorithm evidence contracts

The following strict Draft 2020-12 schemas define offline qualification and
performance evidence. They are not runtime HTTP payloads and do not by
themselves grant production admission:

- `steel.reproduction-manifest.v1`
- `steel.algorithm-dataset.v1`
- `steel.defect-annotation.v1`
- `steel.algorithm-benchmark.v1`
- `steel.algorithm-dataset-validation.v1`

`steel.algorithm-dataset.v1.manifestSha256` is the lowercase SHA-256 of UTF-8
JSON serialized with keys sorted, no insignificant whitespace, non-ASCII text
preserved, non-finite numbers forbidden, and the top-level
`manifestSha256` field removed. The validator also records the SHA-256 of the
exact manifest file bytes in its output, so canonical identity and transported
file identity remain independently auditable.

Validate a frozen dataset without mutating any source asset:

```powershell
python scripts/validate_algorithm_dataset.py `
  --manifest D:\evidence\dataset.json `
  --data-root D:\evidence `
  --purpose qualification `
  --output D:\evidence\reports\dataset-validation.json
```

The command returns non-zero for malformed contracts, missing/unsafe paths,
hash or size mismatches, split leakage, non-adjudicated qualification labels,
unknown taxonomy, invalid geometry/units/statistics, and blocked or
out-of-scope licenses. A passing validation report is an input to evaluation;
it is not a substitute for real metrics or the two-owner
`steel.algorithm-acceptance.v1` approval.
