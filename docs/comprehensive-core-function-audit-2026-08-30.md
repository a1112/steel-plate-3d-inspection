# 全面项目检查：核心功能专项审计

## 1. 审计元数据

| 项目 | 内容 |
| --- | --- |
| 审计日期 | 2026-08-30（Asia/Shanghai） |
| 审计基线 | `1e4ef851bca42ad13184c2530f495d4373d80afa` |
| 分支 | `main`，审计开始时与 `origin/main` 完全一致 |
| 当前正式站点 | `config/project.json` 指向 `sick-array-6` |
| 审计方式 | 静态调用链审计、单元/构建验证、定向最小复现、发布契约检查 |
| 结论 | **No-Go：当前基线不应作为正式上线或正式发布基线** |

严重级别定义：

- **P0 / Critical**：可直接破坏生产控制、核心证据或安全边界，需立即封闭。
- **P1 / High**：可造成公制误判、业务假成功、数据不一致、生产中断或跨记录误判。
- **P2 / Medium**：发布、可运维性、兼容链或纵深防御缺口，应在交付前关闭。
- **P3 / Low**：低概率、条件性或维护性风险。

本报告记录审计时已经确认的问题，不代表已经完成修复。常规测试通过不能抵消下述门禁缺失；其中部分测试正是在当前不安全语义下编写的。

## 2. 正式运行链路

当前正式路径为：

```text
Windows SCM
  -> steel-runtime-supervisor.exe
  -> image service :4874
  -> image worker :4875
  -> defect worker :4876
  -> SICK capture :4317
  -> inspection service :4873
  -> trigger :4881/:4882/:4883
```

站点入口见 [`config/project.json`](../config/project.json#L3)，运行边界见 [`docs/runtime-boundaries-v2.md`](runtime-boundaries-v2.md#L9)。`direct-8`、旧 `bar_surface` 以及 BKV online 路径在本报告中单独标注为兼容链，不与当前正式 SICK 六相机链混淆。

## 3. 执行摘要

审计确认两个 P0：

1. `/internal/v1/capture-commit` 在正式全网卡监听配置下可被匿名调用，能够污染采集账本与帧幂等键。
2. 生产任务、钢材事件、算法和重建写接口存在匿名暴露及能力门禁绕过。

最严重的核心功能问题是：六相机公制门禁可以在只有一台相机存在有效轮廓点时返回 `metricValid=true` 和 `surfaceMetricValid=true`。此外，同步健康不绑定曝光时间，相机持续取帧失败仍可能保持 `/health.ready=true`。

正式交付同时被数据库 schema 契约、SBOM fixture 和桌面 CSP 策略漂移阻断。

## 4. 正式链问题

### SEC-001 [P0] 匿名伪造 capture-commit 可污染采集账本

**触发条件**

能够连接 inspection service 4873，并发送不带 `Origin`、`Referer` 和有效会话的原始 HTTP 请求。

**证据链**

- 正式安装将 inspection service 绑定到 `0.0.0.0`：[`scripts/install-runtime-service.ps1`](../scripts/install-runtime-service.ps1#L1774)。
- 状态变更请求没有 `Origin/Referer` 时直接通过：[`app/service/src/main.rs`](../app/service/src/main.rs#L9110)。
- 路由未映射权限时，`authorize_request` 返回成功：[`app/service/src/main.rs`](../app/service/src/main.rs#L9196)。
- `/internal/v1/capture-commit` 直接进入 handler，没有相邻 `capture-regions`、`defect-batch` 已有的 loopback 检查：[`app/service/src/main.rs`](../app/service/src/main.rs#L26990)。
- handler 接受调用方提供的 `sessionId/cameraId/attempt/depthOutput/intensityOutput/metadata`：[`app/service/src/main.rs`](../app/service/src/main.rs#L14516)。
- 数据库据此写帧并推进 `next_image_no/image_count`：[`app/service/src/db/mod.rs`](../app/service/src/db/mod.rs#L3566)。

**影响**

- 伪造采集帧和 artifact 路径。
- 抬高 flow 图像数量和序号。
- 提前占用 `camera + sequence` 幂等键，使后续真实帧被当作重复数据跳过。
- 污染算法输入、生产记录和审计证据。

**建议关闭条件**

- 内部 callback 必须同时具备 loopback/受控专网边界和不可伪造的服务身份。
- 未映射的状态变更路由默认拒绝。
- artifact 路径必须绑定当前 session、相机根、序号及已提交文件证据。
- 增加“无 Origin、无 token、非 loopback”负向回归测试。

### SEC-002 [P0] 生产、任务、算法和重建写接口匿名暴露

**证据链**

- `/api/production/tasks`、部分直接生产写入、算法与 rebuild 路由未完整进入权限映射：[`app/service/src/main.rs`](../app/service/src/main.rs#L8718)。
- 匿名请求默认审计 actor 为 `admin`：[`app/service/src/main.rs`](../app/service/src/main.rs#L26653)。
- 任务入队、取消、重试及钢材事件可到达生产路由：[`app/service/src/main.rs`](../app/service/src/main.rs#L26953)。
- rebuild 代理能够启动本地 Python 作业：[`app/service/src/main.rs`](../app/service/src/main.rs#L8323)。
- 通用任务入口接受 `capture-once`、`algorithm-run`、`steel-*`：[`app/service/src/production_tasks.rs`](../app/service/src/production_tasks.rs#L4011)。
- worker 随后直接执行内部 handler：[`app/service/src/production_tasks.rs`](../app/service/src/production_tasks.rs#L4752)。
- runtime capability 检查主要按直接 HTTP 路径映射，通用任务形式可以绕过：[`app/service/src/main.rs`](../app/service/src/main.rs#L17943)。

**影响**

凡能连接 4873 的低信任客户端可能入队、取消或重试钢材进出、采集和算法任务，触发 provider/设备副作用和本地重建进程；审计记录还会错误归因到 `admin`。

**建议关闭条件**

- 建立默认拒绝的 mutation 路由表。
- 任务 operation 与直接路由使用同一权限和 runtime capability 判定。
- 匿名 actor 不得回退为管理员身份。
- 生产服务令牌、操作员权限、内部 worker 身份分离。

### MET-001 [P1] 六相机公制门禁可由单相机有效数据通过

**根因**

- 空 profile 合法返回 `validProfilePoints=0`。
- 空数组仍可执行外参变换、加入全局 profile 集合，并递增 `calibrated`。
- `selected_section_synchronized`、`every_camera_calibrated` 和圆拟合残差门禁没有检查每台相机的最小有效点数、角覆盖、对向覆盖或有效面积。

核心实现见 [`scripts/sick_capture/measurement.py`](../scripts/sick_capture/measurement.py#L669)。

**独立最小复现**

构造六台相机均具有同步 mapping 和 identity 外参，其中 C1 提供 200 个圆周点，C2-C6 提供空 profile。结果为：

```json
{
  "calibratedCameras": 6,
  "diameterMm": 20.0,
  "metricValid": true,
  "mode": "metric",
  "reasons": [],
  "surfaceMetricValid": true,
  "validProfilePoints": {
    "C1": 200,
    "C2": 0,
    "C3": 0,
    "C4": 0,
    "C5": 0,
    "C6": 0
  }
}
```

**影响**

单视角可以签发正式直径和圆柱统计，背面椭圆、偏心、遮挡或缺损可能完全未被观测。

**建议关闭条件**

- 每台预期相机建立最小有效点、最小连续角覆盖和最大缺口门禁。
- 建立对向/多扇区覆盖要求，不能只检查矩阵数量。
- 每个 section 独立验证覆盖率后再参与 cylinder summary。
- 加入“六矩阵齐全但五路空数据”的正式负向测试。

### SYNC-001 [P1] free-run 帧组可被错误声明为 synchronized

当前站点使用 `free-run + continuous`：[`config/sites/sick-array-6/capture.json`](../config/sites/sick-array-6/capture.json#L17)。

**根因**

- `hostUtcNs` 在 GenTL fetch、数组复制和遥测刷新之后采样，不代表曝光时刻：[`scripts/sick_capture/gentl.py`](../scripts/sick_capture/gentl.py#L443)。
- 同步记录计算 `cameraSequenceSkew`，但不使用设备时间戳。
- `synchronized` 门禁不检查 `cameraSequenceSkew` 或设备时钟差：[`scripts/sick_capture/provider.py`](../scripts/sick_capture/provider.py#L4927)。

**复现结果**

两路完整轮的 host 时间相同，但 sequence 分别为 `1/10001`，设备时间相差约 9000 秒，仍得到：

```json
{
  "cameraSequenceSkew": 10000,
  "hostSkewMs": 0.0,
  "qualityReasons": [],
  "status": "synchronized",
  "synchronized": true
}
```

**影响**

不同曝光位置的 free-run 帧可能进入同一轮次，实时同步状态和原始分组证据不可信。

### HEALTH-001 [P1] 全部相机取帧失败后 capture ready 仍可为 true

- `provider_ready` 只取决于 backend 已启动和 session 数量：[`scripts/sick_capture/provider.py`](../scripts/sick_capture/provider.py#L3555)。
- 帧失败、同步降级和存储失败不参与 ready。
- 连续循环失败只等待后重试，不主动淘汰 session 或重连。
- Supervisor 的 capture 探针只搜索 `/health` 中的 `"ready":true`：[`app/capture/src/steel_runtime_supervisor_main.cpp`](../app/capture/src/steel_runtime_supervisor_main.cpp#L847)。

FakeSession 持续抛出 `TimeoutError` 后，审计复现同时得到 `framesFailed=1`、`syncStatus=degraded`、`providerReady=true`、`ready=true`。

**影响**

采集可以持续漏帧、漏钢，但进程与 Supervisor 保持绿色，不触发恢复。

### TXN-001 [P1] provider 副作用与任务终态非原子，重试可能重放物理动作

钢材事件分多步写入 flow、session、inspection，之后调用 provider，再分别结束实体：[`app/service/src/main.rs`](../app/service/src/main.rs#L13875)。worker 在副作用完成后才写 task terminal 状态：[`app/service/src/production_tasks.rs`](../app/service/src/production_tasks.rs#L4953)。失败任务可以重新进入 queued：[`app/service/src/db/mod.rs`](../app/service/src/db/mod.rs#L3101)。

**触发条件**

provider 已成功，但随后的 DB 写入失败或服务崩溃，然后操作员执行 retry。

**影响**

物理动作已经发生，任务仍显示 running/failed；重试会重复执行，flow、session 和 inspection 也可能停在互相矛盾的状态。

**建议关闭条件**

采用持久 operation/outbox、稳定 provider idempotency key、明确的 dispatched/acknowledged/committed 阶段，以及启动恢复和人工 reconciliation。

### STATUS-001 [P1] capture-once 在 provider 或持久化失败时仍可成功

- 除 HTTP 503 外的 provider 错误继续向下处理：[`app/service/src/main.rs`](../app/service/src/main.rs#L15352)。
- 缺失 `failures` 默认按零处理。
- inspection、帧和 summary 独立写入，summary 目录/文件错误被忽略。
- worker 只按 HTTP 2xx 与顶层 `code==0` 判成功：[`app/service/src/production_tasks.rs`](../app/service/src/production_tasks.rs#L4682)。

**影响**

task 可为 `succeeded`、inspection 可为 `captured`，但帧、summary 或数据库记录实际缺失。

### STATUS-002 [P1] 缺陷持久化失败仍标记 algorithm-complete

初始读取错误被 `unwrap_or_default` 吞掉，逐条缺陷插入失败只追加到 `errors`：[`app/service/src/main.rs`](../app/service/src/main.rs#L22226)。上层只读取 total，随后写 `algorithm-complete` 并返回 code 0：[`app/service/src/main.rs`](../app/service/src/main.rs#L15688)。

**影响**

数据库瞬时错误或单条约束失败可永久漏失缺陷和告警，但 inspection 与 task 对外宣称完整成功。

### DATA-001 [P1] 数据库发布契约停留在 v1，运行时已迁移到 v5

- 运行时常量为 schema 5：[`app/service/src/db/mod.rs`](../app/service/src/db/mod.rs#L27)。
- 服务启动执行 v1→v5 在线迁移：[`app/service/src/db/mod.rs`](../app/service/src/db/mod.rs#L5623)。
- 发布契约仍声明 schema 1：[`config/release/database/contract.json`](../config/release/database/contract.json#L3)。
- migration index 的 target 仍为 1，列表为空：[`config/release/database/migrations/index.json`](../config/release/database/migrations/index.json#L3)。
- 打包脚本要求两者一致：[`scripts/package-runtime.ps1`](../scripts/package-runtime.ps1#L528)。
- 安装器声明不执行 migration，却将 v1 contract 写入部署回执：[`scripts/install-runtime-service.ps1`](../scripts/install-runtime-service.ps1#L1350)。

**验证**

`scripts/test-database-migration-contract.ps1` 在第 171 行确定性失败，报告 tracked contract 与 `DATABASE_SCHEMA_VERSION` 不一致。

**影响**

- 当前 HEAD 无法正常正式打包。
- 若绕过门禁，服务会在部署记录声称 schema 1 后自行升级到 v5。
- 回滚可读范围和实际数据库状态失真，旧版本可能无法读取 v5。

### DATA-002 [P1] 结果目录与 SQLite catalog 存在崩溃一致性窗口

ResultPublisher 先替换 `records/<inspection>`，之后才开始 catalog transaction：[`app/result-contract/src/lib.rs`](../app/result-contract/src/lib.rs#L225)。启动时只创建目录和 schema，没有 staging/records/catalog reconciliation：[`app/result-contract/src/lib.rs`](../app/result-contract/src/lib.rs#L129)。

**触发条件**

目录 rename 后、SQLite commit 前发生断电或进程终止。

**影响**

record 目录与 catalog 指向不同 generation，API/图像服务可能读取旧 blob、错误 blob 或缺失结果。现有测试只覆盖函数返回 `Err` 后的进程内回滚，不覆盖崩溃窗口。

### CACHE-001 [P1] 同一 inspection 重新发布后图像服务仍可读取旧 blob

catalog cache 只以逻辑坐标为键，命中后不核对 generation 或 SQLite 更新，且没有主动失效机制：[`app/image-service/src/catalog.rs`](../app/image-service/src/catalog.rs#L72)。publisher 则允许删除重插同一 inspection 并更新 generation：[`app/result-contract/src/lib.rs`](../app/result-contract/src/lib.rs#L240)。

**影响**

纠正或重处理结果发布后，image-service 可能继续提供旧图，直到 LRU 淘汰或进程重启。

### LIFECYCLE-001 [P1] 正常停止无法保证 Python provider 完成 drain

- 正式包将 camera-worker 作为 capture service wrapper。
- wrapper 收到 shutdown 后直接 `child.kill()`：[`app/camera-worker/src/main.rs`](../app/camera-worker/src/main.rs#L66)。
- Python 有序关闭需要停止采集、等待存储池、等待 DB commit thread 并关闭活动 manifest：[`scripts/sick_capture/provider.py`](../scripts/sick_capture/provider.py#L1214)。

**影响**

升级、服务停止或运行组重启时，内存帧、存储队列、Business DB commit 与活动流水关闭记录可能丢失。

### SUP-001 [P2] Supervisor 稳态不持续验证一般 readiness

初始启动检查六个子进程 readiness，但稳态主要等待进程退出，并只轮询 capture 的特殊 `restartRequired` 状态：[`app/capture/src/steel_runtime_supervisor_main.cpp`](../app/capture/src/steel_runtime_supervisor_main.cpp#L1675)。重启预算在进程存活一段时间后恢复，不要求业务健康恢复。

**影响**

进程存活但死锁、catalog 不可用、worker 停止或业务接口失效时，运行组不一定自恢复。

### TRIG-001 [P1] Trigger HTTP/UDP 串行阻塞，TCP 并发无上限

- HTTP accept 循环同步执行请求处理。
- UDP 在唯一 `recv_from` 循环中同步鉴权并等待 Business POST。
- TCP 每连接创建一个 OS 线程，连接可保持 30 秒，`in_flight` 只有计数而无容量门禁：[`app/trigger/src/main.rs`](../app/trigger/src/main.rs#L964)。

**影响**

慢 HTTP 客户端或慢 Business 会阻塞健康、drain 和触发；UDP burst 可能溢出 socket 缓冲；TCP 可耗尽线程和句柄。

### UI-001 [P1] 记录切换失败后可能继续显示上一条记录图像

BKV/inspection-world 切换开始时没有统一清空旧 world；新记录 meta 请求失败只设置 error，旧 canvas 仍继续渲染：[`app/client/src/components/PlateMap.tsx`](../app/client/src/components/PlateMap.tsx#L3570)。

**影响**

侧栏、缺陷和记录上下文已经切换到记录 B，中心图仍是记录 A，形成跨记录误判。

### UI-002 [P1] 采集掉线后实时页保留旧在线状态和旧帧

- 轮询失败时保留既有 health/status，仅附加 error：[`app/client/src/App.tsx`](../app/client/src/App.tsx#L989)。
- LiveCameraMonitor 未接收该 error，仍按旧状态计算在线数和连续采集状态。
- 后续图像加载失败时保留上一次成功帧：[`app/client/src/components/LiveCameraMonitor.tsx`](../app/client/src/components/LiveCameraMonitor.tsx#L132)。

**影响**

停止 4317/4873 或网络断开后，实时页仍可能显示在线、旧 FPS 和旧图像。

### OPS-001 [P1] 正式服务所有权与客户端“服务状态”功能冲突

- 正式架构要求 SCM runtime supervisor 是唯一进程所有者，禁止 server-monitor 并存：[`docs/design/research-reproducibility-and-evidence-chain.md`](design/research-reproducibility-and-evidence-chain.md#L93)。
- 客户端 footer 始终显示“服务状态”：[`app/client/src/components/AppFooter.tsx`](../app/client/src/components/AppFooter.tsx#L248)。
- 对话框固定调用 `127.0.0.1:4899`，但正式包没有包含 server-monitor。
- monitor 在探针成功但没有 child handle 时会收养监听 PID：[`app/server-monitor/src/service_supervisor.rs`](../app/server-monitor/src/service_supervisor.rs#L330)。
- stop/restart 最终可执行 `taskkill /PID /T /F`：[`app/server-monitor/src/service_supervisor.rs`](../app/server-monitor/src/service_supervisor.rs#L1131)。

**影响**

正常正式部署时“服务状态”不可用；手工启动 monitor 后又进入双重所有权，可强杀 SCM 子进程并造成互相拉起的重启竞态。

### OPS-002 [P1] monitor 可将真实业务 degraded 覆盖为 healthy

基础聚合会在 service 未就绪、worker 停止、任务接口缺失、近期任务失败或 runtime degraded 时返回 `degraded`；叠加 supervisor snapshot 后，只要 required 探针通过且队列为空，就可无条件覆盖为 `healthy`：[`app/server-monitor/src/background_monitor.rs`](../app/server-monitor/src/background_monitor.rs#L785)。

**影响**

tray、独立 monitor 和主客户端可能把真实 Go/No-Go 阻断显示为绿色。

## 5. 发布、CI 与运维问题

### REL-001 [P2] Tauri CSP 与批准发布策略不一致

Tauri 配置允许 `https://*:*`，release policy 没有该项：

- [`app/client/src-tauri/tauri.conf.json`](../app/client/src-tauri/tauri.conf.json#L34)
- [`config/release/desktop-release-policy.json`](../config/release/desktop-release-policy.json#L8)

打包脚本和独立架构验证要求精确相等。审计只读比较结果为 `Equal=false`，当前配置无法通过正式桌面发布门禁。

### REL-002 [P2] SBOM 测试 fixture 未跟随新增 crate 更新

`scripts/test-release-sbom.ps1` 的 fixture 只复制旧 Cargo locks：[`scripts/test-release-sbom.ps1`](../scripts/test-release-sbom.ps1#L109)。生成器已经要求 camera-worker 等新增 lock：[`scripts/generate-release-sbom.ps1`](../scripts/generate-release-sbom.ps1#L41)。

实际执行失败：

```text
Required repository input is missing: app/camera-worker/Cargo.lock
```

### CI-001 [P2] 新增核心 crate 与算法边界未进入 CI

当前 workflow 主要测试 `app/service`、`app/trigger`、部分 SICK 与 Tauri：[`software-gates.yml`](../.github/workflows/software-gates.yml#L65)。缺少或不完整覆盖：

- `algorithm-service`
- `camera-worker`
- `image-service`
- `pipeline-workers`
- `result-contract`
- `runtime-contract`
- `server-monitor`
- `tray`
- C++ `algorithm-core`
- 六相机“外参齐全但部分相机无有效数据”负例

### MODEL-001 [P2] 临时缺陷模型身份不参与完成门禁

当前 active site 使用 temporary model：[`config/sites/sick-array-6/capture.json`](../config/sites/sick-array-6/capture.json#L44)。输出虽然保留 `temporaryModel=true`，但 `complete/degraded` 仍可被业务层视为完成。

**影响**

尚未通过现场 FAT/资格验证的模型结果可能被只依赖完成状态的下游当作正式结果。

### UPDATE-001 [P2] updater 根信任未绑定批准公钥

客户端从构建环境读取 `STEEL_UPDATE_PUBLIC_KEY`：[`app/client/src-tauri/src/software_update.rs`](../app/client/src-tauri/src/software_update.rs#L43)。release policy 只记录变量名，不保存批准公钥或指纹；正式 build/package 也不验证或记录最终编译进去的 key。

**影响**

- 漏设 key 时可产出无法更新的正式客户端。
- 构建环境注入另一对 key 时，Authenticode 正常的安装包仍可能信任未批准的 updater 根。

### PIPE-001 [P2] pipeline reprocess 请求非持久且可能丢 TCP 分段 body

worker 收到请求后 spawn Python 并立即返回 202，子进程结果不进入持久任务状态：[`app/pipeline-workers/src/main.rs`](../app/pipeline-workers/src/main.rs#L242)。HTTP parser 读到 header 结束即停止，没有继续读取完整 `Content-Length` body：[`app/pipeline-workers/src/main.rs`](../app/pipeline-workers/src/main.rs#L347)。

### CACHE-002 [P2] 图像磁盘缓存无容量预算或淘汰

revision 进入磁盘 cache key，每次 miss 写盘；只有内存 LRU 有预算，磁盘文件没有清理策略：[`app/image-service/src/cache.rs`](../app/image-service/src/cache.rs#L25)。长期运行或大量唯一 revision 可耗尽结果盘。

### REPORT-001 [P2] 在线历史与报表导出静默截断

- 在线 snapshot 只加载最近 20 条 inspection：[`app/service/src/main.rs`](../app/service/src/main.rs#L4001)。
- 报表只请求 5000 条历史缺陷，客户端不执行 offset 分页。
- CSV/JSON 直接导出当前内存 rows，没有提示 `total > loaded`。

**影响**

旧记录不可检索，导出文件可能不完整但界面没有截断提示。

## 6. 兼容链问题

以下问题不属于当前 `sick-array-6` 正式相机进程，但在启用相应兼容功能时成立。

### 6.1 bar_surface / direct 算法链

1. **ALG-C01 [P1] 生产准入接受正负 Infinity。** Python 与 PowerShell 门禁只做方向比较，不检查 `isfinite`：[`scripts/bar_surface_reconstruct.py`](../scripts/bar_surface_reconstruct.py#L339)。
2. **ALG-C02 [P1] 缺陷纵向比例几乎恒为 1。** 全材料 `longitudinal_span` 在组件循环中被当前缺陷高度覆盖，`distanceHeadMm/xRatio/previewX` 可全部落到材料尾端：[`scripts/bar_surface_reconstruct.py`](../scripts/bar_surface_reconstruct.py#L1716)。
3. **ALG-C03 [P1] 三个点可扩展为整行有效扇区。** 插值后所有列被标记为 valid/calibrated，生产门只要求每相机至少一行成功：[`scripts/bar_surface_reconstruct.py`](../scripts/bar_surface_reconstruct.py#L1223)。
4. **ALG-C04 [P1] 选中帧 metadata/相机身份可 fail-open。** metadata 缺失或损坏时可回退配置序列号，并用目录中任意旧 JSON 满足完整性统计。
5. **ALG-C05 [P1] C++ core 短写可能仍返回 code 0。** writer 未检查 write/flush/close 状态，Rust 侧只要求 `outputBytes>0`：[`app/algorithm-core/src/main.cpp`](../app/algorithm-core/src/main.cpp#L504)。

### 6.2 direct-8 C++ capture 兼容链

1. **DIRECT-C01 [P1] 同一 material 的重复采集会覆盖历史帧。** 每次 continuous-test 从 sequence 1 开始，路径不包含 session，写前主动删除目标文件：[`app/capture/src/capture_service_app.cpp`](../app/capture/src/capture_service_app.cpp#L7405)。
2. **DIRECT-C02 [P1] 不验证配置硬件身份，9 台相机可满足 8 台合同。** 运行时只读取期望数量和存储根，使用 `ips.size() >= expected`：[`app/capture/src/capture_service_app.cpp`](../app/capture/src/capture_service_app.cpp#L7467)。
3. **DIRECT-C03 [P2] 输出根字符串前缀检查可被 junction/reparse point 绕过。** 路径只做 lexical normalize，没有 canonical/reparse 解析。

### 6.3 BKV / result compatibility 链

1. **BKV-C01 [P1] 缺陷查询失败会降级为 ready/零缺陷。** `load_defects(...).await.unwrap_or_default()` 吞掉错误，也不核对源 `DefectNum`：[`app/algorithm-service/src/main.rs`](../app/algorithm-service/src/main.rs#L275)。
2. **BKV-C02 [P1] 物化过程重编号帧，但缺陷保留原 ImgIndex。** 非零起始或有间隔的帧会与缺陷证据错位。
3. **BKV-C03 [P2] 旧 Radius 被升级为 `outerDiameterMm`。** 来源明确不主张已标定语义，adapter 却将其发布为毫米外径。
4. **BKV-C04 [P2] 通用导入把缺失/损坏/失败 defect manifest 变成 ready/零缺陷。** 状态和 temporary model 语义被忽略。
5. **BKV-C05 [P2] MySQL adapter 强制 `ssl-mode=disabled`。** 示例又允许远端地址：[`app/algorithm-service/src/main.rs`](../app/algorithm-service/src/main.rs#L143)。

## 7. 已确认的正向保障

以下机制在当前实现中有效，应在修复时保留：

- SICK profile 严格检查启用相机数、连续索引和独立存储根。
- GenTL 按序列号唯一匹配，并回读校验序列号、型号、固件和 IP。
- 原始帧拒绝覆盖，metadata 最后提交。
- 部分轮次明确记录 `complete=false` 和 `missingCameraIds`，下游不会将其伪装成六相机完整轮。
- 客户端 3D production fallback 会核对 inspection/material 与 manifest material，未发现全局 latest 直接串记录。
- 正式 Supervisor 当前六个子进程与运行边界文档一致。

## 8. 实际验证结果

| 范围 | 命令/结果 |
| --- | --- |
| Git 基线 | `main == origin/main == 1e4ef851...` |
| 前端单元测试 | 73/73 test files，566/566 tests passed |
| TypeScript | `tsc --noEmit`，exit 0 |
| Python | `unittest discover` 共运行 364 项，2 项因外部归档/现场标定未挂载而跳过，其余通过 |
| Rust service | 367 passed |
| Rust trigger | 17 passed |
| Rust 其他核心 crate | runtime-contract 2、result-contract 6、camera-worker 2、pipeline-workers 4、image-service 10、algorithm-service 1、server-monitor 10 |
| Rust 合计 | 419 tests passed；tray 无测试；Tauri `cargo check` 通过 |
| C++ capture | Release 重建成功，CTest 9/9 passed |
| 源码边界 | `verify-source-boundaries.ps1` passed |
| 发布 SBOM | failed：fixture 缺少 `app/camera-worker/Cargo.lock` |
| 数据库迁移契约 | failed：tracked contract v1 与 runtime v5 不一致 |
| 桌面 CSP | 静态比较 `Equal=false` |

Python 中出现 Pillow `mode` 参数弃用告警，不影响本轮测试结论。前端测试中存在 jsdom canvas/React act 警告，但测试结果为通过。

本机 checkout 曾因 CRLF 导致 migration index working-tree hash 与 Git blob 不同；Git blob 的 SHA-256 与 contract 声明一致，因此未将该本机换行问题计为源码缺陷。即使消除换行差异，schema v1/v5 契约测试仍会失败。

## 9. 未验证边界

- 未连接六台真实 SICK 相机、编码器/测速仪和现场标定件。
- 未验证真实曝光同步、外参精度、绝对纵向毫米尺度和现场直径误差。
- 未连接生产 MySQL/PostgreSQL、SMB/共享盘或真实 BKV 数据源。
- 未做断电、进程强杀、磁盘满和 provider 成功后 DB 故障注入。
- 未做长时吞吐、UDP burst、TCP 连接耗尽和 Supervisor soak。
- 未使用发布证书、updater 私钥完成 MSI/NSIS、升级和回滚端到端验证。
- 当前仅有 temporary model manifest，未完成真实 ONNX/GPU 推理和 FAT 精度复核。

## 10. 建议整改顺序

### 阶段 A：立即封闭 P0

1. 为所有 mutation 建立默认拒绝的统一权限表。
2. 为内部 callback 建立服务身份、loopback/专网限制和 payload 证据绑定。
3. 取消匿名 actor=`admin`。
4. 将 task operation 和直接 HTTP 路由统一到同一 capability/permission 判定。

### 阶段 B：计量与采集 fail-closed

1. 增加逐相机有效点、角覆盖、对向覆盖和每 section 覆盖门禁。
2. 同步证据绑定设备曝光时间/序列，设置最大 sequence skew。
3. 让持续 fetch/storage/DB 失败进入 ready 与 Supervisor 恢复判定。
4. camera-worker 实现可证明的 graceful drain 与超时后兜底终止。

### 阶段 C：任务与结果一致性

1. provider 操作采用 durable operation/outbox 和稳定幂等键。
2. capture/algorithm 只有在所有必需持久化成功后才能进入 terminal success。
3. result store 引入可恢复的 publication journal 或单一事务边界。
4. image catalog cache 绑定 generation 并支持主动失效。

### 阶段 D：发布与运维闭环

1. 对齐数据库 v5 contract、migration index、安装回执和回滚范围。
2. 修复 CSP policy、SBOM fixture，并将新增 crate/算法负例纳入 CI。
3. 明确正式 SCM 与交互式 monitor 的唯一所有权边界。
4. 绑定 updater 批准公钥/指纹并记录在 release evidence 中。
5. 修复客户端旧记录、旧在线状态和报表静默截断。

## 11. Go/No-Go 退出条件

至少满足以下条件后，才应重新评估 Go：

- SEC-001、SEC-002 已修复并有网络边界负向测试。
- MET-001、SYNC-001、HEALTH-001 已修复，并在六相机混合缺失/错序 fixture 下 fail-closed。
- capture/algorithm 不再在必需持久化失败时返回 success。
- 数据库 migration contract、SBOM、CSP 和正式 package gate 全部通过。
- 结果 publication 崩溃恢复和同 inspection 重发布缓存失效有自动化测试。
- 在目标机完成六相机、数据库、存储、SCM、升级/回滚和长时运行验收，并形成可追溯证据。
