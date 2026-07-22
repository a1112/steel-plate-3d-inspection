# BKV 3D Stitch Preview Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a traceable uncalibrated six-camera stitched preview for legacy sequence 1893700 from the standard BKV NPZ artifacts.

**Architecture:** A standalone Python tool validates and synchronizes six camera frame sets, resamples each paired frame to a common longitudinal grid, robustly centers camera depth offsets, and exports a PNG, summary JSON, and downsampled cylindrical preview data. A conversation visualization consumes only the compact preview data and clearly labels seams and the unknown coordinate unit.

**Tech Stack:** Python 3, NumPy, Pillow, `unittest`, JSON, SHA-256, inline HTML/Three.js

---

### Task 1: Define synchronized stitching behavior

**Files:**
- Create: `scripts/test_bkv_3d_stitch_preview.py`
- Create: `scripts/build_bkv_3d_stitch_preview.py`

**Step 1:** Write a failing synthetic-fixture test for six cameras, two synchronized frames, unequal row counts, masks, robust per-camera centering, and common output shape.

**Step 2:** Run `python -m unittest scripts.test_bkv_3d_stitch_preview -v` and confirm failure because the implementation is absent.

**Step 3:** Implement strict NPZ loading, frame-set equality checks, mask-aware longitudinal resampling, per-camera median centering, and six-sector concatenation.

**Step 4:** Re-run the test and confirm PASS.

### Task 2: Define preview artifacts and traceability

**Files:**
- Modify: `scripts/test_bkv_3d_stitch_preview.py`
- Modify: `scripts/build_bkv_3d_stitch_preview.py`

**Step 1:** Add failing tests for PNG dimensions/transparency, 126-entry input traceability, summary caveats, camera seam positions, and compact cylinder-grid JSON.

**Step 2:** Run the tests and confirm the new assertions fail.

**Step 3:** Add atomic PNG/JSON writing, robust global color scaling, source SHA-256 records, CLI arguments, and compact mesh sampling.

**Step 4:** Run tests, `py_compile`, and `git diff --check`; all must pass.

### Task 3: Generate and audit sequence 1893700

**Files:**
- Generate: `tmp/legacy-bkv/stitch-preview/1893700/unwrapped-height.png`
- Generate: `tmp/legacy-bkv/stitch-preview/1893700/stitch-summary.json`
- Generate: `tmp/legacy-bkv/stitch-preview/1893700/cylinder-preview.json`

**Step 1:** Run the tool against `tmp/legacy-bkv/bkv-standard-v1` for sequence 1893700.

**Step 2:** Independently verify six cameras, 21 synchronized frames each, 126 unique source hashes, output dimensions, finite ranges, seam indices, no temporary files, and output hashes.

### Task 4: Present the interactive preview

**Files:**
- Create: `C:/Users/10428/.codex/visualizations/2026/07/20/019f7fc7-b009-7cb0-ba8c-f15a765fe355/bkv-1893700-3d-stitch.html`

**Step 1:** Embed the compact cylinder grid in a theme-aware inline visualization with rotation, zoom, camera-sector colors, seam lines, and an explicit uncalibrated/unknown-unit label.

**Step 2:** Render or open the fragment, confirm the mesh is visible and interactive, and verify the file remains below 2 MB.

