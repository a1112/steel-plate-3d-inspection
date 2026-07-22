# Unified Inspection Tile World Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build one on-demand tiled image world that directly joins line-scan frames, maps database defects into world coordinates, and exposes the same minimum contract for BKV offline data and online MySQL/capture data.

**Architecture:** Extend the verified BKV manifest with raw 2D dimensions and defect pixel evidence, then add a pure Rust world-layout layer and an image-backed tile compositor. Route BKV and online database/capture adapters through one `/api/inspection-world/*` contract, and replace the BKV six-`img` view with a viewport-driven Canvas tile renderer that can also be adopted by the online eight-camera view.

**Tech Stack:** Python 3 (`csv`, Pillow test fixtures), Rust 2021 (`serde`, `serde_json`, `image`), SeaORM/MySQL, React 18, TypeScript, Canvas 2D, Vitest, Testing Library, PowerShell browser smoke.

---

### Task 1: Preserve BKV image dimensions and defect pixel evidence

**Files:**
- Modify: `scripts/build_bkv_runtime_manifest.py`
- Modify: `scripts/test_bkv_runtime_manifest.py`

**Step 1: Write the failing manifest tests**

Extend the fixture CSV with every BKV 2D coordinate column and create two JPEG frames per camera with Pillow. Assert that the generated manifest includes image dimensions and preserves raw defect coordinates without substituting whole-steel coordinates.

```python
self.assertEqual(first["cameras"][0]["frameWidth"], 32)
self.assertEqual(first["cameras"][0]["frameHeight"], 16)
self.assertEqual(first["cameras"][0]["orientation"], {
    "frameOrder": "ascending", "rotation": 0,
    "flipX": False, "flipY": False,
})
self.assertEqual(first["defects"][0]["imageIndex"], 4)
self.assertEqual(first["defects"][0]["imageRect2d"], {
    "left": 3, "right": 9, "top": 5, "bottom": 11,
})
self.assertEqual(first["defects"][0]["steelRect2d"]["top"], 4005)
```

Add rejection tests for mixed frame sizes inside one camera and a defect whose `ImgIndex` is outside that camera's frame set.

**Step 2: Run the tests to verify RED**

Run:

```powershell
python -m unittest scripts.test_bkv_runtime_manifest -v
```

Expected: FAIL because camera dimensions, orientation, and 2D rectangles are absent.

**Step 3: Implement the manifest extension**

Use Pillow to read the first JPEG dimensions, verify every frame in the same camera matches, and emit:

```python
{
    "cameraId": camera,
    "mode": "offline-file",
    "frameWidth": frame_width,
    "frameHeight": frame_height,
    "orientation": {
        "frameOrder": "ascending",
        "rotation": 0,
        "flipX": False,
        "flipY": False,
    },
    "twoDFrameCount": len(two_d_frames),
    "twoDFrames": two_d_frames,
}
```

Map `LeftImg2D`, `RightImg2D`, `TopImg2D`, `BottomImg2D` into `imageRect2d`; preserve the four `*Steel2D` fields under `steelRect2d`. Validate zero-based `ImgIndex` against the exact frame numbers available for the referenced camera.

**Step 4: Run the tests to verify GREEN**

Run the unittest command from Step 2. Expected: all manifest tests pass.

**Step 5: Rebuild and audit the real BKV manifest**

Run:

```powershell
python scripts/build_bkv_runtime_manifest.py --data-root D:\Project\steel-plate-3d-inspection\tmp\legacy-bkv
```

Inspect material `1893700`: six cameras, 21 frames each, and defect `2019096` with `cameraId=1`, `imageIndex=12`, and its raw image rectangle. Do not commit `tmp/` output.

**Step 6: Commit**

```powershell
git add scripts/build_bkv_runtime_manifest.py scripts/test_bkv_runtime_manifest.py
git commit -m "feat: preserve BKV image world evidence"
```

### Task 2: Define the pure inspection-world layout and coordinate model

**Files:**
- Create: `app/service/src/inspection_world.rs`
- Modify: `app/service/src/main.rs`

**Step 1: Write failing Rust layout tests**

Add tests in `inspection_world.rs` for:

- C1-C6 widths summing into one world width;
- 21 × 1024 frames producing height 21504;
- a shorter camera retaining its X offset and empty tail;
- zero-based defect mapping to `camera_offset + local_x`, `12 * 1024 + local_y`;
- duplicate camera IDs and illegal rotation failing validation.

```rust
#[test]
fn maps_bkv_defect_into_camera_one_frame_twelve() {
    let world = InspectionWorld::new(vec![camera(1, 682, 1024, 21)]).unwrap();
    let rect = world.map_defect(1, 12, PixelRect::new(473, 857, 10, 10)).unwrap();
    assert_eq!(rect, PixelRect::new(473, 13_145, 10, 10));
}
```

**Step 2: Run the targeted Rust test to verify RED**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml inspection_world
```

Expected: FAIL because the module and types do not exist.

**Step 3: Implement the minimal pure model**

Define serializable types:

```rust
pub struct CameraOrientation {
    pub frame_order: FrameOrder,
    pub rotation: u16,
    pub flip_x: bool,
    pub flip_y: bool,
}

pub struct CameraWorld {
    pub camera_id: u32,
    pub offset_x: u32,
    pub width: u32,
    pub height: u32,
    pub frame_width: u32,
    pub frame_height: u32,
    pub frame_numbers: Vec<u32>,
    pub orientation: CameraOrientation,
}

pub struct InspectionWorld {
    pub width: u32,
    pub height: u32,
    pub tile_size: u32,
    pub max_level: u8,
    pub cameras: Vec<CameraWorld>,
}
```

Keep Task 2 image-independent. Implement identity orientation completely and validate the future rotation/flip fields, but defer transformed pixel copying to Task 3.

**Step 4: Run tests to verify GREEN**

Run the command from Step 2. Expected: all `inspection_world` tests pass.

**Step 5: Commit**

```powershell
git add app/service/src/inspection_world.rs app/service/src/main.rs
git commit -m "feat: define inspection image world coordinates"
```

### Task 3: Compose BKV tiles directly from whitelisted line-scan frames

**Files:**
- Modify: `app/service/Cargo.toml`
- Modify: `app/service/Cargo.lock`
- Modify: `app/service/src/inspection_world.rs`
- Modify: `app/service/src/bkv.rs`

**Step 1: Write failing compositor tests**

Create small synthetic JPEG frames with solid colors and test:

- a level-0 tile crossing frame 0/1 contains both colors at the exact boundary;
- a tile crossing C1/C2 contains the right edge of C1 and left edge of C2;
- level 1 has half-resolution dimensions and correct content order;
- a missing frame keeps a blank/error region rather than shifting frame 2 upward;
- an artifact not present in the BKV whitelist is never opened.

**Step 2: Run tests to verify RED**

```powershell
cargo test --manifest-path app/service/Cargo.toml inspection_world::tests::composes
```

Expected: FAIL because no image compositor exists.

**Step 3: Add the bounded image dependency**

Add `image` with only required codecs:

```toml
image = { version = "0.25", default-features = false, features = ["jpeg", "png"] }
```

**Step 4: Implement on-demand tile composition**

Add a compositor that receives an already validated `InspectionWorld`, a tile request, and a resolver callback. It must calculate intersections before decoding and read only frames touched by the requested tile.

```rust
pub struct TileRequest {
    pub level: u8,
    pub tile_x: u32,
    pub tile_y: u32,
}

pub fn compose_tile<F>(
    world: &InspectionWorld,
    request: TileRequest,
    mut resolve: F,
) -> Result<Vec<u8>, WorldError>
where
    F: FnMut(u32, u32) -> Result<PathBuf, WorldError>;
```

Use a neutral dark fill for valid world space without a source frame. Reject out-of-bounds tile coordinates. Encode JPEG for normal display and keep PNG available for deterministic tests. Add a small bounded in-memory cache to `BkvRuntime`, keyed by manifest identity/layout version/record/level/x/y/format.

**Step 5: Run targeted and BKV tests**

```powershell
cargo test --manifest-path app/service/Cargo.toml inspection_world
cargo test --manifest-path app/service/Cargo.toml bkv
```

Expected: compositor tests and the existing seven BKV tests pass.

**Step 6: Commit**

```powershell
git add app/service/Cargo.toml app/service/Cargo.lock app/service/src/inspection_world.rs app/service/src/bkv.rs
git commit -m "feat: compose BKV line scan tiles on demand"
```

### Task 4: Expose one inspection-world HTTP contract for BKV and online records

**Files:**
- Modify: `app/service/src/inspection_world.rs`
- Modify: `app/service/src/bkv.rs`
- Modify: `app/service/src/main.rs`
- Modify: `app/service/src/db/mod.rs`

**Step 1: Write failing route and provider-contract tests**

Add service tests for:

```text
GET /api/inspection-world/records
GET /api/inspection-world/meta?recordId=...
GET /api/inspection-world/defects?recordId=...
GET /api/inspection-world/tile?recordId=...&level=0&x=0&y=0&format=jpeg
```

For BKV, assert provider `bkv`, six cameras, the 1893700 defect world rectangle, and a decodable tile. For a database-backed fixture, assert provider `online`, records come from production inspection tables, camera frames come from ordered `capture_file` intensity rows, and a defect without pixel geometry returns `locatable=false` rather than a guessed rectangle.

**Step 2: Run tests to verify RED**

```powershell
cargo test --manifest-path app/service/Cargo.toml inspection_world_http
```

Expected: FAIL with unknown routes.

**Step 3: Implement BKV responses**

Build metadata from the selected manifest material. Return stable JSON schemas such as `steel.inspection-world.meta.v1` and `steel.inspection-world.defects.v1`. Return tile bytes with `Content-Type`, `X-World-Level`, `X-World-Tile-X`, `X-World-Tile-Y`, and cache headers.

**Step 4: Implement the minimum online adapter**

Use the existing SeaORM connection and production tables:

- records: `production_inspection`/`material_session`;
- images: `capture_file` rows where `data_name=intensity`, grouped by camera and ordered by `sequence_no`;
- defects: `production_defect` rows from MySQL.

Only mark an online defect locatable when its `geometry_json` contains explicit pixel evidence (`cameraId`, `imageIndex`, and `imageRect2d`). Keep millimetre fields in trace metadata; do not convert them to pixels in this minimum compatibility layer.

Online production must keep the existing database startup policy: MySQL is selected through `STEEL_DATABASE_ENGINE=mysql`/`STEEL_DATABASE_URL`; a MySQL failure remains a readiness failure. Do not add BKV or SQLite fallback.

**Step 5: Verify provider isolation**

Add assertions that BKV requests never query the online database adapter and online requests never read the BKV manifest root.

**Step 6: Run Rust tests**

```powershell
cargo test --manifest-path app/service/Cargo.toml inspection_world
cargo test --manifest-path app/service/Cargo.toml bkv
```

Expected: all new contract tests and existing BKV tests pass.

**Step 7: Commit**

```powershell
git add app/service/src/inspection_world.rs app/service/src/bkv.rs app/service/src/main.rs app/service/src/db/mod.rs
git commit -m "feat: expose unified inspection world API"
```

### Task 5: Add typed client APIs and visible-tile calculations

**Files:**
- Create: `app/client/src/services/inspection-world-api.ts`
- Create: `app/client/src/services/inspection-world-api.test.ts`
- Create: `app/client/src/lib/inspection-world.ts`
- Create: `app/client/src/lib/inspection-world.test.ts`

**Step 1: Write failing API tests**

Assert exact URLs, abort-signal forwarding, JSON validation, and tile blob URL creation/revocation for the four world endpoints.

**Step 2: Write failing world math tests**

Cover fit scale, clamped zoom, viewport-to-world conversion, visible tile range with one-tile prefetch, partial edge tiles, and defect focus rectangles.

```ts
expect(getVisibleWorldTiles({
  worldWidth: 4096,
  worldHeight: 21504,
  tileSize: 512,
  level: 2,
  viewport: { x: 0, y: 4096, width: 1000, height: 800 },
  prefetch: 1,
})).toEqual(expect.arrayContaining([{ level: 2, x: 0, y: 1 }]));
```

**Step 3: Run tests to verify RED**

```powershell
npm test -- --run src/services/inspection-world-api.test.ts src/lib/inspection-world.test.ts
```

Expected: FAIL because modules do not exist.

**Step 4: Implement minimal typed clients and pure math**

Define `InspectionWorldMeta`, `InspectionWorldCamera`, `InspectionWorldDefect`, `WorldRect`, and `WorldTile`. Keep all view calculations pure and independent of React.

**Step 5: Run tests to verify GREEN**

Run the command from Step 3. Expected: all API and math tests pass.

**Step 6: Commit**

```powershell
git add app/client/src/services/inspection-world-api.ts app/client/src/services/inspection-world-api.test.ts app/client/src/lib/inspection-world.ts app/client/src/lib/inspection-world.test.ts
git commit -m "feat: add inspection world client contract"
```

### Task 6: Build the reusable Canvas tile viewport

**Files:**
- Create: `app/client/src/components/InspectionWorldCanvas.tsx`
- Create: `app/client/src/components/InspectionWorldCanvas.test.tsx`
- Modify: `app/client/src/styles.css`

**Step 1: Write failing component tests**

Mock a small world and assert:

- initial fit requests only visible/prefetch tiles, not all 126 source images;
- wheel zoom changes level and visible requests;
- pointer drag changes world viewport;
- camera boundaries C1-C6 render at metadata offsets;
- a locatable defect is drawn and focus changes viewport;
- an unlocatable defect is not drawn;
- failed/missing tiles retain their coordinates and show a diagnostic fill.

**Step 2: Run test to verify RED**

```powershell
npm test -- --run src/components/InspectionWorldCanvas.test.tsx
```

Expected: FAIL because the component does not exist.

**Step 3: Implement the viewport**

Use one visible Canvas, `ResizeObserver`, pointer capture for dragging, cursor-centred wheel zoom, and an image cache keyed by tile URL. Draw tiles first, then camera/frame guides, then defect overlays. Abort requests that leave the prefetch window and revoke obsolete blob URLs.

Do not add annotation editing, minimaps, persistence, WebGL, or offline preheating in this first version.

**Step 4: Run component and math tests**

```powershell
npm test -- --run src/components/InspectionWorldCanvas.test.tsx src/lib/inspection-world.test.ts
```

Expected: all viewport tests pass.

**Step 5: Commit**

```powershell
git add app/client/src/components/InspectionWorldCanvas.tsx app/client/src/components/InspectionWorldCanvas.test.tsx app/client/src/styles.css
git commit -m "feat: render inspection world tiles on canvas"
```

### Task 7: Replace the BKV first-frame strip and provide online compatibility

**Files:**
- Modify: `app/client/src/components/BkvCompatibilityApp.tsx`
- Modify: `app/client/src/components/BkvCompatibilityApp.test.tsx`
- Modify: `app/client/src/components/PlateMap.tsx`
- Modify: `app/client/src/components/PlateMap.test.tsx`
- Modify: `app/client/src/App.tsx`

**Step 1: Write failing BKV integration tests**

Assert that the default BKV 2D view requests world metadata and renders `InspectionWorldCanvas`, no longer loads `camera.twoDFrames[0]`, shows C1-C6 in one world, and focuses the 1893700 “轧折” when its list item is activated.

**Step 2: Write failing online compatibility tests**

When an online record has world metadata, assert `PlateMap` uses the same Canvas with eight cameras. When no persisted capture world exists yet, retain the current live camera preview as an explicit fallback labelled “实时预览”, not as BKV data.

**Step 3: Run tests to verify RED**

```powershell
npm test -- --run src/components/BkvCompatibilityApp.test.tsx src/components/PlateMap.test.tsx src/App.test.tsx
```

Expected: FAIL because both pages still use their earlier image-band rendering paths.

**Step 4: Integrate the shared Canvas**

Keep BKV as the dedicated offline workspace, but source its records, defects, metadata, and tiles from the unified endpoints. Preserve JIT and cylinder tabs. Pass selected defect focus to the Canvas.

For online mode, request the unified world only for a persisted inspection record; keep live in-progress previews functional until MySQL/capture rows exist.

**Step 5: Run tests to verify GREEN**

Run the command from Step 3. Expected: BKV, PlateMap, and App tests pass.

**Step 6: Commit**

```powershell
git add app/client/src/components/BkvCompatibilityApp.tsx app/client/src/components/BkvCompatibilityApp.test.tsx app/client/src/components/PlateMap.tsx app/client/src/components/PlateMap.test.tsx app/client/src/App.tsx
git commit -m "feat: share tiled inspection world across modes"
```

### Task 8: Verify real BKV data, MySQL boundaries, build, and browser behavior

**Files:**
- Modify: `scripts/test-runtime-ui-smoke.ps1`
- Modify: `config/env/bkv.env.example` only if a new tile/cache parameter is required
- Modify: `config/env/simulated-mysql.env.example` only if the online world needs an explicit image root
- Modify: `scripts/README.md`

**Step 1: Extend browser smoke assertions**

Replace the six-lane DOM assertions with:

- one inspection-world Canvas;
- metadata reports six cameras and 126 BKV source frames;
- initial request count is bounded and less than 126;
- camera labels C1/C6 and no C7;
- selecting the defect focuses C1/frame 12;
- JIT and cylinder views still render.

Add an online contract smoke or service integration assertion that production mode reports the MySQL engine and eight-camera configuration without BKV paths.

**Step 2: Run focused suites**

```powershell
python -m unittest scripts.test_bkv_runtime_manifest scripts.test_bkv_3d_stitch_preview -v
cargo test --manifest-path app/service/Cargo.toml inspection_world
cargo test --manifest-path app/service/Cargo.toml bkv
npm test -- --run src/services/inspection-world-api.test.ts src/lib/inspection-world.test.ts src/components/InspectionWorldCanvas.test.tsx src/components/BkvCompatibilityApp.test.tsx src/components/PlateMap.test.tsx src/App.test.tsx
```

Expected: all focused tests pass.

**Step 3: Run full client and service verification**

```powershell
Push-Location app/client
npm test -- --run
npm run build
Pop-Location
cargo test --manifest-path app/service/Cargo.toml
```

Expected: 0 failures; Vite production build succeeds.

**Step 4: Run real BKV browser smoke**

Start the BKV service against `D:\Project\steel-plate-3d-inspection\tmp\legacy-bkv`, start this worktree client on a free port, then run:

```powershell
scripts/test-runtime-ui-smoke.ps1 -ClientOrigin 'http://127.0.0.1:<port>/?app=terminal' -ExpectBkv
```

Visually inspect the screenshot: 21 frames per camera connect vertically, C1-C6 connect horizontally, no six independent first-frame cards remain, and the defect overlay lands on C1 frame 12.

**Step 5: Document runtime contract**

Document Provider selection, BKV snapshot provenance, online MySQL requirements, tile cache parameters, direction defaults, and the rule that online defects without pixel evidence remain unlocatable.

**Step 6: Commit**

```powershell
git add scripts/test-runtime-ui-smoke.ps1 scripts/README.md config/env/bkv.env.example config/env/simulated-mysql.env.example
git commit -m "test: verify unified inspection tile world"
```

**Step 7: Finish the branch**

Use `superpowers:verification-before-completion`, then `superpowers:requesting-code-review`, and finally `superpowers:finishing-a-development-branch`. Do not merge or push until the user chooses the integration action.
