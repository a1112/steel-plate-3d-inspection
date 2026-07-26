# 应用性能监控页脚设计

## 目标

参考 `G:\Project\StraightnessGauge` 的应用资源统计方式，在当前系统页脚持续显示当前应用进程组的 CPU、内存和进程数量，并同时兼容 Tauri 桌面运行与浏览器开发运行。

监控范围选择“当前应用进程组”，不扩展为整机 CPU、磁盘或网络监控。现有网络状态仍由原 `/api/system/network` 能力负责。

## 数据来源与边界

### Tauri 桌面端

新增 `app_resource_usage` Tauri 命令。命令以当前 Tauri 进程为根，递归收集其子进程并汇总：

- 进程组 CPU 使用率；
- 进程组常驻内存；
- 系统总内存与应用内存占比；
- 进程数量；
- Python、Rust、WebView、Node、Tauri 和其他进程的内存分类；
- 内存最大的进程名称与占用。

CPU 汇总结果按逻辑处理器数量归一化，使页脚显示为容易理解的 `0%–100%` 应用总体负载。Windows 优先读取进程工作集，失败时回退到 `sysinfo` 的进程内存。

### 浏览器开发模式

Rust 服务新增 `GET /api/system/resources`。服务端统计以当前服务进程为根的进程组，并返回与 Tauri 命令相同的数据结构，同时将来源标记为 `service`、精度标记为 `degraded`。

浏览器无法可靠获取 Tauri/WebView 进程，因此此模式只反映 Rust 服务及其子进程。页脚和悬停说明必须明确显示“服务进程”，避免把降级数据误解为完整桌面应用数据。

### 客户端选择

客户端统一通过 `fetchAppResourceUsage` 获取数据：

1. 检测到 Tauri 环境时优先调用 `app_resource_usage`；
2. 普通浏览器调用 `/api/system/resources`；
3. 请求失败时保留最后一次成功快照，并标记为暂不可用；
4. 尚无成功快照时显示 `CPU --`、`内存 --`。

## 刷新与生命周期

主应用每 5 秒采样一次，并满足以下约束：

- 首次渲染立即采样；
- `document.hidden` 时暂停请求；
- 同一时刻只允许一个请求在途；
- 页面重新可见时立即刷新；
- 组件卸载时清理定时器和监听器；
- 单次失败不清空上一帧，避免页脚闪烁。

监控是观察能力，不触发通知，不影响检测、回放、数据库或采集流程。

## 页脚表现

在页脚左侧上下文与右侧功能按钮之间增加紧凑的性能区：

- `CPU 12.4%`
- `内存 428 MB`
- `5 进程`

性能区使用固定宽度数字和单行布局，不能改变现有 42px 页脚高度。空间不足时优先保留 CPU 和内存，进程数量可由响应式样式隐藏，但完整信息仍保留在 `title` 和可访问标签中。

悬停信息包含：

- 数据来源：完整桌面应用或浏览器服务进程；
- 采样时间；
- 应用内存占系统总内存的比例；
- Python、Rust、WebView、Node、Tauri、其他分类；
- 最大内存进程。

浅色和深色主题复用现有页脚变量，不引入独立配色体系。

## 数据结构

前端、Tauri 和服务端统一 camelCase JSON 字段：

- `cpuUsage`
- `memoryUsed`
- `memoryTotal`
- `memoryPercent`
- `processCount`
- `pythonMemoryUsed`
- `rustMemoryUsed`
- `webviewMemoryUsed`
- `nodeMemoryUsed`
- `tauriMemoryUsed`
- `otherMemoryUsed`
- `largestProcessName`
- `largestProcessMemoryUsed`
- `sampledAtMs`
- `source`
- `precision`

`source` 为 `tauri` 或 `service`，`precision` 为 `full` 或 `degraded`。

## 错误处理

- Tauri 命令锁中毒或系统刷新失败时返回可诊断错误，不使应用退出。
- 服务端端点始终返回 JSON；统计失败时使用非零 `code`、空指标和错误文本。
- 客户端校验数值并把负数、`NaN` 和无穷值归零。
- 页脚不显示原始错误堆栈，仅在悬停说明中显示“暂时无法更新”。

## 测试与验收

- Rust 服务测试：CPU 归一化、进程分类、响应 JSON 字段和资源路由。
- Tauri 测试：CPU 归一化、进程分类和当前进程至少被统计一次。
- 客户端数据层测试：Tauri 优先、浏览器回退、格式化和异常结果归一化。
- React 测试：页脚显示 CPU、内存、进程数；降级来源和不可用状态有明确可访问文本。
- 完整验证：客户端测试与构建、服务端测试、Tauri 测试。
- 浏览器验收：`?view=bkv` 和 `?view=online` 页脚均稳定更新，布局不跳动，控制台无新增错误。
