# BKV 页脚入口实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在统一应用页脚的“更多”菜单中提供状态受控的 BKV 离线回放入口，并让 BKV 模式复用该页脚。

**Architecture:** `AppFooter` 管理可访问的“更多”弹出菜单，并通过显式 BKV 入口模型渲染可用、激活或禁用状态。`App` 将经过验证的 BKV 服务状态传到在线仪表盘或 BKV 壳层；`BkvCompatibilityApp` 继续负责既有离线数据、二维、JIT 和圆柱 3D 内容。

**Tech Stack:** React 18、TypeScript、Vitest、Testing Library、lucide-react、现有 BKV REST API 与 PowerShell CDP smoke。

---

### Task 1: 为页脚 BKV 菜单定义失败测试

**Files:**
- Modify: `app/client/src/components/AppFooter.test.tsx`
- Modify: `app/client/src/components/AppFooter.tsx`
- Modify: `app/client/src/styles.css`

**Step 1: Write the failing test**

增加两个组件测试：非 BKV 模式点击 `更多功能` 后，`离线回放` 的 `role=menuitem` 禁用且显示 `仅 BKV 模式可用`；BKV 可用时菜单项可点击并调用 `onOpen` 回调。

**Step 2: Run test to verify it fails**

Run: `npm test -- --run src/components/AppFooter.test.tsx`

Expected: FAIL，因为 `更多功能`、BKV 入口模型和菜单尚不存在。

**Step 3: Write minimal implementation**

- 在 `AppFooterProps` 添加可选 `bkvReplay`：`available`、`active`、`onOpen`。
- 使用 `MoreHorizontal` 增加 `更多功能` 按钮；以本地 `menuOpen` 状态渲染 `role=menu`。
- 菜单使用 `role=menuitem`、`aria-expanded`；失焦或 `Escape` 关闭。
- `available=false` 时保留禁用菜单项和说明；`available=true` 时调用 `onOpen` 后关闭菜单。
- 添加最小定位样式，窄屏时不挤压现有页脚工具。

**Step 4: Run test to verify it passes**

Run: `npm test -- --run src/components/AppFooter.test.tsx`

Expected: PASS。

**Step 5: Commit**

Run: `git add -- app/client/src/components/AppFooter.tsx app/client/src/components/AppFooter.test.tsx app/client/src/styles.css; git commit -m "feat: add BKV replay entry to footer menu"`

### Task 2: 将 BKV 状态接入统一页脚壳层

**Files:**
- Modify: `app/client/src/App.tsx`
- Modify: `app/client/src/App.test.tsx`
- Modify: `app/client/src/styles.css`

**Step 1: Write the failing test**

增加应用级测试：在线仪表盘页脚的 `离线回放` 禁用；模拟 `provider=bkv`、`ready=true` 后，BKV 回放页面仍渲染统一页脚，菜单项可用并处于激活状态。

**Step 2: Run test to verify it fails**

Run: `npm test -- --run src/App.test.tsx`

Expected: FAIL，因为当前 BKV 页面没有 `AppFooter`，在线仪表盘也未接收 BKV 入口状态。

**Step 3: Write minimal implementation**

- 在 `App` 提取 BKV 模式壳层：保留主题与 `BkvCompatibilityApp` 内容，追加统一 `AppFooter`。
- 仅将 `provider === 'bkv' && ready` 作为 `available=true` 的条件，其余模式传入禁用模型。
- BKV 模式中的菜单项显示激活状态；点击仅保持离线回放内容，绝不调用相机或硬件接口。
- 在线 `InspectionDashboard` 接收并向 `AppFooter` 传递禁用的入口模型。
- 调整 BKV 壳层高度，确保内容区和页脚不重叠。

**Step 4: Run test to verify it passes**

Run: `npm test -- --run src/App.test.tsx src/components/AppFooter.test.tsx`

Expected: PASS。

**Step 5: Commit**

Run: `git add -- app/client/src/App.tsx app/client/src/App.test.tsx app/client/src/styles.css; git commit -m "feat: integrate BKV replay into shared footer shell"`

### Task 3: 运行时与回归验证

**Files:**
- Modify: `scripts/test-runtime-ui-smoke.ps1`
- Test: `app/client/src/components/BkvCompatibilityApp.test.tsx`

**Step 1: Write the failing smoke assertion**

在 BKV 二维页面检查 `更多功能`，打开菜单后确认 `离线回放` 可用且六相机 Canvas 保留；在非 BKV 模式 smoke 中确认入口禁用且不导航。

**Step 2: Run smoke to verify it fails**

Run: `./scripts/test-runtime-ui-smoke.ps1 -ClientOrigin 'http://127.0.0.1:5174/?app=terminal' -ExpectBkv`

Expected: FAIL，因为当前 BKV 页面没有共享页脚入口。

**Step 3: Implement only the required smoke checks**

- 在现有 BKV 页面交互步骤中定位、点击并检查页脚菜单。
- 不改变现有瓦片、缩放、JIT 和圆柱 3D 断言。

**Step 4: Run full verification**

Run: `npm test -- --run; npm run build; ./scripts/test-runtime-ui-smoke.ps1 -ClientOrigin 'http://127.0.0.1:5174/?app=terminal' -ExpectBkv; git diff --check`

Expected: 全部前端测试、构建、BKV smoke 和差异检查通过。

**Step 5: Commit**

Run: `git add -- scripts/test-runtime-ui-smoke.ps1 app/client/src/components/BkvCompatibilityApp.test.tsx; git commit -m "test: cover BKV footer replay entry"`
