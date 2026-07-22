# BKV NPZ Depth Conversion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert every parseable BKV `.d3img` frame in legacy sequence range 1893700-1893710 into a validated, traceable `bkv-depth-v1` NPZ artifact.

**Architecture:** A repository script owns strict legacy header parsing, compressed NPZ serialization, atomic publication, and batch manifest generation. Tests build small synthetic `.d3img` fixtures and validate real NPZ contents with pickle disabled before the converter is run against the isolated legacy archive.

**Tech Stack:** Python 3, NumPy, Pillow (optional PNG preview), `unittest`, JSON, SHA-256

---

### Task 1: Define the NPZ contract with a failing test

**Files:**
- Create: `scripts/test_bkv_d3img_conversion.py`
- Create: `scripts/convert_bkv_d3img.py`

**Step 1: Write the failing contract test**

Create a synthetic 84-byte `3DImg` fixture containing a `float32` matrix and assert the wished-for `convert_file` API produces an NPZ with exactly the stable contract fields, original `float32` depth, boolean mask, identifiers, unknown-unit marker, and source SHA-256.

**Step 2: Run test to verify it fails**

Run: `python -m unittest scripts.test_bkv_d3img_conversion.BkvD3ImgConversionTests.test_convert_file_writes_standard_npz -v`

Expected: FAIL because `scripts.convert_bkv_d3img` or `convert_file` does not exist.

**Step 3: Implement the minimal converter**

Implement strict header/shape checks, float32 parsing, sentinel masking, metadata extraction, `np.savez_compressed`, and atomic `os.replace`. NPZ scalar strings must be Unicode arrays, never object arrays, so `allow_pickle=False` is sufficient.

**Step 4: Run test to verify it passes**

Run the same unittest command.

Expected: PASS.

### Task 2: Add rejection, discovery, and manifest behavior

**Files:**
- Modify: `scripts/test_bkv_d3img_conversion.py`
- Modify: `scripts/convert_bkv_d3img.py`

**Step 1: Write failing behavior tests**

Add tests for truncated payload rejection, range-limited six-camera discovery, idempotent overwrite, manifest relative paths, per-file hashes, and post-write reload validation.

**Step 2: Run tests to verify they fail for missing behavior**

Run: `python -m unittest scripts.test_bkv_d3img_conversion -v`

Expected: new tests FAIL for missing CLI/discovery/manifest validation.

**Step 3: Implement minimal batch conversion**

Add deterministic file discovery, CLI filters, batch manifest with aggregate counts, source/output SHA-256, stable error records, optional PNG previews, and nonzero exit status when any selected frame fails.

**Step 4: Run tests to verify all pass**

Run: `python -m unittest scripts.test_bkv_d3img_conversion -v`

Expected: PASS with no warnings.

### Task 3: Document operator usage

**Files:**
- Modify: `scripts/README.md`

**Step 1: Add the exact offline conversion command**

Document source/output layout, NPZ keys, unit/coordinate caveat, expected sequence range, manifest, and verification behavior.

**Step 2: Run a documentation contract check**

Run: `rg -n "convert_bkv_d3img|bkv-depth-v1|legacy-unknown|manifest.json" scripts/README.md`

Expected: all four contract terms are present.

### Task 4: Convert and audit all legacy frames

**Files:**
- Generate: `tmp/legacy-bkv/bkv-standard-v1/CamImageSource*/18937*/3D/*.npz`
- Generate: `tmp/legacy-bkv/bkv-standard-v1/manifest.json`

**Step 1: Run full conversion**

Run: `python scripts/convert_bkv_d3img.py --src-dir tmp/legacy-bkv/image_copy2/image_copy --out-dir tmp/legacy-bkv/bkv-standard-v1 --seq-start 1893700 --seq-end 1893710`

Expected: every discovered `.d3img` succeeds and the command exits zero.

**Step 2: Independently audit artifacts**

Load every NPZ with `allow_pickle=False`; verify required keys, dtype/shape agreement, valid-mask statistics, hashes, camera/sequence/frame identifiers, manifest-to-files one-to-one coverage, and absence of temporary files.

Expected: zero missing, extra, corrupt, or mismatched artifacts.

**Step 3: Run regression tests**

Run: `python -m unittest scripts.test_bkv_d3img_conversion -v`

Expected: PASS.

