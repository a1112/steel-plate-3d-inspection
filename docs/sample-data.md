# Versioned sample data

The complete BKV `1908500` development dataset lives in the private
[`a1112/sample-data`](https://github.com/a1112/sample-data) repository. Source
code clones contain only a small frame-pair fixture under `test-fixtures/bkv`.

## Fetch and verify

Authenticate Git for the private repository, then run:

```bash
python scripts/fetch_sample_data.py
python scripts/fetch_sample_data.py --check
```

The dataset is pinned to commit
`812b2910099f4e10c4d3db1a1635c61d69f8743c`. Override it only for a reviewed
dataset update with `STEEL_SAMPLE_DATA_REF` or `--ref`.

The fetcher performs a sparse clone into `target/sample-data-repository`,
reconstructs the chunked transfer artifact, verifies its SHA-256, extracts it
through a traversal- and symlink-safe path, validates the complete 232-file
source inventory, and atomically publishes
`target/sample-data-cache/content`.

Use `--offline` only after the pinned repository commit has already been
checked out. Generated caches and local full datasets are ignored by Git.

## Updating the dataset

A dataset update requires a new immutable directory in `a1112/sample-data`,
a full file/byte/SHA-256 inventory, an updated pinned commit in this repository,
and passing `scripts.test_fetch_sample_data`. Never replace an existing
versioned dataset in place.
