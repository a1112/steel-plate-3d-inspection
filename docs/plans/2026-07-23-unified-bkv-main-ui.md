# Unified BKV Main Interface Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 BKV 六路离线记录和检测图像世界迁入统一主界面，同时让顶部状态、轮询和错误提示严格区分在线相机模式与 BKV 模式。

**Architecture:** 在客户端增加纯 BKV 快照适配层，继续复用 `InspectionDashboard`、`LeftSidebar`、`PlateMap` 和 `InspectionWorldCanvas`。`App` 负责解析终端模式并只加载该模式需要的数据，`BrandHeader` 使用判别联合类型渲染完全独立的在线/BKV 状态分支。

**Tech Stack:** React 18、TypeScript、Vitest、Testing Library、现有 Rust inspection-world HTTP API、Vite。

---

### Task 1: BKV 材料到主界面快照的纯适配层

**Files:**
- Create: `app/client/src/lib/bkv-inspection-adapter.ts`
- Create: `app/client/src/lib/bkv-inspection-adapter.test.ts`
- Modify: `app/client/src/services/bkv-api.ts`

**Step 1: Write the failing adapter test**

创建两条材料夹具，断言：

```ts
const snapshot = buildBkvInspectionSnapshot(materials);

expect(snapshot.source).toBe('bkv');
expect(snapshot.records).toHaveLength(2);
expect(snapshot.records[0]).toMatchObject({
  id: '1893700',
  plateNo: '253B09401250925A12004328',
  status: 'completed',
  defectCount: 1,
});
expect(snapshot.inspections[0].inspectionId).toBe('1893700');
expect(snapshot.inspections[0].defects[0]).toMatchObject({
  id: '2019096',
  cameraId: 'camera1',
  typeLabel: '轧折',
  severity: 'review',
  confidence: 51,
});
expect(snapshot.status.cameraPorts).toEqual([]);
```

另加空数组测试，断言返回合法空快照而不是抛错。

**Step 2: Run the adapter test and verify RED**

Run:

```powershell
npm test -- --run src/lib/bkv-inspection-adapter.test.ts
```

Expected: FAIL because `buildBkvInspectionSnapshot` does not exist.

**Step 3: Extend the BKV defect type**

在 `bkv-api.ts` 中增加可选旧矩形：

```ts
type BkvPixelRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type BkvDefect = {
  // existing fields
  imageRect2d?: BkvPixelRect;
  steelRect2d?: BkvPixelRect;
};
```

**Step 4: Implement the minimal pure adapter**

适配器必须：

- 为每种 BKV 缺陷类别生成稳定 `DefectType`；
- 旧缺陷 ID 原样转为字符串，保证 world overlay 能聚焦；
- 无可靠严重等级时统一使用 `review`；
- 不把像素值伪装为毫米；
- 每个材料生成 record、plate 和 inspection；
- 第一条材料成为 current plate；
- `source` 设置为 `bkv`；
- 设备端口为空且硬件状态离线。

导出：

```ts
export function buildBkvInspectionSnapshot(materials: BkvMaterial[]): InspectionSnapshot
```

**Step 5: Run the adapter tests and verify GREEN**

Run:

```powershell
npm test -- --run src/lib/bkv-inspection-adapter.test.ts
```

Expected: PASS.

**Step 6: Commit**

```powershell
git add -- app/client/src/lib/bkv-inspection-adapter.ts app/client/src/lib/bkv-inspection-adapter.test.ts app/client/src/services/bkv-api.ts
git commit -m "feat: adapt BKV materials for inspection dashboard"
```

### Task 2: 顶部状态严格区分在线和 BKV

**Files:**
- Modify: `app/client/src/components/BrandHeader.tsx`
- Modify: `app/client/src/components/BrandHeader.test.tsx`
- Modify: `app/client/src/styles.css`

**Step 1: Write failing BKV header tests**

使用：

```tsx
<BrandHeader
  runtimeMode={{
    kind: 'bkv',
    cameraCount: 6,
    availableCameraCount: 6,
    batchId: 'legacy-1893700-1893710',
    dataReady: true,
    detail: 'BKV 数据已就绪',
  }}
  ...
/>
```

断言：

- 存在 `BKV 模式`；
- 存在 `离线数据 6/6`；
- 存在批次；
- 存在 `数据就绪`；
- 不存在“相机状态”“报级器网口”“编码器”“PLC”“L2”“触发网关”“服务异常”。

保留现有默认 online 测试，证明在线头部仍显示硬件状态。

**Step 2: Run and verify RED**

Run:

```powershell
npm test -- --run src/components/BrandHeader.test.tsx
```

Expected: FAIL because `runtimeMode` and BKV branch do not exist.

**Step 3: Implement a discriminated runtime mode**

在 `BrandHeader.tsx` 定义：

```ts
export type HeaderRuntimeMode =
  | { kind: 'online'; mismatchMessage?: string }
  | {
      kind: 'bkv';
      cameraCount: number;
      availableCameraCount: number;
      batchId: string;
      dataReady: boolean;
      detail: string;
    };
```

`runtimeMode` 默认 `{ kind: 'online' }`，保证调用方兼容。

将当前 `brand-status` 内容移动到 online 分支。BKV 分支只渲染四个只读状态块和通知入口，不计算 `serviceIssueCount`，也不创建硬件详情弹层。

**Step 4: Add compact BKV header styles**

新增稳定类名：

```css
.brand-status.bkv-runtime-status { ... }
.bkv-mode-status { ... }
.bkv-batch-status { ... }
```

保持标题栏高度不增长，批次允许省略号。

**Step 5: Run tests and verify GREEN**

Run:

```powershell
npm test -- --run src/components/BrandHeader.test.tsx
```

Expected: PASS.

**Step 6: Commit**

```powershell
git add -- app/client/src/components/BrandHeader.tsx app/client/src/components/BrandHeader.test.tsx app/client/src/styles.css
git commit -m "feat: separate online and BKV header status"
```

### Task 3: App 只加载当前模式需要的数据

**Files:**
- Modify: `app/client/src/App.tsx`
- Modify: `app/client/src/App.test.tsx`

**Step 1: Replace the old BKV integration test with failing unified-shell tests**

BKV ready fixture必须返回两条材料。断言：

```ts
expect(await screen.findByText('钢管3D表面检测系统')).toBeInTheDocument();
expect(screen.getByText('BKV 模式')).toBeInTheDocument();
expect(screen.getByRole('heading', { name: '检测记录' })).toBeInTheDocument();
expect(screen.getByText('253B09401250925A12004328')).toBeInTheDocument();
expect(screen.queryByRole('heading', { name: 'BKV 离线回放' })).not.toBeInTheDocument();
expect(screen.queryByText('相机状态')).not.toBeInTheDocument();
```

检查 fetch 调用，BKV 模式不得调用：

- `/api/inspection/snapshot`；
- `/api/capture/health`；
- `/api/trigger/status`。

**Step 2: Run App tests and verify RED**

Run:

```powershell
npm test -- --run src/App.test.tsx
```

Expected: FAIL because App still returns standalone `BkvCompatibilityApp`.

**Step 3: Implement resolved terminal mode and mode-specific loader**

`App` 改成以下数据流：

1. 探测 BKV status；
2. 计算 `resolvedTerminalMode`；
3. BKV 分支读取 `fetchBkvMaterials` 并调用 adapter；
4. online 分支读取 `fetchInspectionSnapshot`；
5. 两个分支最终都渲染 `InspectionDashboard`；
6. loading/error shell 的文字按模式变化。

移除根节点对 `BkvCompatibilityApp` 的直接返回。

`InspectionDashboard` 新增：

```ts
terminalMode: 'online' | 'bkv';
bkvStatus?: BkvStatus | null;
modeMismatchMessage?: string;
```

**Step 4: Fence online polling by mode**

以下 effect 在 `terminalMode !== 'online'` 时立即返回：

- capture snapshot；
- production snapshot 8 秒刷新；
- network monitor；
- trigger and hardware service refresh；
- record-bound online surface artifact。

BKV 只依赖已经加载的 snapshot 和 inspection-world API。

**Step 5: Add explicit online/BKV provider mismatch**

显式 `view=online` 且 `bkvAvailable` 时：

- 仍进入 online 主壳；
- 顶部 online 模式显示 `当前采集源为 BKV，在线相机模式不可用`；
- 不把 0/8 伪装成在线；
- 不影响用户从页脚切回 BKV。

**Step 6: Run tests and verify GREEN**

Run:

```powershell
npm test -- --run src/App.test.tsx
```

Expected: PASS.

**Step 7: Commit**

```powershell
git add -- app/client/src/App.tsx app/client/src/App.test.tsx
git commit -m "feat: load terminal data by active runtime mode"
```

### Task 4: 在统一主工作区显示 BKV 记录与主图

**Files:**
- Modify: `app/client/src/App.tsx`
- Modify: `app/client/src/components/LeftSidebar.tsx`
- Modify: `app/client/src/components/LeftSidebar.test.tsx`
- Modify: `app/client/src/components/PlateMap.tsx`
- Modify: `app/client/src/components/PlateMap.test.tsx`
- Modify: `app/client/src/styles.css`
- Test: `app/client/src/App.test.tsx`

**Step 1: Write failing workspace tests**

断言 BKV 模式：

- 左侧显示 `来源：旧 BKV 文件` 和 `硬件控制已禁用`；
- 记录总数等于材料数；
- 使用六个 camera lane；
- 主图请求的 inspection id 是旧序号；
- 工具栏显示 `BKV 离线记录`、旧序号和批次；
- 不显示“实时跟随最新检测”和“每 8 秒刷新”；
- 选择第二条记录后主图 record id 变为第二个旧序号。

为便于断言，在 `PlateMap` 的 persisted world 容器保留：

```tsx
data-record-id={activePersistedWorld.recordId}
```

**Step 2: Run focused tests and verify RED**

Run:

```powershell
npm test -- --run src/App.test.tsx src/components/LeftSidebar.test.tsx src/components/PlateMap.test.tsx
```

Expected: FAIL because mode-specific workspace labels and six-lane binding do not exist.

**Step 3: Add BKV context to LeftSidebar**

新增可选属性：

```ts
runtimeMode?: 'online' | 'bkv';
```

BKV 分支：

- 材料卡显示旧数据来源标签；
- 显示硬件控制禁用；
- 字段仍使用当前 `SteelPlate`；
- 记录表沿用现有选择、查询和滚动。

online 默认行为不变。

**Step 4: Bind BKV lanes and toolbar in InspectionDashboard**

创建：

```ts
const BKV_CAMERA_LANES = createSequentialCameraLanes(6);
```

传给 `PlateMap`：

```tsx
cameraLanes={terminalMode === 'bkv' ? BKV_CAMERA_LANES : ONLINE_CAMERA_LANES}
```

BKV toolbar 显示离线记录、旧序号和批次；在线 toolbar 保持实时跟随按钮。

BKV 默认 `snapshotTracking='history'`，记录切换不触发 online 刷新。

**Step 5: Expose the persisted world record id**

在 `PlateMap` 的 `InspectionWorldCanvas` 外围或 canvas 上增加 `data-record-id`，不改变瓦片加载协议。

**Step 6: Add mode-specific compact styles**

确保：

- BKV 左侧来源标签不增加列宽；
- BKV main canvas 填满现有主图区；
- C1-C6 标签横向完整显示；
- 没有 standalone `.bkv-app-shell` 高度规则影响统一页面。

**Step 7: Run focused tests and verify GREEN**

Run:

```powershell
npm test -- --run src/App.test.tsx src/components/LeftSidebar.test.tsx src/components/PlateMap.test.tsx
```

Expected: PASS.

**Step 8: Commit**

```powershell
git add -- app/client/src/App.tsx app/client/src/App.test.tsx app/client/src/components/LeftSidebar.tsx app/client/src/components/LeftSidebar.test.tsx app/client/src/components/PlateMap.tsx app/client/src/components/PlateMap.test.tsx app/client/src/styles.css
git commit -m "feat: migrate BKV records and image world into dashboard"
```

### Task 5: Remove stale standalone behavior and cover error states

**Files:**
- Modify: `app/client/src/App.test.tsx`
- Modify: `app/client/src/components/AppFooter.test.tsx`
- Modify: `app/client/src/styles/online-compact-layout.test.js`
- Optional delete only if no imports remain: `app/client/src/components/BkvCompatibilityApp.tsx`
- Optional delete only if no imports remain: `app/client/src/components/BkvCompatibilityApp.test.tsx`

**Step 1: Write failing error-state tests**

覆盖：

- 显式 `view=bkv` 但 status 404：统一主壳显示 BKV 不可用，不回退在线快照；
- BKV materials 500：统一主壳显示 BKV 数据读取失败；
- BKV trigger 503 不产生“服务异常”；
- 页脚 BKV item 在 BKV 主界面仍为当前页。

**Step 2: Run and verify RED**

Run:

```powershell
npm test -- --run src/App.test.tsx src/components/AppFooter.test.tsx src/styles/online-compact-layout.test.js
```

Expected: FAIL on the new error-state expectations.

**Step 3: Implement minimal error states and remove dead imports**

- BKV 错误保留品牌头和页脚；
- 主工作区显示可读错误与重试按钮；
- 删除 standalone 组件 import；
- 只有确认无引用后才删除旧 standalone 组件和测试；
- 保留 `bkv-api.ts` 中 JIT/圆柱 API，避免破坏后续统一视图接入。

**Step 4: Run focused tests and verify GREEN**

Run:

```powershell
npm test -- --run src/App.test.tsx src/components/AppFooter.test.tsx src/styles/online-compact-layout.test.js
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add -A -- app/client/src
git commit -m "test: cover BKV mode isolation and failures"
```

### Task 6: Full verification and live BKV acceptance

**Files:**
- Modify only if verification exposes a covered defect.

**Step 1: Run full frontend tests**

Run:

```powershell
npm test -- --run
```

Expected: all test files and tests pass.

**Step 2: Run the production build**

Run:

```powershell
npm run build
```

Expected: TypeScript and Vite build exit 0.

**Step 3: Run Rust verification if service files changed**

Run:

```powershell
cargo test
```

from `app/service`.

Expected: all Rust tests pass. If no service file changed, `cargo check` baseline is sufficient and this step may be recorded as not applicable.

**Step 4: Start isolated preview against the current BKV service**

Run Vite on a free port and proxy API calls to `http://127.0.0.1:4874`.

**Step 5: Browser acceptance in BKV mode**

Verify authoritative DOM/runtime evidence:

- `BKV 模式`;
- `离线数据 6/6`;
- batch `legacy-1893700-1893710`;
- no `相机状态`;
- no `服务异常`;
- 11 records;
- C1-C6;
- canvas record id `1893700`;
- selecting `1893703` changes record id and defect to `外折`.

**Step 6: Browser acceptance in online mode**

Switch to `?view=online` and verify:

- online title and camera-mode status path;
- explicit BKV provider mismatch message;
- footer can return to BKV;
- BKV records are not mislabeled as online/MySQL production records.

**Step 7: Check git diff and status**

Run:

```powershell
git diff --check main...HEAD
git status --short
```

Expected: no whitespace errors and clean tracked worktree.

**Step 8: Apply verification-before-completion audit**

逐条对照设计目标，记录每项的测试或浏览器证据。只有全部目标都有直接证据后才进入分支收尾。
