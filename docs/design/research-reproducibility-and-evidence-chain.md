# 研究复现与算法证据链整改实施设计

> 状态：Proposed
> 日期：2026-08-28
> 基线：`ffb2bcc20b2e11aca8467bfe173b5517ce576f7a`
> 来源：外部研究审查建议与当前代码、配置、测试和运行文档审计

## 决策摘要

本仓库按 Windows 工业在线检测运行时治理，不按单体 Python/PyTorch
训练仓库治理。外部研究审查中的环境锁定、数据许可、标注、评测、
性能和证据追溯建议继续成立，但其对训练入口、Conda、Docker、
多随机种子和通用 3D 研究框架的假设不是当前产品现状。

本设计作出以下决策：

1. 先统一运行拓扑和生命周期所有权，再建立复现命令和算法准入；
2. 正式产品基线是六台 SICK GenTL 相机、`cylinder` 棒材几何、
   一个 SCM Supervisor 和六个受管子服务；
3. 生产数据链固定为
   `steel.acquisition-manifest.v1 → steel.image-result.v1 → steel.defect-report.v1 → Business final result`；
4. 现有 `steel.algorithm-acceptance.v1` 继续拥有生产算法准入语义，
   不再创建平行的准入报告；
5. 冻结数据集、标注、环境、性能和复现身份使用离线证据合同补齐；
6. 模拟、BKV 历史、文件回放和临时模型结果不能替代真实相机生产证据；
7. 许可证、数据授权、权重授权、质量阈值和签字只能由对应资产所有者
   或质量负责人批准，软件不得猜测或生成批准结论。

本文面向运行时、算法、质量、发布、安全、设备和现场验收人员。
本文拥有整改工作流、证据合同和复现协议；正式 Go/No-Go 仍由
[`production-readiness-gap-and-closure-design.md`](../production-readiness-gap-and-closure-design.md)
拥有。

## 事实源与适用边界

### 事实源优先级

发生冲突时按以下顺序判定当前事实：

1. 当前提交中的可执行代码、打包清单和测试；
2. [`runtime-boundaries-v2.md`](../runtime-boundaries-v2.md) 的正式生产边界；
3. [`config/service-registry.json`](../../config/service-registry.json) 的交互式开发进程注册；
4. 当前激活的 site package，以及对应的 runtime、capture 和 algorithm 配置；
5. 其他架构、迁移、计划和外部审查文档。

工作区是否干净、当前 commit、tag、包清单和签名状态必须在构建或验收时
由机器读取，不得长期硬编码在 README 或设计结论中。本文的 commit 只表示
本次设计审计基线，不表示已形成正式 release。

### 当前产品基线

- 当前生产几何为 `cylinder`；`plate` 是共享标准表面合同上的扩展路径。
- 当前 site 基线是 `sick-array-6`，六台 SICK 相机输入
  `Coord3D_C16 + Mono8`，只有经验证的标定投影可以声明毫米单位。
- 缺陷路径是 Python 在线原型，使用迁移后的 YOLOv5 检出器和
  EfficientNet 分类器的四个 ONNX 文件。
- 当前模型清单明确标记 `temporary=true`；所有保留结果需要人工复核，
  在冻结数据集 FAT 和正式算法准入完成前不得直接判废。
- Cargo/npm 锁文件、模拟入口、受控样例、运行合同、CI、发布完整性和
  现场验收脚本已经存在，但不能据此推导真实算法精度或正式生产通过。

### 外部审查建议的处置

| 主题 | 当前判断 | 本设计中的处置 |
| --- | --- | --- |
| Quick Start 与 smoke test | 已有模拟启动和 BKV 受控样例 | 保留并纳入黄金复现路径 |
| Rust/npm 依赖锁定 | 部分具备 | 补齐完整工具链和 Python/SDK 锁定 |
| Docker/Conda | 不适合作为正式生产基线 | 只允许作为可选离线实验环境 |
| 数据版本与哈希 | 私有样例已固定，生产数据未形成算法资格包 | 建立冻结数据集、许可、标注和 split 合同 |
| 标注与泄漏检查 | 缺失 | P0 新增离线合同和 fail-closed validator |
| 训练、seed、epoch、消融 | 当前产品不包含训练声明 | 仅在进入论文或训练交付时启用 P2 |
| 推理、API、ONNX | 已有但权重授权和数值对齐未闭环 | 绑定模型资产并补 native/ONNX 对齐 |
| 评测指标 | 准入字段已存在，真实数值仍为空 | P0 建立冻结 evaluator 和真实双签报告 |
| 测试与 CI | 覆盖广但组件不完整 | P1 扩到全部首方组件和静态/安全门禁 |
| 性能 | 有局部实测，缺统一可比协议 | P1 输出版本化 benchmark 证据 |
| 代码、数据、权重许可 | 缺少完整授权矩阵 | P0 独立 Go/No-Go 门禁 |

## 架构基线前置整改

### 正式生产拓扑

```text
Windows SCM
└─ steel-runtime-supervisor.exe
   ├─ steel-image-service.exe       :4874
   ├─ steel-image-worker.exe        :4875
   ├─ steel-defect-worker.exe       :4876
   ├─ steel-capture-service.exe     :4317
   ├─ steel-inspection-service.exe  :4873
   └─ steel-trigger-gateway.exe     :4881/:4882/:4883
```

正式后台共七个常驻 EXE。桌面端、托盘和交互式 Server Monitor 属于用户会话，
不属于该 SCM 子进程树；`steel_bar_surface_core.exe` 是按需计算助手，也不是
常驻服务。正式运行时唯一进程所有者是 Windows SCM 下的
`steel-runtime-supervisor.exe`。

### 运行模式与唯一所有者

| 模式 | 唯一生命周期所有者 | 允许的进程范围 | 就绪语义 | 禁止组合 |
| --- | --- | --- | --- | --- |
| 正式 SCM | `steel-runtime-supervisor.exe` | 正式六子服务 | 所有 required 服务健康，并通过业务 readiness、算法资格和生产策略门禁 | Server Monitor 或开发脚本不得管理同一端口/EXE |
| 交互式监控 | `steel-inspection-server-monitor.exe` | `service-registry.json` 注册进程；控制面仅 `:4899` loopback | 进程期望状态、直接健康探针和重启预算；不是生产 Go/No-Go | 不得与正式 SCM 或 `run-tauri-dev.ps1` 同时拥有相同服务 |
| SICK 直连开发 | `scripts/run-tauri-dev.ps1` | Python capture、image service、image/defect worker、inspection service 和客户端 | 各本地 HTTP 探针就绪；business 只代理外部 capture | 不得与 SCM、Server Monitor 或另一套本地端口共存 |
| 后台管理 | `scripts/start-background-management.ps1` | inspection service 与管理 UI | service live 且 `managementOnly=true`、capture PID 为空、autostart/control 均关闭 | 不得启动 capture、worker、trigger 或生产任务 |
| 模拟开发 | `scripts/run-simulated-dev.sh` | simulated inspection service、trigger 和 web/Tauri client | service 与 trigger 探针通过 | 只能使用 development/demo；不得生成实际相机生产 PASS |
| BKV 兼容 | 显式启动的开发/迁移脚本 | image service、`steel-image-worker-bkv.exe :4877`、business proxy 和客户端 | BKV adapter 与结果/图像查询可用 | 不得连接实际相机角色、重做缺陷推理或影响实际相机最终判定 |

生命周期所有权通过以下规则强制互斥：

- `STEEL_CAPTURE_MANAGED_BY_SUPERVISOR=1` 时，Inspection Service 只探测和代理
  capture，不得启动、杀死或重启 capture 子进程；
- `STEEL_BACKGROUND_MANAGEMENT_ONLY=1` 是服务端单向安全栅栏，必须覆盖
  inherited env，并强制 capture autostart 和控制关闭；
- 已占用端口但健康检查失败时，启动器必须失败，不得接管未知 PID；
- BKV 凭据只能注入独立兼容 adapter，Business、Image Service 和实际相机
  worker 不得继承；
- 正式、交互式和开发所有者之间的切换必须先停止旧所有者并证明相关端口释放。

### 服务职责和依赖方向

| 边界 | 拥有的职责 | 明确不拥有 |
| --- | --- | --- |
| Acquisition | SICK 连接、触发、原始帧、完整性、不可变落盘和 acquisition manifest | 对齐、测量、缺陷分类和业务结论 |
| Image / Geometry Worker | 对齐、ROI、validity、测量、标准表面和 image result | 相机生命周期和最终质量结论 |
| Defect Worker | 消费完整 image result，执行 ONNX 推理并发布 defect report | 直接控制相机、修改原始帧和写最终状态 |
| Business | 任务状态、数据库、权限、审计和最终生产结果 | 图像解码、几何拟合和模型推理 |
| Image Service | 制品解析、缩略图、ROI、瓦片、编码和缓存 | 生产任务和缺陷判定 |
| Trigger Gateway | PLC/L2/人工事件鉴权和 durable task ingress | 相机 SDK、算法和业务数据库所有权 |
| UI / Monitor | 展示和经过授权的控制请求 | 共享盘直读、算法计算和后台进程真值推导 |

### 端到端持久化合同

```text
PLC/L2/operator event
        ↓
Business durable production task
        ↓
SICK immutable capture
        ↓
steel.acquisition-manifest.v1
        ↓
steel.image-result.v1
        ↓
steel.defect-report.v1
        ↓
Business-owned final result
```

该链遵守以下不变量：

- 原始采集不可变；图像和缺陷结果是可替换的派生产物；
- 下游只消费 `complete=true`、schema 有效且哈希可复核的上游合同；
- 每一阶段绑定上游 manifest 身份和 SHA-256，不能只绑定可变化路径；
- 写入采用 staging、校验和原子发布；失败或半提交结果不得进入业务查询；
- 重试必须以输入修订、算法版本和制品指纹幂等；
- 只有 Business 能形成最终生产状态；
- UI、Business 和媒体服务不得绕过合同读取任意本机或共享盘路径。

### 历史文档迁移

| 现有描述 | 当前问题 | 目标处置 | 退出条件 |
| --- | --- | --- | --- |
| `independent-architecture.md` 的 LVM/C++/八相机主链 | 与当前六 SICK、七 EXE 正式拓扑冲突 | 保留历史背景，正式拓扑改为引用 Runtime Boundaries V2 | 文档不再把旧 provider 描述为当前生产唯一事实 |
| `split-runtime-pipeline.md` 的 `steel-algorithm-service :4875` | 遗漏独立 defect worker，并混入 BKV 主链 | 改为 image `:4875`、defect `:4876`；BKV 移到兼容附录 | 图、端口和 package 清单一致 |
| 开发 capture 直接启动 Python | 易与正式 Rust wrapper 混写 | 明确为开发拓扑；正式包只引用 package manifest | 每个启动文档标明 owner 和环境 |
| Inspection Service 内 capture manager | 可能产生双重拉起 | 限定为显式开发/legacy 管理模式；正式和外部 provider 只代理 | 自动测试覆盖 supervisor、management-only 和 managed 三条分支 |
| README 的瞬时 release/worktree 状态 | 容易陈旧 | 改为构建/验收命令生成的状态和证据链接 | 不再手工声明 current dirty/clean |

架构整改完成的机器门禁应扩展现有
`scripts/verify-independent-architecture.ps1` 或
`scripts/verify-source-boundaries.ps1`，校验正式 package、service registry、
端口、required 服务、BKV 隔离和 lifecycle owner 组合。

## P0：算法资格包

### 证据链

```text
release commit / package identity
          │
          ├─ toolchain and runtime environment
          ├─ model set + model hashes + use restrictions
          ├─ algorithm config + calibration
          ├─ frozen dataset + annotations + split
          └─ frozen evaluator + criteria
                         ↓
             reproducible evaluation
                         ↓
             steel.algorithm-acceptance.v1
                         ↓
                 production admission
```

生产准入必须同时绑定 release commit、算法及模型版本、配置、标定、数据集、
评测器、输入制品、指标、阈值和批准人。任何组成部分发生变化都形成新的
资格包，不允许复用旧批准。

### Proposed 离线证据合同

以下合同是整改目标，当前尚未加入既有 runtime Schema；在实现并完成合同测试前
均保持 `Proposed`。

#### `steel.reproduction-manifest.v1`

负责描述一次可重放的证据身份，至少包含：

- manifest ID、生成工具版本、创建时间和生产者；
- 精确 commit、release tag/package manifest SHA-256；
- Windows、MSVC/SDK、CMake、Rust、Node、Python、CUDA、ONNX Runtime、
  SICK CTI/SDK/firmware 的版本或外部清单引用和哈希；
- dataset、annotation、model set、algorithm config、calibration 和 evaluator
  的 revision、URI/相对引用及 SHA-256；
- setup、smoke、evaluate、benchmark 的精确命令、允许环境变量和工作目录；
- 预期输出文件、schema、哈希或数值容差；
- 是否需要私有资产、GPU、真实相机或人工批准。

manifest 只保存相对引用、内容寻址 URI 或经批准的逻辑资产 ID，不提交开发者
机器绝对路径、密码、共享盘凭据或客户标识。

#### `steel.algorithm-dataset.v1`

负责冻结数据身份和 split，至少包含：

- dataset revision、manifest SHA-256、来源、访问级别和 license 状态；
- 传感器/site、几何 profile、单位、坐标系、深度无效值和标定要求；
- train/validation/test/qualification 等 split；
- 每个 sample 的 `sampleId`、`materialId`、`batchId`、采集批次、
  输入 artifact 引用、字节数和 SHA-256；
- annotation 引用、SHA-256、taxonomy revision 和复核状态；
- 预期样本、材料、批次、类别和尺寸分层统计。

`materialId` 和 `batchId` 均不得跨互斥 split。相邻帧、同一根材料的不同
相机和同一采集批次不能通过不同 sample ID 绕过泄漏检查。

#### `steel.defect-annotation.v1`

负责单样本或单材料的权威标注，至少包含：

- sample/material 身份和 taxonomy revision；
- 缺陷 ID、类别、2D ROI/轮廓或 3D 几何引用；
- 长、宽、深/高、面积等带显式单位的测量；
- `pending | reviewed | adjudicated` 状态；
- 标注来源、标注人、复核人、时间和争议处理记录；
- hard negative、无缺陷和无法判定样本的显式表示。

生产 qualification 只接受 `adjudicated` 标注。缺失单位、未知类别、
越界几何、重复缺陷 ID 或无法解析的引用必须失败。

#### `steel.algorithm-benchmark.v1`

负责保存可比较性能证据，具体协议见 P1 性能章节。

### 数据 validator

目标接口为一个离线、只读、fail-closed 的 validator。文件名和 CLI 在实现任务中
固定，本文建议入口：

```powershell
python scripts/validate_algorithm_dataset.py --manifest D:\evidence\dataset.json --output D:\evidence\dataset-validation.json
```

该入口当前为 Proposed。validator 必须检查：

- manifest、annotation 和输入文件存在且为普通文件；
- 路径规范化后仍位于批准的数据根内，不允许 traversal、symlink/reparse 绕过；
- 字节数和 SHA-256 精确匹配；
- sample、material、batch、artifact 和 defect ID 唯一；
- material/batch 不跨 split；
- taxonomy、单位、坐标、validity、标定引用和几何范围有效；
- manifest 聚合统计与实际文件一致；
- license 状态允许本次用途；
- 输出记录全部检查、错误代码、工具版本和输入 manifest SHA-256。

任何错误都必须返回非零退出码。警告不能自动转换为生产通过。

### 评测与准入

评测入口只消费通过验证的 qualification split、固定模型、固定配置、固定标定和
固定 evaluator。评测期间：

- `STEEL_RUNTIME_PROFILE` 使用 `acceptance`；
- `STEEL_ALGORITHM_MODE` 使用 `validation` 或受控 production-equivalent；
- synthetic、mock、BKV 历史和任意阈值覆盖必须关闭；
- 每个预测绑定输入 artifact、模型、config、calibration 和 evaluator 哈希；
- 同一 manifest 重跑在声明容差内一致，否则失败并保留差异制品。

最低指标沿用现有 `steel.algorithm-acceptance.v1`：

- detection recall；
- false-positive rate；
- miss rate；
- localization error P95，单位 mm；
- size error P95，单位 mm；
- end-to-end latency P95。

报告还应按缺陷类别、尺寸、深度/高度、表面区域、钢种、批次和传感器分层。
阈值由算法负责人提出、质量负责人批准；软件只验证已批准标准，不能自行生成
“合理阈值”。

正式 `steel.algorithm-acceptance.v1` 必须满足：

- `status=pass`；
- config、script/core、release commit、dataset、evaluator 和 calibration 哈希完整；
- 六项指标和六项标准均为实际数值并逐项通过；
- algorithm owner、quality owner 和批准时间非空；
- 报告自身进入不可变证据目录并绑定 SHA-256。

仓库中的 `acceptance-report.example.json` 保持
`pending-site-approval`，只能作为字段示例。临时模型的
`temporary=true` 和 `review-only` 限制在正式批准前不得被配置、UI 或报告覆盖。

## P0：授权、隐私与供应链

代码、数据、模型权重和第三方组件是四类独立资产，不能用其中一类许可证推导
另一类授权。

| 资产 | 必需证据 | 缺失时状态 |
| --- | --- | --- |
| 本仓库代码 | 顶层 LICENSE、版权主体和适用范围 | Blocked |
| 第三方代码/运行库 | THIRD_PARTY_NOTICES、版本、来源、license、修改情况 | Blocked |
| 数据与标注 | 数据卡、来源、采集授权、再分发/商用范围、保留和脱敏政策 | Blocked |
| 模型与权重 | 模型卡、源权重/转换产物哈希、训练数据/权重许可和用途限制 | Blocked |
| 厂商 SDK/CTI/驱动 | 批准版本、安装介质哈希、供应商许可和部署范围 | Blocked |

状态只允许：

- `Approved`：资产所有者已批准当前用途；
- `Restricted`：可用于明确列出的内部/现场用途，不能扩展；
- `Blocked`：信息缺失、冲突或未批准。

不存在“未填写即默认允许”。项目许可证类型、数据再分发权和权重商用权必须由
对应所有者作出决定，整改实现者不得选择一个看似合适的许可证代替批准。

SBOM 必须覆盖 npm、全部首方 Cargo lock、Python requirements/wheel、
C++/Windows 工具链、SICK SDK/CTI、CUDA/cuDNN/ONNX Runtime、模型及其转换产物。
模型作为可执行决策资产至少记录版本、SHA-256、来源、用途限制和签名/包清单绑定；
仅记录文件名不算入库。

公开 fixture、日志、图片和报告前必须检查客户/工厂/产线/材料号、IP、共享盘、
EXIF、设备序列号和本机绝对路径。脱敏后仍需保留内部内容哈希和来源映射，公开
对象使用新的发布身份，不能复用内部路径作为公共 ID。

## P1：可复现环境与 CI

### 环境合同

正式复现环境是 Windows 原生环境，因为生产依赖 SCM、SICK GenTL/CTI、
驱动、CUDA、Tauri/WebView2、签名 MSI/NSIS 和现场存储。Docker/Conda 可以用于
离线算法实验或无硬件合同测试，但其通过不能代替正式环境证据。

环境清单必须精确记录：

- Windows edition/build、架构和补丁基线；
- MSVC toolset、Windows SDK、CMake、Ninja/MSBuild；
- Rust toolchain 和 target、Cargo config；
- Node、npm 和 lockfile hash；
- Python 解释器、完整解析后的 wheel 版本和 wheel SHA-256；
- NVIDIA 驱动、CUDA、cuDNN、ONNX Runtime provider；
- SICK CTI、SDK、相机 firmware 和接口卡驱动；
- WebView2、VC++ Runtime、WiX/NSIS；
- 每个外部安装介质和批准策略文件的 SHA-256。

`windows-latest`、`22.x`、默认 Rust 和范围型 Python 依赖只能用于探索，
不能作为正式复现身份。CI 和正式构建必须解析为具体版本并将结果写入证据。

### CI 覆盖矩阵

| 层 | 必跑门禁 | 说明 |
| --- | --- | --- |
| Frontend/Tauri | `npm ci`、Vitest、TypeScript build、Tauri locked check | 使用精确 Node/npm 和 lock hash |
| Rust | 所有首方 crate 的 `cargo test/check --locked` | 不只覆盖 service 和 trigger |
| Python | 所有跟踪的单元/合同测试、compile/import 检查、格式和静态检查 | 需要区分 CPU 与 GPU 测试 |
| C++ | SDK-independent CTest、Supervisor、algorithm core；SDK 路径在受控 Windows runner | 无 SDK 时必须明确 skipped/blocked |
| Contracts | 所有 JSON Schema 示例、Rust/Python binding 和兼容性测试 | 新字段 additive，破坏性变更升版本 |
| Architecture | package、registry、端口、owner、BKV 隔离和 source-boundary 检查 | 禁止旧服务重新进入正式包 |
| Supply chain | SBOM、license policy、secret scan、dependency audit、签名和 checksum 合同 | Python 和模型必须计入 |
| Performance | 小型非波动 smoke；正式 benchmark 独立执行 | CI 不伪装真实 GPU/FAT |

真实相机、PLC/L2、标定写入/回滚、重启恢复和持续运行使用独立硬件 lane。
报告必须明确 `passed`、`failed`、`skipped` 或 `blocked`，且绑定同一
release/package identity；skipped 和 blocked 不能汇总成绿色生产门禁。

## P1：性能与数值一致性

### `steel.algorithm-benchmark.v1`

benchmark 证据至少包含：

- release、reproduction manifest、dataset、model、config、calibration 和
  evaluator 身份；
- CPU、RAM、GPU、驱动、CUDA、ONNX Runtime、SICK SDK/firmware；
- 相机数、帧数、分辨率、有效点数、batch size 和数据位置；
- warm-up、repeat、并发度、计时器和计时边界；
- 采集等待、源解码、预处理、GPU 检出、分类、后处理、发布和端到端阶段；
- 各阶段 count、median、P95、最大值和失败数；
- throughput、peak RAM、peak VRAM、I/O 字节和队列峰值；
- acceptance criteria、逐项结果和整体 `pass | fail | blocked`；
- 原始 timing artifact、命令和日志的 SHA-256。

采集优先等待与纯计算时间必须分列；不得用排除等待的吞吐替代端到端节拍。
不同硬件、输入、精度、batch、模型、配置或计时边界的报告标记为
`not-comparable`，不能直接宣称回归或提升。

### Native 与 ONNX 对齐

每个由 PyTorch/TensorFlow/native 权重转换的 ONNX 模型必须在冻结的最小样例和
qualification 子集上双跑：

- 输入预处理字节或张量在转换前后相同；
- raw output、候选框、类别分数和最终候选分别比较；
- absolute/relative tolerance 由算法负责人给出并进入 reproduction manifest；
- 动态 batch 至少覆盖 1、生产默认 batch 和尾 batch；
- provider 必须记录 CPU/CUDA 选择，不允许静默回退后仍报告 GPU 通过；
- 原生运行时或源权重无法合法取得时状态保持 Blocked，不用零输入 shape probe
  代替数值一致性。

## 条件性 P2：研究与训练复现

只有当项目开始声明新模型训练能力、论文算法贡献或与外部方法的精度领先时，
才进入本阶段：

- 发布唯一训练入口、固定配置、seed、checkpoint 和完整环境；
- 按材料/批次划分 train/validation/test；
- 至少运行多 seed 稳定性、核心模块消融、噪声/缺失/跨设备鲁棒性；
- 在完全相同数据、输入和硬件协议下比较 Open3D、Anomalib 或其他 baseline；
- 保存均值、方差、失败案例和原始预测，不只发布最佳 checkpoint。

当前整改不得为了满足通用研究模板而虚构 `train.py`、论文 baseline 或训练结果。

## 实施顺序与责任边界

| 阶段 | 交付物 | 责任角色 | 退出门禁 |
| --- | --- | --- | --- |
| A0 架构统一 | 六模式拓扑、owner 矩阵、旧文档迁移、自动边界校验 | Runtime/运维 | package、registry、文档和探针一致；禁止组合可失败 |
| A1 数据与标注 | dataset/annotation 合同、validator、冻结 qualification 集 | Algorithm/Quality/Data owner | hash/split/license/标注校验全绿 |
| A2 算法资格 | reproduction manifest、固定 evaluator、真实指标和双签 acceptance | Algorithm/Quality | `status=pass` 且所有身份精确绑定 |
| A3 授权与供应链 | LICENSE、notices、data/model cards、完整 SBOM | Asset owner/Release/Security | 所有生产资产 Approved 或明确 Restricted |
| B1 环境与 CI | 精确工具链、全组件 CI、硬件 lane 状态模型 | Build/Runtime/QA | clean checkout 软件门禁全绿，硬件证据不被模拟替代 |
| B2 性能与对齐 | benchmark 合同、端到端基线、native/ONNX 对齐 | Algorithm/Performance/QA | P95、资源、数值容差均有机器判定 |
| C 研究扩展 | 训练、多 seed、消融、鲁棒性和同协议外部 baseline | Research/Algorithm | 仅在研究声明获批后启用 |

依赖顺序为：

```text
架构与唯一 owner
        ↓
环境、资产和数据可验证
        ↓
固定 evaluator 可重放
        ↓
算法 acceptance
        ↓
正式性能与现场 FAT
        ↓
Production Go/No-Go
```

软件实现完成不等于外部证据完成。许可证批准、真实标注、质量标准、设备接入、
现场材料和签字缺失时，对应阶段必须保持 Blocked。

## 验收场景

### 正向场景

1. 全新 checkout 在不修改源码的前提下运行模拟 smoke test；
2. 已授权用户取得固定 commit 的私有样例，fetch/check 后文件数和 SHA-256 一致；
3. 冻结 qualification 数据通过路径、hash、split、annotation 和 license 校验；
4. 固定 evaluator 重跑得到容差内一致的指标 bundle；
5. acceptance 报告绑定同一 release、dataset、model、config、calibration 和 evaluator；
6. 正式硬件 lane 绑定实际 SICK/CUDA 环境并独立归档；
7. benchmark 可从 identity 判断是否允许与历史基线比较。

### 必须失败的场景

- 同一 material 或 batch 出现在互斥 split；
- 输入、标注、模型、配置、标定、evaluator 或报告任一字节被替换；
- 路径越界、symlink/reparse 绕过、缺文件、重复 ID 或未知 taxonomy；
- license 为缺失、Blocked，或 Restricted 用途与当前运行不符；
- `pending-site-approval`、指标为空、缺少双签或批准时间早于评测完成；
- 生产评测出现 synthetic/mock 数据或运行时阈值覆盖；
- 用 BKV、模拟、文件回放或单帧 fixture 申请实际相机生产 PASS；
- Inspection Service、SCM 和 Server Monitor 同时试图拥有同一 capture/service；
- GPU provider 静默回退 CPU，或 native/ONNX 超出批准容差；
- 比较两份输入、硬件、模型、batch 或计时边界不同的性能报告。

### 文档验收

- 本文所有当前命令、端口、进程和文件引用均能在基线 commit 中定位；
- 尚未实现的文件、CLI 和合同全部标记 `Proposed`；
- 仓库文档使用相对链接，不记录下载目录、用户目录、凭据或现场秘密；
- README 提供本文入口；
- 生产就绪文档的精度验收章节引用本文，并继续拥有最终 Go/No-Go；
- 设计不修改既有 runtime HTTP API 或三段消息链。

## 与现有文档的关系

- [`runtime-boundaries-v2.md`](../runtime-boundaries-v2.md) 是正式进程拓扑基线；
- [`standard-surface-domain.md`](../standard-surface-domain.md) 拥有
  cylinder/plate、单位、validity 和标准表面语义；
- [`sample-data.md`](../sample-data.md) 描述当前私有 BKV 开发样例的固定版本；
- [`sick-temporary-defect-detection.md`](../sick-temporary-defect-detection.md)
  描述当前临时模型、现场开发基线和 review-only 限制；
- [`release-deployment-and-operations.md`](../release-deployment-and-operations.md)
  拥有正式包、安装、签名、服务和证据归档 SOP；
- [`production-readiness-gap-and-closure-design.md`](../production-readiness-gap-and-closure-design.md)
  拥有最终生产 Go/No-Go。

本文不宣称完整数据或模型可以公开再分发，不宣称当前模型已通过质量准入，
也不填造许可证、指标、硬件验收或批准签字。
