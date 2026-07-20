# 在线检测页布局优化 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 精简在线检测页的重复信息，并将筛选和视图控制放到更接近其作用区域的位置。

**Architecture:** 在现有 `App` 组合层移动工具栏与筛选组件；在 `PlateMap` 和 `LeftSidebar` 删除冗余展示节点；`StatisticsPanel` 仅承载类别数量。样式使用语义类名维持响应式布局与状态对比度，不更改现有筛选状态或回调。

**Tech Stack:** React 18、TypeScript、Vitest、Testing Library、CSS。

---

### Task 1: 为在线工作台结构建立回归测试

**Files:**
- Modify: `app/client/src/App.test.tsx`
- Test: `app/client/src/App.test.tsx`

**Step 1: Write the failing test**

添加渲染在线工作台的测试，断言旧的“检测数据实时跟随状态”、生产记录产物说明和圆周展开 `camera1` 标签不出现；断言“横向”“纵向”、2D / 3D / 点云与跟随模式仍出现。

**Step 2: Run test to verify it fails**

Run: `npm test -- App.test.tsx`

Expected: FAIL，因为旧布局节点仍存在。

**Step 3: Write minimal implementation**

在 `App.tsx` 移除独立实时状态栏及其中的类别统计，将跟随与视图控制传递给主图工具栏。

**Step 4: Run test to verify it passes**

Run: `npm test -- App.test.tsx`

Expected: PASS。

### Task 2: 精简圆周展开图和左侧信息面板

**Files:**
- Modify: `app/client/src/components/PlateMap.tsx`
- Modify: `app/client/src/components/LeftSidebar.tsx`
- Modify: `app/client/src/styles.css`
- Test: `app/client/src/App.test.tsx`

**Step 1: Write the failing test**

扩展测试，断言不再输出圆周展开的 `camera1…camera8` 标签轴和“钢管信息”标题，同时钢管字段内容与图内 `C1…C8` 仍可见。

**Step 2: Run test to verify it fails**

Run: `npm test -- App.test.tsx`

Expected: FAIL，因为相机轴与标题栏仍在渲染。

**Step 3: Write minimal implementation**

从 `PlateMap` 删除仅作展示的相机轴；让 `LeftSidebar` 使用无标题面板；收紧对应间距以扩大内容区域。

**Step 4: Run test to verify it passes**

Run: `npm test -- App.test.tsx`

Expected: PASS。

### Task 3: 将筛选移至缺陷列表并重构数量面板

**Files:**
- Modify: `app/client/src/App.tsx`
- Modify: `app/client/src/components/StatisticsPanel.tsx`
- Modify: `app/client/src/styles.css`
- Test: `app/client/src/App.test.tsx`

**Step 1: Write the failing test**

验证缺陷列表之前存在类别和等级筛选；右侧“缺陷数量”面板显示类别计数，但没有“钢管号”“本钢管统计”和“缺陷类别”子标题；验证等级筛选仍保有可按下状态。

**Step 2: Run test to verify it fails**

Run: `npm test -- App.test.tsx`

Expected: FAIL，因为筛选尚在右侧旧面板且旧标题仍存在。

**Step 3: Write minimal implementation**

将可交互筛选块移动到检测列表前；将 `StatisticsPanel` 降级为只读的“缺陷数量”；为类别按钮改用 `repeat(auto-fit, minmax(...))` 网格，并修复严重等级按钮的浅色主题背景。

**Step 4: Run test to verify it passes**

Run: `npm test -- App.test.tsx`

Expected: PASS。

### Task 4: 全量验证与浏览器复核

**Files:**
- Verify: `app/client/src/App.tsx`
- Verify: `app/client/src/components/PlateMap.tsx`
- Verify: `app/client/src/components/StatisticsPanel.tsx`
- Verify: `app/client/src/components/LeftSidebar.tsx`
- Verify: `app/client/src/styles.css`

**Step 1: Run targeted tests**

Run: `npm test -- App.test.tsx`

Expected: PASS。

**Step 2: Run client suite and build**

Run: `npm test && npm run build`

Expected: PASS，且 TypeScript 与 Vite 构建无错误。

**Step 3: Verify in browser**

刷新 `http://localhost:1432/`，检查 1839×1272 视口：相机标签轴、生产记录条与旧状态栏均已移除；新工具行、筛选区和缺陷数量面板符合设计。
