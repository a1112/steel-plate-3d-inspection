# Camera-local Tiles and Head Alignment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Render real-width, head-aligned camera columns from camera-local tiles while keeping Ctrl+wheel zoom and LOD replacement visually stable.

**Architecture:** The Rust service detects a vertical head offset per camera, exposes alignment metadata, maps defects into aligned display coordinates, and serves tiles addressed in camera-local coordinates. The React client virtualizes each visible camera independently and uses an atomic view state plus a two-generation LOD cache so a replacement is never shown before it is drawable.

**Tech Stack:** Rust 2021, `image`, serde/JSON HTTP service, React 18, TypeScript, Canvas 2D, Vitest and Testing Library.

---

### Task 1: Detect and model camera head offsets

**Files:**
- Modify: `app/service/src/inspection_world.rs`

**Step 1: Write failing synthetic-image tests**

Add tests that create camera streams with:

```rust
// camera 1: 12 dark rows then a textured steel region
// camera 2: 28 dark rows then the same kind of region
assert_eq!(detect_camera_head(&camera_1_paths)?.offset_y, 12);
assert_eq!(detect_camera_head(&camera_2_paths)?.offset_y, 28);
```

Also cover isolated bright noise and an all-background stream returning `aligned == false` and offset zero.

**Step 2: Run the focused tests and verify RED**

Run:

```powershell
cargo test inspection_world::tests::detects -- --nocapture
```

Expected: compilation failure because the detector and alignment fields do not exist.

**Step 3: Implement the minimal detector and metadata**

Add:

```rust
pub struct CameraAlignment {
    pub aligned: bool,
    pub head_offset_y: u32,
    pub confidence_milli: u16,
}
```

Scan grayscale rows, estimate dark background from border samples, require a stable consecutive run of foreground occupancy, and fall back to offset zero when confidence is insufficient. Extend `CameraSpec` and `CameraWorld` with alignment data, keep both raw and display heights, and compute world height from aligned display heights.

**Step 4: Run focused and module tests**

Run:

```powershell
cargo test inspection_world::tests -- --nocapture
```

Expected: all inspection-world tests pass.

**Step 5: Commit**

```powershell
git add app/service/src/inspection_world.rs
git commit -m "feat: detect inspection camera heads"
```

### Task 2: Build aligned BKV and online worlds

**Files:**
- Modify: `app/service/src/bkv.rs`
- Modify: `app/service/src/main.rs`
- Test: existing tests in both files

**Step 1: Write failing BKV and online metadata tests**

Create fixtures with unequal widths and different leading blank row counts. Assert:

```rust
assert_eq!(meta["world"]["cameras"][0]["width"], 7);
assert_eq!(meta["world"]["cameras"][1]["width"], 11);
assert_eq!(meta["world"]["cameras"][0]["headOffsetY"], 12);
assert_eq!(meta["world"]["cameras"][1]["headOffsetY"], 28);
assert_eq!(meta["world"]["cameras"][0]["offsetX"], 0);
assert_eq!(meta["world"]["cameras"][1]["offsetX"], 7);
```

Add an aligned defect assertion whose display Y equals raw Y minus the camera head offset.

**Step 2: Run tests and verify RED**

Run:

```powershell
cargo test bkv::tests::exposes_unified_world_metadata_and_defect_coordinates -- --nocapture
cargo test inspection_world_online_contract -- --nocapture
```

Expected: assertions fail because loaders do not inspect source content.

**Step 3: Wire the shared detector into both loaders**

Resolve ordered intensity paths before constructing each `CameraSpec`, detect the head once, and store the result in the existing BKV manager or online world cache. Apply the aligned coordinate transform in `map_defect`.

**Step 4: Run BKV and online service tests**

Run:

```powershell
cargo test bkv::tests -- --nocapture
cargo test inspection_world -- --nocapture
```

Expected: all selected tests pass.

**Step 5: Commit**

```powershell
git add app/service/src/bkv.rs app/service/src/main.rs app/service/src/inspection_world.rs
git commit -m "feat: align persisted inspection camera worlds"
```

### Task 3: Serve camera-local tiles

**Files:**
- Modify: `app/service/src/inspection_world.rs`
- Modify: `app/service/src/bkv.rs`
- Modify: `app/service/src/main.rs`

**Step 1: Write a failing isolation test**

Build two adjacent cameras with different solid colors. Request a tile for camera 1 whose nominal span is wider than its remaining local width and assert the resolver is never called for camera 2:

```rust
let request = TileRequest::new(1, 0, 0, 0, TileFormat::Png);
assert_eq!(calls.get(&2), None);
assert_eq!(decoded.width(), camera_1_width);
```

Also assert that display-local Y zero reads raw `headOffsetY`.

**Step 2: Run and verify RED**

Run:

```powershell
cargo test inspection_world::tests::camera_local -- --nocapture
```

Expected: failure because `TileRequest` has no camera ID and composition crosses the world.

**Step 3: Implement camera-local composition and HTTP parsing**

Require `cameraId` in `/api/inspection-world/tile`. Treat `x` and `y` as local tile indices, map local display Y back to raw source Y, clip output to that camera, and include camera ID in BKV tile cache keys.

**Step 4: Run focused service tests**

Run:

```powershell
cargo test inspection_world::tests -- --nocapture
cargo test bkv::tests::inspection_tile -- --nocapture
```

Expected: all selected tests pass.

**Step 5: Commit**

```powershell
git add app/service/src/inspection_world.rs app/service/src/bkv.rs app/service/src/main.rs
git commit -m "feat: serve camera-local inspection tiles"
```

### Task 4: Virtualize real-width camera-local tiles in the client

**Files:**
- Modify: `app/client/src/services/inspection-world-api.ts`
- Modify: `app/client/src/lib/inspection-world.ts`
- Modify: `app/client/src/lib/inspection-world.test.ts`
- Modify: `app/client/src/components/InspectionWorldCanvas.tsx`
- Modify: `app/client/src/components/InspectionWorldCanvas.test.tsx`

**Step 1: Write failing contract and placement tests**

Use cameras with widths `682, 646, 632, 541, 692, 677`. Assert labels begin at the scaled cumulative offsets and tile requests include the correct camera ID. Assert no requested local X span can extend into the next camera.

**Step 2: Run and verify RED**

Run:

```powershell
npm test -- src/lib/inspection-world.test.ts src/components/InspectionWorldCanvas.test.tsx
```

Expected: request assertions fail because the client still addresses global tiles.

**Step 3: Implement per-camera visibility and placement**

Extend `WorldTileRequest` with `cameraId`. Calculate the viewport intersection with each camera, obtain local visible tiles, and draw at:

```ts
screenX = (camera.offsetX + tile.x * span) * scale - scrollLeft;
screenY = tile.y * span * scale - scrollTop;
```

Use the same `camera.offsetX` and `camera.width` values for labels and dividers.

**Step 4: Run focused client tests**

Run:

```powershell
npm test -- src/lib/inspection-world.test.ts src/components/InspectionWorldCanvas.test.tsx
```

Expected: all selected tests pass.

**Step 5: Commit**

```powershell
git add app/client/src/services/inspection-world-api.ts app/client/src/lib/inspection-world.ts app/client/src/lib/inspection-world.test.ts app/client/src/components/InspectionWorldCanvas.tsx app/client/src/components/InspectionWorldCanvas.test.tsx
git commit -m "feat: render camera-local inspection tiles"
```

### Task 5: Make zoom and LOD replacement frame-stable

**Files:**
- Modify: `app/client/src/lib/inspection-world.ts`
- Modify: `app/client/src/lib/inspection-world.test.ts`
- Modify: `app/client/src/components/InspectionWorldCanvas.tsx`
- Modify: `app/client/src/components/InspectionWorldCanvas.test.tsx`

**Step 1: Write failing atomic-view and full-cache tests**

Dispatch Ctrl+wheel and assert the first committed canvas state contains both the new scale and the pointer-anchored scroll coordinates. Fill the cache to its limit, trigger an LOD change with delayed image decoding, and assert old drawable tiles are neither revoked nor omitted before all replacement coverage is ready.

Add a helper test showing scale values near one threshold retain the current LOD until they cross the hysteresis band.

**Step 2: Run and verify RED**

Run:

```powershell
npm test -- src/lib/inspection-world.test.ts src/components/InspectionWorldCanvas.test.tsx
```

Expected: the view uses stale scroll coordinates and full-cache insertion revokes fallback entries.

**Step 3: Implement atomic view commits and two-generation caching**

Commit `{ scale, scrollLeft, scrollTop }` together for zoom, focus and fit-width resize. Synchronize native scroll in the corresponding layout commit. Track current and previous drawable LOD generations, prevent undecoded replacements from evicting fallback coverage, retire the previous generation only after current visible coverage has decoded, and select LOD with hysteresis.

**Step 4: Run focused tests**

Run:

```powershell
npm test -- src/lib/inspection-world.test.ts src/components/InspectionWorldCanvas.test.tsx
```

Expected: all selected tests pass without new warnings.

**Step 5: Commit**

```powershell
git add app/client/src/lib/inspection-world.ts app/client/src/lib/inspection-world.test.ts app/client/src/components/InspectionWorldCanvas.tsx app/client/src/components/InspectionWorldCanvas.test.tsx
git commit -m "fix: stabilize inspection world zoom rendering"
```

### Task 6: Full verification and runtime acceptance

**Files:**
- Modify only if a verification failure reveals a scoped defect.

**Step 1: Run the complete Rust suite**

Run:

```powershell
cargo test
```

Working directory: `app/service`

Expected: zero failed tests.

**Step 2: Run the complete client suite**

Run:

```powershell
npm test
```

Working directory: `app/client`

Expected: zero failed tests.

**Step 3: Build the production client**

Run:

```powershell
npm run build
```

Working directory: `app/client`

Expected: TypeScript and Vite build exit successfully.

**Step 4: Verify record 1893700 in the browser**

Reload `http://127.0.0.1:5174/` and verify:

- camera widths follow `682, 646, 632, 541, 692, 677`;
- all six detected steel heads share the same top baseline;
- camera-local tile requests never cross a divider;
- Ctrl+wheel maintains the pointer anchor without an intermediate jump;
- crossing an LOD threshold never produces a blank frame.

**Step 5: Record final repository state**

Run:

```powershell
git status --short --branch
git log --oneline -8
```

Expected: `main` contains the scoped commits; user data directories remain untouched.
