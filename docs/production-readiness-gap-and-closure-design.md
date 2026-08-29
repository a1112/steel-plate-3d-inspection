# 钢材表面 3D 检测系统上线差距与收口设计

> 评审日期：2026-07-16  
> 评审对象：当前工作区（包含未提交改动），不是某个已发布 Git 标签  
> 结论：当前可用于开发联调；从功能性判断，尚未形成可签字的真实生产闭环，暂不满足正式生产上线的 Go 条件
> 本文排序：优先判断采集、重建、检测、复核、报表和异常恢复能否完成生产任务；签名、证书、ACL、SBOM 等非功能项保留记录，但不作为本轮功能排序依据

## 1. 评审结论

系统的采集、业务服务、触发网关、Tauri/React 操作端、持久化任务、相机标定回滚、健康检查和告警管理框架已经基本成形。当前最大的风险不再是“有没有界面或 API”，而是以下功能闭环尚未完成：

1. **生产缺陷检测只完成了几何候选检测，尚未完成合同缺陷类别的生产识别。** 当前真实算法使用逐行半径中位数、MAD 阈值和连通域生成候选。为兼容既有数据库仍保留 `pit/foreign` ID，但新版本明确写入 `classificationState=candidate-only`、径向极性和空的分类置信度；界面与打印件显示“凹陷候选/凸起候选”和“候选检测置信度”，不再把极性 ID 冒充材料缺陷类别。划伤、辊印、烧伤、边部、气泡、夹杂等类别目前只在模拟数据或配置字典中存在，不能据此宣称已具备多类缺陷识别能力。
2. **缺陷级复核的代码链路已补齐，尚缺真实数据精度验收。** 算法现在为每个缺陷生成并绑定相机、帧号、源帧哈希、像素 ROI、灰度/深度 ROI、局部点云及长宽两个高度剖面；服务通过兼容的 `geometry_json` 暴露 `steel.surface.defect.artifacts.v1`，前端优先加载局部产物，旧记录保留明确标注的整管参考或空状态。仍需真实八相机缺陷样本验证 ROI 映射、局部坐标和剖面测量精度。
3. **当前八相机版本已取得真实完整采集与重建证据，现场异常和节拍证据仍不完整。** `BAR-20260716-114758` 自然完成 184/184 个完整帧事务，八台相机各有 23 组 depth/intensity/metadata 且零失败；同批数据的八相机标定重建验收达到 20/20。尚未关闭标定写入/回滚与崩溃恢复、PLC/L2 真实触发和连续班次验收。
4. **生产参数与报告归档、打印底稿代码已收口，仍缺现场确认和模板冻结。** Rust 现在通过 `steel.algorithm-runtime-config.v1` 返回采集根、算法输出根、配置文件、版本、修订、哈希和阈值的 desired/active/readback；安装器从现场存储根派生两类目录。报表固定编号和固定来源已移除，后端可按实际检测快照生成内容寻址报告 ID、不可变 JSON 归档、幂等重复签发和历史查询；新增按 `inspectionId + reportId` 读取正文并重新校验文档 SHA-256 的接口。前端只基于校验通过的归档生成 A4 横向离线打印 HTML，包含完整缺陷明细、算法/配置/标定追溯、证据索引和签字栏。仍需在目标机确认配置回读，并冻结现场抬头、结论与证据图模板。

因此建议把当前版本定义为 **功能联调版**。至少完成真实算法定型、缺陷级复核、八相机 24/24、现场触发和连续试运行后，才进入正式生产发布。安全与供应链事项本轮不参与功能优先级排序，但不删除原有记录。

剩余功能阻塞已统一纳入 `test-functional-go-live-readiness.ps1`。该工具以同一 release version/commit/manifest SHA-256 为主键，汇总真实算法审计、八相机 24/24、PLC/L2 场景、完整生产班次和目标机生命周期证据，并明确排除安全、签名和供应链项。24/24 和稳定性生成器均把该身份写入报告，跨版本、跨候选或缺少 manifest 绑定的旧证据直接 No-Go。PLC/L2 与目标机的逐场景证据现在必须是实际存在且 SHA-256 匹配的 `steel.functional-scenario-evidence.v1` 文件；正文还要绑定同一 release、精确场景、pass 结果、来源元数据和执行窗口内的观测时间，批准必须发生在执行结束后。即使重新计算了一个无关文件的正确哈希，也会因 scenarioId 或语义不匹配被拒绝；篡改任一证据文件同样使门禁失败。它也不允许用 simulated soak、短时循环、空证据引用或人工口头确认替代现场报告。

为降低现场手工填错风险，候选包新增 `new-functional-scenario-evidence.ps1`：从当前 manifest 和真实 raw log 生成证据，原子落盘并返回引用哈希。证据除自身 SHA-256 外还包含 manifest SHA-256 与 raw-log SHA-256；最终汇总重新验证两层内容，所以只保留加工后的 JSON、丢失原始日志或事后修改日志均不能通过。

候选包同时提供 `new-functional-acceptance-workspace.ps1`，从当前 manifest 一次生成固定证据目录、统一计划、11 项 PLC/L2 报告和 8 项目标机报告；所有场景默认失败且无证据。初始化器拒绝非空目录，不覆盖旧结果，从流程上确保每个候选包拥有独立证据集，避免现场复制模板时混用版本或遗漏目录。

`add-functional-scenario-evidence.ps1` 进一步把原始日志、证据生成和场景报告更新合并为一个原子操作：只允许 scope 内 raw log、报告执行窗口内的观测时间和未挂接的精确场景；更新失败会清理刚生成的孤立证据。批准时间一旦写入，报告冻结，避免签字后悄悄补换证据。

绑定当前工程候选包和已有模拟稳定性报告后，机器判定为 `1/6` 通过、剩余 `5/6`：发布身份一致已经通过；真实算法审计、真实八相机无跳项 24/24、真实 PLC/L2、真实完整班次和目标机生命周期仍为 No-Go。其中现有稳定性报告被明确拒绝为生产班次证据，原因是 provider 为 simulated、运行不足 28,800 秒且不足 100 个实际周期。最新机器报告统一归档在 `target/logs/functional-go-live-current`，每次候选包变化后必须重新生成，不能沿用旧包结论。

### 1.1 功能性上线差距总表

| 功能域 | 当前状态 | 上线判定 | 最小完成定义 |
| --- | --- | --- | --- |
| 八相机采集 | 当前实机已完成 184/184 个完整帧事务，八台各 23 组 depth/intensity/metadata、零失败；启动自动连接和精确 8/8 readiness 已实测 | **基本具备，异常与稳定性待验** | 归档无 skip 的正式 24/24 管理矩阵，并完成断线、硬超时、标定崩溃恢复和连续班次证据 |
| 3D 重建 | 当前真实八相机材料已完成标定 8/8 和软件验收 20/20，mesh 为 92,736 顶点、177,430 三角形，拼缝最大值 0.133094 mm | **待实物尺寸验证** | 用有缺陷和无缺陷实物分别复核直径、缺陷尺寸、坐标和耗时；软件质量门禁不能替代量具与标注集验收 |
| 缺陷检测 | 已有真实几何异常候选检测，生产 mock 默认关闭；兼容 ID 为 `pit/foreign`，但输出和界面已明确标记为未分类的凹陷/凸起候选 | **阻断** | 冻结实际要求的缺陷类别；每类有标注样本、判定规则或模型、分类置信度和误报/漏报指标；未知类别继续进入人工复核而非错误分类 |
| 缺陷复核 | 缺陷级产物生成、兼容入库、API 和前端优先加载已实现；旧记录可降级 | **阻断于实物验收** | 用真实缺陷证明 cameraId、sequenceNo、ROI、原图、局部点云和长/宽两个高度剖面准确；历史记录可复现同一证据 |
| 生产触发链 | 持久任务链和幂等/阻塞逻辑已实现 | **阻断于现场验证** | 真实 PLC/L2 完成 steel-info → steel-in → capture → algorithm → result/report → steel-out；重复、乱序、断网和重启不产生重复检测或丢单 |
| 记录与告警 | 数据库存储、查询、缺陷入库、告警确认/关闭和审计已实现；生产模式每 10 秒把存储、采集、任务执行器、标定协调、触发、算法资格和生产策略异常同步为持久健康告警 | **基本具备** | 用真实算法结果证明记录、告警、3D 产物和钢管号一致；用现场故障注入证明健康告警持续期间不重复刷屏、恢复后自动闭环、再次发生生成新 episode，重启后仍可完整查询 |
| 参数与标定 | 相机参数、ROI、标定应用/回滚、版本台账已实现；采集/算法根和阈值已由 Rust 统一返回 desired/active/readback | **待现场确认** | 在目标机验证换目录、换配置和换规格后的 active/readback 与实际文件一致，不再依赖开发机固定盘符 |
| 报表 | 查询、页面汇总、CSV/JSON 导出、后端不可变签发/历史/正文校验已实现；归档快照包含实际记录、算法/标定追溯字段和缺陷产物引用；前端可生成与归档哈希绑定的 A4 横向打印 HTML；独立归档校验/备份/恢复工具及正负回归已完成 | **打印与灾备代码具备，现场模板/恢复演练待完成** | 在新机联合恢复数据库和报告归档；核对历史/正文/打印一致性、PDF 分页、中文字体、签字栏和证据路径，并冻结报告抬头、质量结论及证据缩略图模板 |
| 异常恢复 | 任务重启恢复、标定账本和部分排空/备份能力已实现 | **待现场验证** | 相机断线、磁盘慢/满、算法失败、服务重启后状态明确；可重试且不重复副作用；操作端给出可执行恢复提示 |
| 连续运行 | 有稳定性测试脚本，缺当前八相机连续班次数据 | **阻断** | 按实际节拍连续运行至少一个完整班次并覆盖换钢、重连和服务重启；统计成功率、耗时、丢帧、积压、误报/漏报和人工干预 |

### 1.2 功能优先级

1. **F0-1：定型实际要交付的缺陷类别和质量指标。** 如果合同只要求凹坑/凸起两类，应同步精简界面字典和验收口径；如果要求划伤、辊印、烧伤、气泡、夹杂等多类，必须补真实分类器，不能沿用模拟生成器的类别名称。
2. **F0-2：缺陷级证据包代码完成，进入实物验收。** 算法已输出 `cameraId/sequenceNo/sourceFrame/roi/localPointCloud/lengthProfile/widthProfile`，入库保存稳定相对路径与源帧哈希，前端按缺陷 ID 优先加载；下一步用真实样本量化 ROI 和剖面误差。
3. **F0-3：归档八相机正式管理矩阵并完成真实 PLC/L2 全链测试。** 真实八相机完整采集和重建功能已证明；剩余 24/24 管理项、最终点表和异常恢复仍必须使用最终设备与当前软件版本，不接受 simulated provider 替代。
4. **F0-4：完成现场节拍和连续班次试运行。** 以每支钢管的采集、重建、检测、入库和结果回传总耗时为主指标，并记录队列最大深度和恢复时间。
5. **F1：统一配置和正式报表的现场收口。** 代码已消除运行链路中的固定盘符和固定报表元数据，并提供从校验归档生成的签字打印底稿；下一步验证目标机回读、打印分页与证据路径，再冻结现场 PDF 模板。

### 1.3 功能验收数据结构

每个生产缺陷至少需要形成以下可复核记录：

```json
{
  "defectId": "ALG-0001",
  "inspectionId": "INSP-...",
  "materialId": "MAT-...",
  "type": "pit",
  "classificationVersion": "...",
  "severity": "review",
  "confidence": 0.93,
  "cameraId": "camera3",
  "sequenceNo": 18,
  "roi": { "x": 120, "y": 48, "width": 64, "height": 52 },
  "sourceFrame": "camera3/.../intensity/000018.png",
  "roiImage": "defects/ALG-0001/roi.png",
  "localPointCloud": "defects/ALG-0001/points.json",
  "lengthProfile": "defects/ALG-0001/length-profile.json",
  "widthProfile": "defects/ALG-0001/width-profile.json"
}
```

验收时随机抽取缺陷，必须能从数据库记录回到同一原始帧、同一 ROI、同一局部三维数据和同一算法版本；删除或归档策略也必须把这些文件视为一个整体。

## 2. 已验证的当前基线

| 检查项 | 当前结果 | 说明 |
| --- | --- | --- |
| React/Vitest | 187/187 通过 | 30 个测试文件全部通过；包含自动恢复的 `system-health` 历史 episode、存储预警容量/剩余时长展示、候选分类标记、报告签发/历史/正文读取、损坏归档提示、打印按钮门禁、打印 HTML 完整明细与转义、缺陷级产物、通知状态、首次登录强制改密和依赖阻塞终态回归；现有图表尺寸和 `act(...)` 告警不影响通过结论 |
| Rust 业务服务 | 140/140 通过 | 覆盖健康异常持久告警 episode、自动恢复闭环、Supervisor 重启预算状态校验与持久告警、存储 warning/critical 分级、径向候选不冒充材料缺陷分类、内容寻址不可变报告、统一算法运行配置及路径覆盖拒绝、任务、链式依赖/阻塞/重试、权限、告警、健康检查、标定账本、存储容量水位、持久化产物清理、SQLite 在线快照、schema ledger、严格 drain、生产状态机、受控算法进程树、有界输出和 synthetic 输出策略 |
| Rust 触发网关 | 17/17 通过 | 覆盖路由、模式、转发元数据、HMAC、时间窗、nonce 重放、来源 CIDR、TCP/UDP 信封、独立运维凭据、严格 drain/inFlight、steel-out 收尾白名单和无通配 CORS |
| 前端生产构建 | 通过 | Vite 构建成功；3D chunk 大于 500 kB，仅属于后续优化项 |
| C++ 采集层 | 9/9 通过 | 独立 Release 构建完整通过 storage thread pool、owned worker registry、path policy、calibration contract、health policy、concurrency policy、Supervisor recovery policy、frame pipeline 和 calibration target detection；simulated 回归可与在线真实 provider 隔离运行 |
| 架构发布门禁 | 9/9 通过 | 新增 `windows-runtime-supervisor` 源码契约；连同生产触发安全和 `persistent-data-lifecycle` 检查声明的服务边界、清理账本、文件指纹、数据库确认顺序以及 SQLite/MySQL 备份恢复边界。它不是实际 SCM 生命周期验收 |
| 当前运行包 | 最新隔离工程候选包布局、哈希、可执行合同和完整任务链验收通过 | 在线采集仍从 `target/capture/Release` 运行时，最新 C++ 候选在 `app/capture/build/Release` 独立构建；工程包 manifest 记录 `build.captureBuild.root=app/capture/build`，包内采集 EXE 哈希与隔离候选完全一致且与在线旧 EXE 不同。48 项必需布局、41 个 PowerShell 脚本、122 个包内文件、静态 package-only、功能验收工作区/Go-No-Go/场景挂接/WorkRoot 稳定性合同，以及包内 Release Service/Trigger 的真实 HTTP 任务链均通过。任务链生成 8 个完整帧、8 个 metadata、24 条文件记录，并证明 `steel-info -> steel-in -> capture-once -> steel-out` 的精确持久依赖顺序。`packageClass=engineering` 且构建来源仍为 `prebuilt-engineering-only`，无桌面 bundle或同次正式全量构建来源；仅是最新功能候选证据 |
| 正式发布完整性 | 代码路径已接入，真实产物未生成 | formal-release 要求 clean/tag/非 `0.1.0`、禁止 SkipBuild、清理构建根后本次重建、二次 HEAD/clean 复核、双向 checksum、SHA-256 Windows catalog、部署侧证书 allowlist 和安装前完整验证 | 当前无真实证书、签名 catalog、正式 MSI/NSIS 或可复核 formal-release 包，仍为 No-Go |
| Tauri Release | no-bundle Release 成功，bundle 未完成 | 完整构建 56.64 秒，`target/cargo/release/steel-plate-3d-inspection-tauri.exe` 为 23,113,728 bytes，production devtools=0；offline WebView2/perMachine/no-downgrade/publisher 及正式签名门禁已配置。bundle 下载到 WixTools314 后网络停滞并主动终止，bundle 目录不存在，MSI=0、NSIS=0。这不是源码编译失败；EXE 为 NotSigned 且依赖 VCRUNTIME140.dll |
| Windows 服务宿主 | 版本化部署、排空与轮转本机回归通过，现场生命周期仍未验收 | Supervisor Release 编译和综合脚本通过；Trigger→Service 排空、连续 4 次零状态、排空超时反例、50 MiB 在线轮转与 5 代保留已测。安装器已实现源/暂存/最终多段完整验证、`releases/<version>-<commit12>`、全局 mutex、持久 journal、pre-DB 恢复和 SCM 直指版本目录 | 用真实签名 formal-release 包在管理员目标机证明 install/upgrade/rollback/uninstall、SCM stop 最坏约 90 秒预算、effective ACL、整树回收、五端口释放与逐 phase 故障恢复 |
| 真实八相机功能采集 | 通过，正式现场矩阵未全部关闭 | `BAR-20260716-114758`：184/184 完整帧，八台各 23 组 depth/intensity/metadata，零失败；还需标定崩溃恢复、正式 24/24 管理矩阵和连续班次 |

本表只证明软件单元测试和静态构建状态，不代表算法精度、真实相机 SDK、设备掉电恢复、现场节拍或长期稳定性已经达标。

### 2.1 收口执行状态（2026-07-16）

| 批次 | 已完成 | 尚未完成/验收边界 |
| --- | --- | --- |
| A-1 算法生产策略 | mock 缺陷默认值改为 `0`；只有 `development/dev/test + demo` 允许测试夹具；版本化配置、`algorithm`/`productionPolicy` readiness、准入校验、包内实际文件比对、逐运行 qualification 和输入前后哈希复核已经加入 | 用冻结标注集生成有真实指标和两方签字的 `status=pass` 报告；在最终包与一次真实运行上归档完整绑定证据 |
| A-2 架构门禁 | 源码契约新增生产触发安全、数据生命周期和 Windows SCM 宿主契约，当前 `9/9`；commit-pinned Windows workflow 已纳入前端/Rust/C++/Tauri、离线供应链、部署事务、灾备、卸载和 Supervisor 合同 | 取得远端 CI 全绿 run，并在最终 clean/tag Release 打包与 package-only 验包时再次运行、归档 |
| A-3 八相机门禁 | 真实材料 `BAR-20260716-114758` 已自然完成 184/184 个完整帧事务，八台各 23 组 depth/intensity/metadata、失败 0；3 号相机同样为 23/23。provider 启动按 active profile 自动连接精确八台，7/8 时 readiness 关闭，恢复 8/8 后自动恢复连续采集 | 完整采集功能已通过；仍须归档 `-RequireFullCoverage` 无 skip 的正式 24/24 管理报告、标定崩溃恢复和连续班次稳定性证据 |
| B-1 生产凭据与数据库 | 空生产库必须从秘密注入获得强初始管理员密码，仅创建一个管理员；首次会话只能改密/退出；生产启动拒绝开发默认密码、MySQL `root/nercar`、远程非校验证书 TLS；状态接口隐藏数据库凭据 | Windows 凭据存储接入和部署侧秘密轮换/恢复演练仍需完成 |
| B-2 生产任务链依赖 | 已持久化 `chainId/dependsOnTaskId/dependencyPolicy/blockedReason`；同一 material/session 禁止分叉；安全关键任务仅允许 `require-success`；前置失败、取消或中断会递归阻塞下游，重试父任务会重排阻塞后代；重启恢复和安全清理旁路均有 Rust 回归 | 最终 Release 包仍需运行集成 smoke，归档真实 HTTP 链路中的精确依赖顺序证据 |
| B-3 现场触发安全 | 生产启动强制配置不同的 32 字节以上外部 HMAC 密钥和内部运维令牌；HTTP/TCP/UDP 使用 HMAC-SHA256、时间窗和单次 nonce；非本机绑定强制 IP/CIDR allowlist；重放与非法来源明确拒绝；生产模式切换默认锁定；手工操作经 Rust `admin.services` 授权、审计并只在 loopback 转交运维令牌；状态脱敏且移除通配 CORS；独立进程 smoke 已覆盖三种传输 | 仍需由自动化/电气负责人冻结真实 PLC/L2 点表、地址、时钟源、秘密轮换流程和 ACK/重试时序，并在最终 Release 包及目标 OT 网段复跑安全报告 |

状态判定原则：代码防护完成不等于对应 P0 整项完成；凡是依赖真实设备、质量签字、部署签名或恢复演练的条目，在证据归档前保持“未关闭”。

### 2.2 本轮进程级功能证据（2026-07-16）

- 独立端口 `4973`、独立 SQLite 状态目录和 Release Service 的生产配置 smoke 已验证后台健康告警线程：启动宽限后生成 `algorithm-not-qualified`、`production-policy-invalid` 两个 `system-health` episode；跨两个 10 秒监视周期总数始终为 2，报警 ID 完全一致，没有按轮询重复插入。进程在验证后按 PID 关闭，在线 4873/八相机采集未被重启。
- `test-bar-surface-e2e.ps1` 已改为读取服务端 active/readback 路径，不再固定或覆盖 `H:/`、`G:/...`；业务顺序调整为进钢、采集、算法/入库、可选正式归档、出钢，异常路径在 `finally` 用精确 material/session 收尾。
- 新采集实跑连接八台相机，其中七台生成完整 depth/intensity/metadata；`192.168.103.100` 在 `retries=2` 时仍以 `attemptsUsed=3` 返回 `40030/DEV_LOAD_DATA_ERROR`。脚本保持失败且没有把 7/8 降级为通过，遗留活动会话已自动关闭。
- 为隔离相机故障，使用此前完整的 `BAR-20260716-102857`（每台 2 组 depth/intensity/metadata）执行 `-SkipCapture` 后半链。八相机标定匹配 8/8，Python 重建验收 20/20，C++ core 输出 1,526,560 bytes，mesh 为 27,648 顶点、48,874 三角形，输入产物哈希和 artifact index 通过。
- 轮廓裁剪曾把校准扇区端点排除后错误报告约 15.33 mm 拼缝。实现现已区分 `analysisValidMask` 与结构 `validMask`：缺陷检测仍使用严格轮廓点，网格只恢复两侧同时存在的校准缝合锚点。本次恢复 286 对，`closedSurfaceSeam` 通过，拼缝最大值为 0.950134 mm；回归测试证明结构锚点不会进入缺陷候选。
- 当前服务为 development/demo，缺 release commit、正式 acceptance report、dataset/evaluator 和批准 core hash；本次仅以显式 `AllowDevelopmentQualificationGaps` 证明功能链，报告标记 `qualificationMode=development-functional`，不能作为生产算法资格证据。
- 后续单帧对照发现 3 号和同型号 7 号在无钢材条件下都返回 `40030`；生产采集工作线程随后超过硬超时，provider 进入 `49007/SDK_CAPTURE_RESTART_REQUIRED`。这说明当前证据不能把首轮 7/8 简化为“3 号相机硬件故障”，还必须区分无目标取数、生产采集线程争用和设备链路。
- 按相同 Release 二进制、端口、`H:\` 存储根和现有配置根重启 provider 后，熔断清零，批量连接返回 discovered=8、connected=8、failed=0，八台参数 readback 均可用。该结果证明连接层可恢复，但不替代有料完整帧验收。
- 发现并修正健康误报：旧实现即使嵌套状态已为 `restartRequired:true`，仍可能返回 `ready=true/sdkReady=true`。C++ 现在把硬超时重启条件纳入有效 SDK readiness；Rust 同时解析顶层和 `sdkCaptureState.restartRequired`，兼容拒绝旧 provider 的陈旧 `sdkReady`；综合就绪脚本要求无重启标志且精确 8 台连接。
- 同时关闭单帧并发争用：真实 provider 的阻塞式 depth/preview 在后台连续生产采集运行时直接返回 `409`，要求先通过 capture-mode 的有界停止切到 `on-demand`；不再让诊断请求与生产 worker 同时进入同一相机 SDK，并避免把互斥等待误判成 SDK worker 硬超时。新版 Release 进程实测 3 号诊断请求在 156 ms 内被拒绝，随后仍为 `ready=true`、`restartRequired=false`、8/8 连接。再按正确路径切到 `on-demand` 后，3 号在无目标条件下返回 `40030`，恢复 `continuous` 后仍保持健康、无重启标志和 8/8；模拟夹具保留并行路径以维持测试覆盖。
- provider 启动现在读取 active profile 并执行 `autoConnect`：只有连接数精确等于期望的 8 台且无标定恢复/重启 fence 才返回 `ready=true` 并启动 continuous worker。实机可逆验证中，断开 3 号后立即变为 `cameraCount=7`、`cameraSetReady=false`、`ready=false`，重新连接后恢复为 8/8、`ready=true` 和连续采集。
- 随后的真实材料 `BAR-20260716-114758` 自然出钢并完成会话：`captureCount=184`、`successCount=184`、`failureCount=0`，八台相机各 23 个 depth、23 个 intensity 和 23 个 metadata，存储队列清空且无黑帧/丢弃帧。该证据关闭了此前 3 号相机与八相机完整帧功能疑问。
- Rust 服务通过显式的算法根、配置、标定和采集根启动后，active/readback 返回 `steel.algorithm-runtime-config.v1` 且路径全部 ready。同一材料执行后半链通过 20/20：八相机标定匹配 8/8，轮廓裁剪来源为 `calibrated-3d`，直径 115.232049 mm，mesh 为 92,736 顶点/177,430 三角形，拼缝 mean/p95/max 为 0.059691/0.122054/0.133094 mm，真实缺陷 0、synthetic 0。该运行是 `development-functional`，仍不替代冻结数据集和质量签字。
- Supervisor 已加入只针对 `HTTP 200 + restartRequired=true + sdkCode=49007` 的受管恢复策略，连续观测两次才重启整个 runtime group，并沿用既有重启预算；`recoveryRequired` 或 `invalidManifest` 明确禁止走此通道。策略单测与 Supervisor 自检通过，目标 SCM 上的真实故障注入和恢复后新鲜采集仍需归档。
- Supervisor 现在把重启预算状态原子写入 `StateRoot/service/supervisor-status.json`。预算耗尽状态跨宿主退出保留，重启后只有整个 runtime group 连续稳定 30 秒才清除；Rust 将其映射为 `supervisor-restart-budget-exhausted` 持久告警，状态文件损坏或契约不合法映射为 `supervisor-status-invalid`，恢复后沿用统一 episode 自动闭环。Supervisor 自检、综合脚本、Rust 140/140 和架构 9/9 已通过；仍需目标 SCM 连续故障注入证明外层 failure actions 不形成无限重启。
- C++ simulated frame pipeline 曾复现出钢后异步队列迟到提交一帧。现在每个保存会话携带独立 generation，采集完成前和异步存储最终提交后均复核当前会话；出钢或切换会话后，旧 generation 的迟到文件被删除、不计成功数，连续采集继续进入 discard。该竞态回归连续 3 次通过。
- 采集发布构建与在线运行目录已解耦：`build-capture-headless.ps1 -BuildDir` 可在不覆盖在线 EXE 的目录生成候选，工程包用 `-CaptureBuildRoot` 显式选择该候选并把相对根和配置写入 manifest。正式包禁止使用非 canonical 根，仍必须从 clean/tag 提交清理并重建 `target/capture`。最新隔离工程包已证明包内采集 EXE 来自 `app/capture/build`，在线 PID 和八相机 readiness 未变化。
- 包内 Release 任务链验收首次执行暴露并修正两个启动契约：模拟 Service 现在显式使用 `development + demo`，不再因 Release 默认 production 而把空验收库误当生产库；Trigger 隔离启动现在同时迁移 HTTP/TCP/UDP 三个监听端口，不再只改 HTTP 而碰撞在线 4882/4883。复跑在 5073、5081/5082/5083 上通过，四个 durable task 共用稳定 chainId，依赖顺序精确为 `steel-info -> steel-in -> capture-once -> steel-out`，策略为 `require-success`。
- 候选包多轮稳定性检查现区分真实相机文件与 simulated URI 账本：真实 provider 仍强制逐相机校验 controlMode、triggerInputType、triggerLines 和物理 depth/intensity/metadata；simulated provider 不伪造这些硬件字段或物理文件，而是严格校验每轮 24 条 `simulated://<material>/...` 记录、summary 计数和材料 URI 命名空间。稳定性门禁进一步要求每轮及最终状态的 `activeSession=null`、`queueDepthAvailable=true`、`queueDepth=0`、`activeTaskId=null`、worker running 和 `admission.inFlight=0`；material/session/inspection 标识不仅要跨轮非空且唯一，steel-in 返回值与 summary 顶层/session/inspection 三处身份还必须完全绑定当前轮次，防止唯一 ID 下的跨钢板串账。
- 隔离候选包历史上已完成 20/20 快速循环（160 完整帧、160 metadata、480 账本记录）及重新打包后的 5/5（40 完整帧、40 metadata、120 记录）。新增收敛和身份绑定门禁后，当前包又完成 10/10（80 完整帧、80 metadata、10 组唯一三元标识、身份绑定失败 0），最终队列 0、活动任务为空、in-flight 0、活动会话为空；新报告 `production-stability-20260716-195635-841.json` 的 SHA-256 为 `473cae43ad767f4510e7615dd0c65d486c09a6f54d3ae1d766358efd0e1a815f`。
- 包内验收曾把 SQLite、日志和 simulated summary 写入 RuntimeRoot，导致验收后 checksum inventory 正确拒绝包被修改。现已引入包外 `WorkRoot`：packaged smoke 和 packaged stability 默认使用各自的系统临时根，也可显式传入证据目录；子进程工作目录、数据库、日志、报告和 simulated 账本全部位于包外。当前候选包稳定性验收前后 `checksums.sha256` 文件哈希均为 `4ce56738fedbd1b07dcd927726a8cc43e56bf6345da862576a3c740d82f418ae`，文件数均为 111，验收后再次 package-only 验包通过，证明稳定性测试不会污染不可变运行包。
- 稳定性脚本不再无条件按 `CaptureRoot` 重算 summary 路径，而是优先使用 provider 返回的 `summaryOutput`，并在其为相对路径时绑定当前 `WorkRoot`；source/package 两种 smoke 均把子进程工作目录放到隔离运行根。KeepRunning 成功报告包含本轮包装进程和四个监听端口，可精确清理而不触碰机器上已有运行实例。
- 新增 `test-production-stability-workroot-contract.ps1`，把有界 KeepRunning 返回、进程/端口收据、相对 summary 解析、WorkRoot containment、单轮生产收敛和 finally 端口释放固化为可重复的包内合同，避免依赖人工后台启动技巧。

硬超时后的稳定恢复闭环定义如下：

1. provider 以 `ready=false`、`sdkReady=false`、`sdkCode=49007` 和 `restartRequired=true` 关闭生产准入；Rust layered readiness 返回不可用。
2. 保留失败批次、相机级错误和会话收尾证据，通过受管服务执行进程重启；不得用此路径绕过标定 `needs-reconciliation` 或损坏 manifest。
3. 重启后必须重新发现并连接精确 8 台，检查 IP/型号/参数 readback，再用实际钢材运行新一轮 8/8；只有完整 depth/intensity/metadata 才算恢复完成。
4. 当前已归档一根材料连续 23 轮 8/8；还需一次由受管 `49007` 重启触发的恢复后新鲜 8/8，以及无 skip 的管理/标定异常矩阵，才完全关闭 A-3。

## 3. 上线差距分级

### 3.1 P0：正式上线前必须完成

| 编号 | 缺口 | 当前证据 | 收口目标 |
| --- | --- | --- | --- |
| P0-01 | 生产算法可信度未完全闭环 | synthetic 默认关闭，版本化阈值、准入报告、安装包实际文件/commit 比对、readiness、逐运行 qualification、输入明细与前后哈希复核代码已落地；模板仍为 pending | 生成绑定 release/dataset/evaluator/script/core/config/calibration 的真实通过报告，填入有效指标和两方签字；在最终包/现场输入上完成精度与追溯验收 |
| P0-02 | 八相机完整采集与候选包多会话稳定性已通过，实机异常和整班验收未闭环 | 当前真实材料已取得连续 23 轮 8/8、184/184 完整帧且零失败；精确 readiness 与启动自动连接已实测。候选包 simulated Release Service 已完成 20/20、包内 5/5，以及带队列/任务/会话收敛和身份隔离门禁的 10/10；最后一轮验收前后包哈希与 111 个文件均不变 | 归档当前提交对应的无 skip 24/24 管理报告、标定崩溃/受管重启恢复证据，并在真实相机与现场节拍下完成完整班次稳定性试运行 |
| P0-03 | 发布流程代码已收口，最终发布证据未生成 | manifest 区分 `formal-release`/`engineering`；正式包禁止 SkipBuild/dirty/debug/无 bundle，清空五个 build roots、执行 npm ci 后本次全量重建，构建后和写 manifest 前复核同一 HEAD/clean，并绑定 releaseVersion/gitTag/commit、四个 lock、tauri.conf/Tauri Cargo manifest 哈希；双向 checksum 与 signed catalog 已接入；WiX/NSIS/WebView2 外部清单、包外 hash、清理后精确播种和构建后复验测试已通过 | 把各清单版本从占位 `0.1.0` 升为批准版本，清理并评审 worktree，由发布负责人批准真实离线工具链清单，在精确 tag 的 clean commit 上运行完整正式构建与 package-only 复验，归档构建报告 |
| P0-04 | 正式部署物代码路径已补齐，签名、bundle 与服务安装证据待完成 | Tauri/VC++、五个首方后台 EXE、vendor SDK DLL 和 catalog 的 Authenticode+可信时间戳/部署侧 signer 门禁均 fail-closed；安装器先验证只读源包，再发布并复验不可变版本目录，之后才切换 SCM/注册表。当前本地产物仍 NotSigned，无真实证书/签名 catalog/vendor 证据；MSI/NSIS 为 0 | 生成可 package-only 复验的正式包：一个签名 MSI、一个签名 NSIS、签名桌面/后台 PE、Microsoft 签名 VC_redist、vendor allowlist 和签名 catalog；完成断网目标机两阶段安装、ACL/迁移、SCM、drain、轮转、恢复、升级和卸载 |
| P0-05 | 生产凭据与数据库安全尚未完成部署闭环 | 运行时 fail-closed、单管理员安全引导、首次登录强制改密、默认凭据拒绝、远程 MySQL 证书校验和 URL 脱敏已完成 | 接入部署秘密存储并完成凭据轮换/恢复演练，归档现场证据 |
| P0-06 | 现场触发安全代码已收口，真实协议与 OT 部署证据待确认 | HMAC-SHA256、时间窗、全传输 nonce 防重放、IP/CIDR allowlist、生产秘密 fail-closed、模式锁定、独立运维凭据、管理员授权/审计、状态脱敏及无通配 CORS 已落地；网关 `17/17`、安全进程 smoke 和架构 `9/9` 均通过 | 冻结真实 PLC/L2 点表与时序、NTP/时钟误差、来源地址、秘密下发/轮换和 ACK/重试策略；在目标 OT 网段用最终 Release 包复跑安全 gate 并归档 |
| P0-07 | 数据与磁盘生命周期代码已收口，现场演练待归档 | 容量水位、持久化 `record_cleanup` 和文件 hash 清理门禁已实现。`steel.database-backup.v2` 绑定 active release/commit/transaction、schema contract/index 和 payload；SQLite 在线快照执行完整 integrity/foreign-key/账本验证并有 10 项原子恢复/共享互斥契约检查；MySQL 代码要求全 InnoDB、临时库恢复证明和非原子恢复前置备份 | 冻结现场目录白名单、warning 水位及分类保留期限；在目标机完成 SQLite 在线备份/新机原子恢复、MySQL 临时库证明/DBA 回退和数据库/产物一致性演练并签字 |
| P0-08 | **多步骤生产任务依赖功能与工程候选包证据已收口** | 持久化链字段、单链约束、`require-success` claim 门禁、递归 `blocked` 传播、父任务重试后代重排、重启恢复和安全旁路限制均已实现；Rust `140/140`，前端识别 `blocked` 终态。最新工程候选包已用 Release Service/Trigger 在隔离端口完成真实 HTTP smoke，证明四任务稳定 chainId、精确直接前驱、8 个完整模拟相机帧和 24 条文件记录 | 正式发布时只需在最终 clean/tag formal-release 包重复同一验收并归档，不再存在待实现的软件功能 |
| P0-09 | 尚无可复核正式发布实例 | 当前工作区包含大量修改、删除和未跟踪文件，版本仍为被正式门禁拒绝的 `0.1.0`，无匹配 release tag、真实证书/签名 catalog；已新增 Windows 托管软件门禁 workflow，并在本机证明其 SDK-independent C++ 路径 5/5，但尚无远端 CI run；离线 CycloneDX 生成/复验代码与 11 项负向测试已完成，当前可枚举 948 个组件，但 external policy 仍是未批准示例；现有工程包仍只是 engineering | 冻结批准版本和六类外部组件真实版本/hash/许可证，形成 clean 发布提交/精确标签，取得远端 CI 全绿记录，并在受审计构建机生成 formal-release 包、SBOM、签名/catalog/package-only 报告和可追溯构建日志 |
| P0-10 | 版本切换和数据库升级尚未形成断电安全闭环 | U1 drain/轮转已完成本机回归；U2 schema ledger、包内 contract/index 和 v2 灾备代码已完成；U3 已实现不可变版本目录、三段完整验证、全局 mutex、持久 journal、pre-DB 恢复及 SCM 直指。安装器只在 catalog 验真后执行 DB 契约验证，并在状态变化前拒绝非空 migration index；升级或复用保留 StateRoot 的重装还必须证明旧 active schema 与目标相同。它仍不执行 DB migration，且无签名开机 recover-only | 完成签名迁移器、把 drain/备份/DB phase/health acceptance 编排进一个 journal，提供 signed recover-only 和逐 phase kill/断电故障注入；用真实签名候选包在管理员目标机证明 committed/rolled-back/failed-safe 收敛 |

### 3.2 P1：生产试运行期完成

| 编号 | 缺口 | 收口目标 |
| --- | --- | --- |
| P1-01 | **已完成可安全中断的算法计算取消、整树回收、硬超时和输出内存边界** | Python 重建、标定拟合和 C++ core 每次运行都绑定独立 Windows Job Object，`KILL_ON_JOB_CLOSE` 保证取消、超时和父进程退出时不遗留派生进程；Job 创建/配置/绑定失败会拒绝运行。进程持续排空 stdout/stderr，默认 1800 秒硬超时；每个输出流只保留最后 4 MiB，同时记录总字节数和截断标志。队列取消或运行时 drain 可终止纯计算、恢复旧 `latest` 指针并落为 `cancelled`；drain 状态先发布、再等待生产命令屏障，避免计算任务因锁顺序看不到取消。标定拟合成功输出如果被截断或不是合法 JSON 会明确失败。相机采集和标定设备激活越过写入边界后仍以真实 provider 结果为准，不执行危险强杀 |
| P1-02 | 缺陷 ROI、局部点云和局部高度剖面代码已贯通，实物精度未验收 | **按功能优先口径提升为上线阻断项**；用真实缺陷验证帧/ROI 映射、局部点云坐标和双剖面尺寸误差，旧记录降级展示不得被当成缺陷级证据 |
| P1-03 | 存储根目录和重建参数统一配置及运行门禁已完成，现场回读未验收 | Rust 已返回 `steel.algorithm-runtime-config.v1` desired/active/readback；配置文件、采集根和输出根类型错误会关闭 readiness 并拒绝生产算法，调用方不能覆盖活动路径；安装器创建输出根并自动加入产物白名单。剩余工作是在目标机执行换目录/换配置验收 |
| P1-04 | 统一守护、严格排空、在线轮转和重启预算持久告警代码已实现；`49007` 已正确关闭 C++/Rust/验收脚本 readiness，手工恢复已验证 8/8 重连；Rust 已把磁盘 warning/critical、写队列拒绝、采集不可用/重启要求、任务 worker、标定协调、触发、算法资格、生产策略和 Supervisor 预算耗尽/状态非法写入持久告警，按 episode 去重并在恢复后自动补齐闭环 | 在目标机验证统一 SCM 服务和约 90 秒最坏 stop 预算；证明受管重启不会绕过标定 reconciliation，并归档恢复后新鲜 8/8；归档 50 MiB × 5 代持续运行切换证据；用连续故障证明预算耗尽告警与 SCM failure actions 最终稳定停止，并冻结日志保留天数 |
| P1-05 | 数据库版本契约、账本和 v2 灾备代码已起步，迁移执行仍需产品化 | 完成签名离线迁移器；SQLite 事务迁移/逐点故障注入，MySQL expand-contract/GET_LOCK/真实临时库恢复；冻结每版本可读/回滚窗口与 GTID/binlog/加密要求 |
| P1-06 | 供应链代码门禁已落地，审批与持续治理待完成 | 当前离线 CycloneDX 1.5 已覆盖 npm、三份 Cargo lock 和 C++ 工具链/相机 SDK/VC Runtime/WebView2/WiX/NSIS 六类外部组件；继续接入漏洞/许可证审批、受审计镜像、正式包证据和每版本差异审查 |
| P1-07 | 现场运维文档不完整 | 完成开停机、换型、标定、故障恢复、磁盘清理、账号交接和紧急旁路 SOP |

### 3.3 P2：不阻塞首版上线的优化

- 前端 3D chunk 拆分和大体积 demo 图片延迟加载。
- 清理 React 测试中的 `act(...)`、零尺寸图表告警。
- 将超大 Rust/C++ 单文件按领域拆分，降低维护和回归风险。
- 补充界面无障碍、键盘操作、多分辨率和长时间渲染内存测试。
- 增加趋势分析、远程只读运维、告警外发和生产统计看板。

## 4. P0 收口设计

### 4.1 生产算法与结果可信度

#### 4.1.1 运行模式隔离

新增显式运行档位：

```text
STEEL_RUNTIME_PROFILE=development | acceptance | production
STEEL_ALGORITHM_MODE=demo | validation | production
```

生产档必须执行以下规则：

- `mockDefectCount` 必须为 0；请求传入非零值直接返回 400，不能静默覆盖。
- 算法输出只要出现 `syntheticDefectCount > 0` 或任一 `geometry.synthetic=true`，任务必须标记为 `algorithm-failed`，不得生成生产告警或质量结论。
- 模拟 provider、`simulated://` 产物、demo 图片和点云不得进入生产记录。
- `/api/health/ready/details` 增加 `algorithm` 和 `productionPolicy` 检查，生产策略不满足时 readiness 返回 503。

#### 4.1.2 结果追溯字段

每次算法运行至少持久化：

```json
{
  "algorithmName": "bar-surface-defect-detector",
  "algorithmVersion": "release-tag-or-sha",
  "configRevision": "CFG-...",
  "configSha256": "...",
  "calibrationRevision": "CAL-...",
  "calibrationSha256": "...",
  "inputSummarySha256": "...",
  "inputFrameIds": [],
  "inputArtifactCount": 0,
  "inputArtifacts": [
    {"camera":"...","frameId":"...","kind":"depth","bytes":0,"sha256":"..."}
  ],
  "thresholds": {},
  "qualityGate": { "passed": true, "reasons": [] },
  "realDefectCount": 0,
  "syntheticDefectCount": 0
}
```

算法版本、阈值、标定版本和每个输入产物必须能从检测记录反查，配置变更应写入现有审计日志。输入文件在处理前计算逐文件哈希，算法完成后再次复核，避免处理期间的替换；汇总哈希不能替代构成它的 camera/frame/kind/bytes/SHA-256 明细。

#### 4.1.3 精度验收

冻结数据集、标注与 split、复现身份、许可门禁、统一性能协议和算法证据合同
以 [`design/research-reproducibility-and-evidence-chain.md`](design/research-reproducibility-and-evidence-chain.md)
为准；本文继续拥有正式生产 Go/No-Go 结论。

建立现场标注数据集，并由算法负责人和质量负责人共同冻结验收口径：

- 按缺陷类型、尺寸区间、深度区间、表面区域和钢种分层。
- 统计检出率、误报率、漏报率、定位误差、尺寸误差和端到端处理时间。
- 单独覆盖接缝、边缘、黑帧、强反光、轻微椭圆、相机缺帧和标定偏移。
- 阈值必须由版本化配置提供，不能依赖脚本内默认值。
- 验收报告绑定算法版本、数据集版本和标定版本；任何一项变化都触发回归。

具体数值阈值由现场质量标准签字确认，不能仅由开发侧自行定义。

#### 4.1.4 准入报告与运行绑定

正式安装必须传入 `steel.algorithm-acceptance.v1` 报告。仓库中的 `acceptance-report.example.json` 默认是 `pending-site-approval`，只用于说明字段，不能作为生产准入证据。真实报告至少绑定：

- algorithm name/version、生产配置 revision/SHA-256；
- Python script 和 C++ core 的 SHA-256、精确 release commit；
- 冻结 dataset/evaluator 的 revision 和 SHA-256；
- calibration revision/SHA-256；
- 检出率、误报率、漏报率、定位误差 P95、尺寸误差 P95、端到端延迟 P95，以及逐项通过标准；
- algorithm owner、quality owner 和批准时间。

报告中的负责人字段是流程审批记录，不是密码学签名；报告本身仍须纳入包哈希、ACL 和发布签名链。当前校验器、安装器、Python 运行和 Rust readiness/运行门禁已逐项比对 report/config/calibration/script/core/release commit/dataset/evaluator；每次生产运行保存 `acceptanceReportSha256` 和全部 qualification 字段。任一不一致会使任务失败和 readiness 关闭。该代码门禁仍不能替代真实标注集、有效指标和负责人签字。

#### 4.1.5 运行配置单一事实源

`STEEL_BAR_CAPTURE_ROOT`、`STEEL_ALGORITHM_DATA_ROOT` 和 `STEEL_ALGORITHM_CONFIG` 是生产运行的唯一活动输入，Rust 以 `steel.algorithm-runtime-config.v1` 同时返回 desired、active 和 readback。readback 不只检查字符串非空，还验证三条路径为绝对路径、实际存在且分别是预期的目录/文件；任一失败都会让算法健康项返回 `algorithm_runtime_paths_invalid`，并在生产算法真正启动前再次拒绝。

生产请求不得用 `captureRoot`、`outputRoot` 或 `calibrationPath` 切换到另一套路径；即使外部调用者保留旧字段，也只允许与活动配置指向同一路径。安装器从现场 `StorageRoot` 派生并创建 `reconstruction` 输出目录，自动加入 `STEEL_ARTIFACT_ALLOWED_ROOTS`，避免首次安装出现“配置正确但目录尚未创建”的假故障。操作端在 readback 未就绪时显示“配置或目录不可用”并禁用生产重建。现场验收需要修改目标目录和配置文件各一次，证明错误状态可见、任务被拒绝、修复后 active/readback 与真实输出一致。

### 4.2 生产任务链依赖

FIFO 之外的显式依赖状态机已经落地，`production_task` 当前持久化：

```text
chain_id
depends_on_task_id
dependency_policy = require-success | always-run
blocked_reason
```

推荐默认链路：

```mermaid
flowchart LR
  A["steel-info"] --> B["steel-in"]
  B --> C["capture-once"]
  C --> D["algorithm-run"]
  D --> E["steel-out"]
```

执行规则：

- 前置任务为 `succeeded` 才可 claim 后续 `require-success` 任务。
- 前置任务 `failed/cancelled/interrupted` 后，下游进入 `blocked`，不得调用相机或算法。
- 操作员通过任务重试恢复失败根节点；重试会重新排队其 `blocked` 后代，禁止直接改数据库状态。
- 同一 material/session 只允许一个活动生产链；PLC 重试继续使用稳定 `requestId`。
- `capture-once`、`algorithm-run`、`steel-info`、`steel-in`、`steel-out` 等安全关键任务禁止 `always-run`；该策略仅允许显式安全的 `trigger-event` 清理任务使用。

### 4.3 现场触发与外部系统

当前网关更接近通用 JSON 适配器。上线前必须冻结《点表与时序协议》，至少包含：

- PLC/L2/MES 的实际协议、地址、字段类型、字节序、编码和单位。
- `requestId` 生成方、幂等窗口、ACK/NACK、超时、最大重试次数和乱序处理。
- 进钢、出钢、钢材信息、二级数据、算法完成和质量结论的时序。
- 网络中断、服务重启、重复触发、出钢先到、钢号变化和手自动切换的安全状态。
- 时间同步要求以及 PLC、工控机和数据库的时间源。

已落地的安全边界：

- 生产档缺少至少 32 字节 `TRIGGER_SHARED_SECRET` 或独立的至少 32 字节 `TRIGGER_OPERATOR_TOKEN` 时拒绝启动；非 loopback 绑定缺少 `TRIGGER_SOURCE_ALLOWLIST` 时同样拒绝启动。
- HTTP/TCP/UDP 统一使用版本化 `steel-trigger-v1` HMAC-SHA256；签名绑定时间戳、nonce、传输类型和正文，默认 30 秒窗口内 nonce 只能使用一次。
- allowlist 支持精确 IPv4/IPv6 和 CIDR；HTTP 最大 1 MiB，TCP/UDP 单报文受协议上限约束。
- 生产模式切换默认返回 423，直接手工页面关闭；经 Rust 的模式、手工进出钢和操作员采集要求 `admin.services` 会话并记录审计，Rust 到网关使用只在 loopback 接受的独立操作凭据。
- 状态接口只返回 listener/security 布尔信息，不返回内部 origin、主机、端口或凭据；响应不再发送 `Access-Control-Allow-Origin: *`。

仍需现场冻结：

- 确认实际 PLC/L2 能否原生生成 HMAC 信封；若不能，明确由哪一层受控边缘适配器签名。
- 确认工控机、PLC/L2 的 NTP/PTP 时间源和允许漂移，避免时间窗被长期放宽。
- 将共享秘密接入批准的秘密存储，制定双密钥轮换窗口、吊销和恢复流程；当前实现不把秘密写入仓库、报告或状态接口。
- 冻结 OT VLAN、防火墙、来源地址和速率/连接级防护；应用 allowlist 不能替代网络隔离。
- 网关到 Rust 目前依赖同机/受控内网边界，若拆分到不同主机，应另行增加 mTLS 或独立内部凭据。

### 4.4 安全和账号初始化

生产启动时执行 fail-closed 校验：

- 禁止保留 `admin123`，禁止自动创建三个同密码账号。
- 首次部署通过离线初始化工具或一次性密钥创建唯一管理员；首次登录强制修改密码。
- 数据库密码只从受限环境变量、Windows Credential Manager 或秘密文件读取，不写入仓库、日志或命令行历史。
- MySQL 为远程地址时必须启用 TLS 并校验证书；缺少 TLS 参数时生产启动失败，而不是自动追加 `ssl-mode=disabled`。
- 会话令牌只保存在内存或受保护存储中；密码变更、账号停用和角色变更应立即撤销相关会话。
- Tauri 启用最小 CSP；静态 Web 部署时限制允许来源，不发送通配 CORS。

### 4.5 数据、磁盘与灾备

#### 4.5.1 存储水位

在现有 storage readiness 基础上增加：

- `freeBytes`、`freePercent`、预计剩余生产时长和最近写入吞吐。
- warning/critical 两级水位；critical 时禁止开始新的钢材会话，但允许当前帧事务安全落盘和出钢收尾。
- 分相机目录容量核对，防止某一路映射到错误卷或单盘耗尽。

当前软件分级已经完成：C++ 对全局及逐相机存储根返回 `capacityBytes/freeBytes/freePercent`，并统计最近 60 秒成功落盘字节；失败写入不计入吞吐。Rust 取所有根目录的最小值，发布 `recentWriteBytesPerSecond/estimatedRemainingSeconds`。warning 水位由硬阈值自动派生为“字节阈值的 2 倍”和“百分比阈值加 5 个百分点”，任一达到即返回 `level=warning`、`storage_capacity_near_watermark`，但保持 readiness 和当前生产链路可用；Tauri 顶部服务状态显示剩余 GiB、百分比和按近期吞吐估算的剩余小时。低于 `STEEL_STORAGE_MIN_FREE_BYTES` 或 `STEEL_STORAGE_MIN_FREE_PERCENT` 时进入 `level=critical`，以 `storage_capacity_below_watermark` 关闭 readiness，并只阻止新 `steel-info/steel-in`，保留当前会话重试和 `steel-out` 安全收尾。字段缺失仍 fail-closed。默认硬阈值 20 GiB/10% 只是工程下限，现场仍须按峰值写入速率、班次长度、清理时限和预留恢复空间冻结最终值，并用慢盘/接近满盘试验验证预警提前量。

#### 4.5.2 文件保留

采用“标记—清理—确认”三阶段：

1. 数据库生成待清理清单，记录 inspection、文件路径、大小和哈希。
2. 清理器仅删除受允许根目录约束、且不属于活动会话/未决标定回滚的文件。
3. 文件删除成功后再删除索引；失败进入可重试队列并告警。

当前实现将清理单持久化到 `record_cleanup`，清单 schema 为 `steel.record-artifact-cleanup.v1`。清单冻结每个文件的规范路径、大小和 SHA-256；执行前再次规范化并校验，拒绝 URI、相对路径、目录、符号链接/联接逃逸，以及包含 `maintenance/config/calibration/calibrations/profiles` 的路径。`STEEL_ARTIFACT_ALLOWED_ROOTS` 必须枚举狭窄的生产采集、summary 和 reconstruction 根目录。清理按文件更新进度；哈希变化或删除失败时保留 inspection/defect/capture 索引和 cleanup ID，显式重试续跑同一清单。全部文件成为 `deleted` 或可验证的 `missing` 后，才在一个数据库事务中删除 inspection 所属索引并把清理单标为 `completed`；`material_session`、触发和二级数据历史始终保留。

管理接口为：`GET /api/admin/records/cleanup?id=...` 查询证据，`POST /api/admin/records/cleanup/retry` 显式重试。单条删除和批量 retention 都复用同一生命周期；批量部分失败返回 HTTP 207，并逐条返回 `recordId/cleanupId/error`。前端展示计划、删除、缺失文件数和失败数，不再宣称生产会话被删除。

保留策略分别定义原始深度、强度图、元数据、重建网格、报告和审计日志，不能用一个天数覆盖所有数据类型。

#### 4.5.3 备份恢复

- 生产备份必须从已安装不可变版本运行，`active.json` 与包 manifest 的 release/commit/root/transaction 完全一致；默认拒绝 engineering/dirty 包，不再从工作区 Git 或 Cargo 版本猜身份。备份和恢复全程与安装、升级、卸载共用 `Global\SteelInspectionRuntime-Deployment`，拿不到锁时在读取/写入发布身份和数据库之前失败。
- SQLite 下载接口执行 `VACUUM INTO` 生成在线一致快照；落盘后通过系统 `winsqlite3.dll` 完整检查 integrity、外键、schema singleton、dirty/active/unresolved migration，完成目录只在 payload/manifest 全部持久化和复验后发布。
- MySQL 不通过 HTTP 下载数据库。脚本只在所有基表为 InnoDB 时使用 `mysqldump --single-transaction`，并强制恢复到明确授权重建的临时库，核对 clean schema ledger 和基表数；凭据只允许放在 ACL 受限的 `--defaults-extra-file`。
- `steel.database-backup.v2` 记录 backup UUID、活动部署/包 hash、版本/commit/transaction、schema contract/index hash、payload bytes/hash、一致性模型、工具 hash 与可恢复性证明；恢复时其 manifest hash 必须从另一信任通道输入。
- 上线前完成一次“新机恢复”演练，并验证记录、告警、任务、标定账本和文件引用一致。

标准命令：

```powershell
# 在线 SQLite 备份（管理员会话 token 从受保护终端注入）
& '<installed-release>\backup-database.ps1' -Engine sqlite -StateRoot 'C:\ProgramData\SteelInspectionRuntime' -AdminToken $env:STEEL_BACKUP_ADMIN_TOKEN -ArtifactRoots $env:STEEL_ARTIFACT_ALLOWED_ROOTS

# MySQL 单事务备份 + 临时库恢复证明；临时库名称必须与生产库不同
& '<installed-release>\backup-database.ps1' -Engine mysql -StateRoot 'C:\ProgramData\SteelInspectionRuntime' -AdminToken $env:STEEL_BACKUP_ADMIN_TOKEN -MySqlDefaultsFile 'C:\ProgramData\SteelInspection\secrets\mysql-client.cnf' -MySqlDatabase steel_inspection -MySqlVerificationDatabase steel_inspection_restore_verify_20260716 -AllowMySqlVerificationDatabaseReset

# 停服后恢复；manifest SHA-256 为包外输入，确认短语绑定 backup UUID 和目标版本
& '<target-installed-release>\restore-database.ps1' -BackupDir <backup-dir> -ExpectedBackupManifestSha256 <64-lowercase-hex> -Engine sqlite -TargetStateRoot 'C:\ProgramData\SteelInspectionRuntime' -Confirm 'RESTORE sqlite <backup-uuid> TO <semver-commit12>'
```

SQLite 恢复会 checkpoint WAL、生成持久 rollback copy、同卷 `File.Replace`/rename，并在切换后重复完整检查；失败时能证明旧库 hash 才自动回退，否则写 failed-safe 收据并保持停服。MySQL 导入明确不是原子操作，必须另提供一份不同 backup ID、包外 hash 固定的当前目标库 pre-restore backup，并显式批准 non-atomic 模式。恢复工具成功后服务仍保持停止；必须启动固定目标版本并检查数据库 readiness、未决生产任务、活动/历史告警、`calibration_operation`、`record_cleanup`、记录引用与允许根内文件后才能恢复接单。只有报告附带 v2 manifest/hash、restore receipt、恢复主机、操作者、开始/结束时间及上述检查结果，P0-07 才可关闭。

### 4.6 发布、安装与进程生命周期

#### 4.6.1 发布形态

推荐正式现场使用 Tauri 桌面端，并保留静态客户端仅用于受控诊断：

- 正式交付分为两个独立阶段：后台 runtime 包由管理员安装为 Windows 服务；Tauri MSI/NSIS 只安装操作员桌面端。两者都来自同一候选版本，但任一安装器都不会隐式替代另一阶段。
- Tauri bundle 已配置以 MSI/NSIS 为目标，并选择 WebView2 `offlineInstaller`、NSIS `perMachine`、禁止降级和正式 publisher；production 依赖不启用 devtools。锁定依赖的原始 Release EXE 已构建成功。两次 bundle 诊断均在安装资源下载停止进展后主动终止；第二次已得到 `target/cargo/.tauri/WixTools314`，但没有 bundle 目录或安装器。应修复/预置经审计的 WiX/NSIS/WebView2 构建资源链路后重跑，不能把它归类为源码编译失败或安装器成功。
- 正式打包会清理整个 `target/cargo`，因此历史 `.tauri/WixTools314` 不能视为发布输入。现已提供 `new-tauri-bundle-toolchain-manifest.ps1` 和 `provision-tauri-bundle-toolchain.ps1`：仓库外 payload 必须逐文件声明 component/size/SHA-256，以包外批准 hash 验证；构建在清理后精确播种并在结束后双向复验，错误 hash、篡改和增文件测试均已通过。仍须提供真实受审计 payload 并跑通签名 MSI+NSIS，证据关闭前保持 P0 No-Go。
- 正式 `build-client.ps1 -Tauri` 要求证书 SHA-1 指纹和 HTTPS 时间戳，缺少时 fail-closed；显式 unsigned 只允许开发。`package-runtime.ps1` 要求精确一个 MSI、一个 NSIS、桌面 EXE 三者 Authenticode 有效且带时间戳，并要求 Microsoft 签名的 `VC_redist.x64.exe`。当前裸 EXE 为 `NotSigned` 且依赖 `VCRUNTIME140.dll`。
- 当前自动签名门禁已覆盖 capture provider、Supervisor、Rust service、trigger gateway、algorithm core 和 `nvt_lvm_sdk.dll`：首方 EXE 必须匹配批准证书指纹且有可信时间戳，vendor DLL 必须有有效可信时间戳签名。门禁代码已实现，但当前本地产物仍为 `NotSigned`，真实发布证书、时间戳和 vendor 签名证据仍缺。
- 整包 SHA-256 Windows catalog 的生成、Authenticode+时间戳签名、package-only 完整复验、安装前验证和篡改拒绝已经接入。正式包的 `checksums.sha256` 双向覆盖除自身和 catalog 外的全部文件；catalog 覆盖 checksum 与全部 payload，catalog 自身单独签名。当前没有真实证书、签名 catalog 或正式包，证据仍未关闭。
- 隔离 OT 目标机必须验证 WebView2 离线安装器确实随 bundle 交付，并离线安装包内 VC++ Redistributable；必须在无开发工具、断网的干净机安装验证。
- 三个后台进程使用 Windows 服务或统一服务宿主，不依赖登录用户打开 PowerShell 窗口。
- `package-runtime.ps1` 明确输出 `formal-release` 或 `engineering`。正式包禁止 `-SkipBuild`、dirty、debug 和无 desktop bundle，并要求包外批准的 release-policy、bundle-toolchain manifest 与 external-components policy 三个 SHA-256；先验证仓库外 WiX/NSIS/WebView2 源和六类外部组件审批，清空五个已知 build roots，精确播种 `target/cargo/.tauri`，执行 `npm ci`，在本次调用中全量重建，构建后复验工具清单，并在构建后、写 manifest 前两次核对 HEAD/clean。Tauri 显式构建 `x86_64-pc-windows-msvc`，固定空 `build.features` 与 release `debug-assertions=false`，拒绝自动 merge 配置、未批准 TAURI/Rust/Cargo override 和 Cargo config，验包直接读取桌面/后台 PE Machine。包内 `build-evidence` 保存 npm package-lock、Tauri/service/trigger Cargo.lock、tauri.conf、Tauri Cargo.toml、policy 固定的 Cargo config、desktop release policy、Tauri feature resolution、离线工具链清单、external-components policy 和 CycloneDX SBOM 的 SHA-256；`database` 保存契约与 migration index。任何逃生参数都把产物降级为 engineering，只允许布局/开发验证。
- Tauri/npm/Tauri Cargo/service/trigger 版本必须同步；正式包用 `releaseVersion` 绑定精确 `v<version>` 或 `<version>` tag 和 source commit。`0.1.0` 占位版本明确被拒绝。
- 发布包包含版本清单、SHA-256、SDK/DLL 版本、配置 schema、数据库 migration 版本和回滚说明。

正式构建顺序：

```powershell
git status --short                         # 必须为空
scripts/verify-independent-architecture.ps1
$env:STEEL_RELEASE_POLICY_SHA256 = '<发布审批给出的 64-hex SHA-256>'
$env:TAURI_WINDOWS_CERTIFICATE_THUMBPRINT = '<发布证书 40-hex SHA-1 指纹>'
$env:TAURI_WINDOWS_TIMESTAMP_URL = 'https://<批准的 RFC3161 时间戳服务>'
$env:TAURI_WINDOWS_PUBLISHER = '<与 Tauri 配置/发布策略完全一致的 publisher>'
$env:VC_REDIST_X64_PATH = 'E:\approved-build-inputs\VC_redist.x64.exe'
$env:TAURI_BUNDLE_TOOLCHAIN_ROOT = 'E:\approved-build-inputs\tauri-bundle-toolchain-<version>'
$env:STEEL_BUNDLE_TOOLCHAIN_MANIFEST_SHA256 = '<发布审批给出的工具链清单 SHA-256>'
$env:STEEL_EXTERNAL_COMPONENTS_PATH = 'E:\approved-build-inputs\external-components.json'
$env:STEEL_EXTERNAL_COMPONENTS_SHA256 = '<发布审批给出的外部组件策略 SHA-256>'
scripts/package-runtime.ps1                # 默认 Release + MSI/NSIS
scripts/verify-runtime-package.ps1 `
  -PackageDir target/packages/steel-inspection-runtime `
  -ExpectedFirstPartyThumbprint $env:STEEL_RELEASE_SIGNER_THUMBPRINT `
  -AllowedVendorSdkSignerThumbprints @($env:STEEL_VENDOR_SDK_SIGNER_THUMBPRINTS -split ',') `
  -ExpectedPublisher $env:STEEL_DESKTOP_PUBLISHER `
  -ExpectedReleasePolicySha256 $env:STEEL_RELEASE_POLICY_SHA256 `
  -ExpectedBundleToolchainManifestSha256 $env:STEEL_BUNDLE_TOOLCHAIN_MANIFEST_SHA256 `
  -ExpectedExternalComponentsSha256 $env:STEEL_EXTERNAL_COMPONENTS_SHA256
```

发布机构建证书必须未过期、具有代码签名用途且私钥可用；时间戳必须是 HTTPS；VC++ 前置包必须有 Microsoft 有效签名和可信时间戳。部署侧的 `STEEL_RELEASE_SIGNER_THUMBPRINT`、vendor allowlist、`STEEL_DESKTOP_PUBLISHER` 与三个批准 hash 仍由独立审批通道提供，不能从刚生成的 manifest 反向抄取。

`manifest.json` 使用 `steel.runtime-package.v1`，记录 packageClass、releaseVersion、Git commit/tag/dirty、同次构建与依赖来源、C++ configuration、Rust profile、桌面安装器数量、checksum/catalog、SBOM/external policy、database contract/index 契约及 `steel.architecture-migration.contract.v1`。wrapper 默认正式验包，必须使用部署侧包外的首方指纹、vendor SDK signer allowlist、publisher，以及 64-hex `ExpectedReleasePolicySha256`、`ExpectedBundleToolchainManifestSha256` 和 `ExpectedExternalComponentsSha256`；它先完成 trust/checksum/catalog 验真，再执行包内检查，并核对 npm ci、四个 lock、tauri.conf/Tauri Cargo manifest、CycloneDX SBOM/external policy、数据库 contract/index、`build-evidence/desktop-release-policy.json`、`tauri-feature-resolution.json`、`bundle-toolchain-manifest.json` 的结构/组件/文件计数、精确 MSI/NSIS/桌面版本与签名、Microsoft VC++ 签名和 WebView2 offlineInstaller 声明。工程包必须显式 `-Engineering`，默认不执行包内脚本；仅本机可信工程包可再显式 `-AllowPackageCodeExecution`。最终构建报告还必须附签名证书主体/指纹、时间戳、构建机、编译器/SDK 版本和外部依赖 SBOM。

当前 SBOM 静态验证会绑定 policy/SBOM hash、serial、component count、四个 lock 和三份工具证据，但尚未从 lock 独立重建完整 npm/Cargo inventory；PowerShell JSON 解析也不能可靠拒绝重复 member。六个外部类别要求各至少一项，类别可有多组件，不能把 external 总数固定为 6。正式构建和语义验证固定使用 Windows PowerShell 5.1 或 PowerShell 6.2+，禁止 6.0/6.1；批准版 `external-components.json` 与带外 hash 未到位前仍为 No-Go。

当前桌面构建机已通过仅作用于构建进程的可用代理成功执行 `cargo fetch --locked` 和 `cargo build --locked --release`，补齐了原先缺失的依赖。该结果证明锁定依赖可构建，不等于供应链已产品化。发布构建机仍应使用经批准的内部镜像或受审计缓存，归档来源、锁文件、许可证和 SBOM；不得把个人代理写入仓库，也不得删除锁文件、临时换未审计版本或忽略 `--locked`。

#### 4.6.2 启停顺序

```text
统一服务启动：capture(4317 app-ready) -> trigger(4881 app-ready 且 4882/TCP、4883/UDP 已绑定) -> service(4873 app-ready)
统一服务停止：先 Trigger drain，再 Service drain；连续 4 次满足零状态或 60 秒到期后，向全部子进程同时发 CTRL_BREAK，共享 15 秒优雅窗口，随后有界强停与日志泵收敛
桌面客户端：独立于后台服务安装和退出，不承担后台进程守护
```

服务守护策略：

- 正式服务名固定为 `SteelInspectionRuntime`，运行身份为 `LocalSystem`；统一宿主不直接处理业务，只负责配置注入、顺序、readiness、停止和恢复。安装 CLI 的 `RuntimeRoot` 仅表示只读源包；实际签名 payload 位于不可变 `InstallRoot\releases\<semver>-<commit12>`，SYSTEM/Administrators 仅有读/执行，SCM 直接指向该目录。SourcePackageRoot、InstallRoot、StateRoot、secret/report policy 路径和生产数据写域必须双向互不重叠；Storage/CameraStorage/Artifact roots 属于同一生产数据域，允许组内设计性重叠。公共 env、日志、SQLite/服务状态、采集配置、temp/work 与 deployment journal 位于独立可变 `StateRoot`，默认 `%ProgramData%\SteelInspectionRuntime`。目标机必须证明普通用户不能修改二进制、可变状态、算法配置/报告或 DLL。
- 目标行为是任一子进程意外退出时，先反序停止整组，再整体重启；每个子进程树由 Job Object 等价机制完整回收。进程内重启预算和 SCM failure actions 必须一起演练，证明预算耗尽后不会形成外层无限重启。
- trigger 的 HTTP 4881、TCP 4882、UDP 4883 必须在主启动路径同步绑定；任一失败都应使启动失败。readiness 必须校验应用身份/健康内容，不能只证明端口可连接。
- capture、trigger、service 分别写入 `StateRoot\logs\*.log`，单文件达到 `50 × 1024 × 1024` bytes 时在线轮转并保留 `.1`–`.5`；本地综合测试已证明子进程持续写期间跨阈值切换，不再只是启动时整理，现场仍需归档同一证据。
- 公共 `StateRoot\config\runtime-service.env` 与秘密文件分离。安装器要求管理员权限并拒绝 reparse point；源包、`.incoming-*` 暂存和最终版本目录均执行完整 catalog/签名验证，暂存树锁定后同卷 rename，最终树不允许覆盖。既有 StateRoot 在写入前检查 owner/DACL/reparse；外部 secret/报告不得落入任一 root，并审计祖先目录删除/替换权限。旧的树内可变部署必须迁移到版本目录 + 受保护 StateRoot，不能靠 catalog skip 原地兼容。
- `49007/restartRequired`、标定 `needs-reconciliation` 和损坏 manifest 不允许盲目自动清除。
- 升级前停止接单、确认无活动钢材会话、备份数据库和配置，然后原子切换版本。
- 保留上一版本二进制和 migration 回滚说明；数据库不可逆变更必须单独审批。

管理员安装示例：

```powershell
$package = 'D:\ReleaseDrop\steel-inspection-runtime'
.\install-runtime-service.ps1 `
  -RuntimeRoot $package `
  -InstallRoot 'C:\Program Files\SteelInspectionRuntime' `
  -StateRoot 'C:\ProgramData\SteelInspectionRuntime' `
  -SecretEnvFile 'C:\ProgramData\SteelInspection\runtime-secrets.env' `
  -AlgorithmAcceptanceReport 'C:\ProgramData\SteelInspection\release\algorithm-acceptance.json' `
  -ExpectedFirstPartyThumbprint $env:STEEL_RELEASE_SIGNER_THUMBPRINT `
  -AllowedVendorSdkSignerThumbprints @($env:STEEL_VENDOR_SDK_SIGNER_THUMBPRINTS -split ',') `
  -StorageRoot 'H:\' `
  -CameraStorageRoot 'H:\' `
  -ArtifactAllowedRoots 'H:\production;H:\camera1;H:\camera2;H:\camera3;H:\camera4;H:\camera5;H:\camera6;H:\camera7;H:\camera8;G:\bar-surface-algorithm' `
  -Start
Get-Service SteelInspectionRuntime
```

其中两个证书参数必须是部署侧包外信任锚；首方指纹和 vendor allowlist 都不能从包内 manifest 自动接受。算法报告必须是已批准且校验通过的 `status=pass` 报告，pending 示例不能安装。升级使用同一命令并增加 `-Upgrade`；脚本已实现不可变版本目录、三段完整验证、全局部署 mutex、持久 `upgrade.json`/active/history/backups、pre-DB 崩溃恢复、SCM 直指和进程内回滚。安装器在 catalog 验真后执行数据库契约验证，并在状态变化前拒绝非空 migration index；升级或复用保留 StateRoot 的重装必须由旧 active receipt 证明 schema 与目标一致。当前数据库 phase 仍固定为 `not-started`，未接签名迁移器或开机 recover-only，因此只能同 schema 升级，数据库迁移和断电安全仍是 No-Go。SCM failure actions 已限制为 5 秒重启、30 秒重启、第三次 none。上述行为仍必须在管理员维护窗口归档真实 SCM、effective ACL、迁移、约 90 秒最坏停止预算、进程树、实时轮转、崩溃恢复和升级故障回滚证据。

### 4.7 发布门禁修复

- 将 `test-architecture-migration-contract.ps1` 中对 Rust 固定单行字符串的匹配改为 AST、正则空白归一化或行为测试，避免 `rustfmt` 触发误报。
- 清理 `test-integrated-acceptance-audit.ps1`、`test-integrated-management-smoke.ps1` 和真实标定脚本中的六相机历史口径；当前 Profile 下必须检查精确 8 个唯一 IP/SN、8 个成功结果、8 个完整帧和 8 个 metadata commit，不能使用 `>=6` 作为通过条件。
- CI 至少执行前端测试/构建、两个 Rust crate 测试、C++ build/CTest、模拟运行时验收、架构门禁和打包布局检查。
- C++ 模拟帧事务测试应在无采集进程的隔离 agent 执行；如果检测到全局 SDK 锁占用，报告 `environment-blocked`，不要伪装成算法/帧事务断言失败。
- 只有 clean worktree 对应的提交可以生成候选包；报告中记录 commit SHA 和所有产物哈希。

### 4.8 正式检测报告签发与归档

正式报告使用两层 JSON 合同：业务文档为 `steel.inspection.report.v1`，归档信封为 `steel.inspection.report-archive.v1`。签发端从数据库重新读取指定 `inspectionId` 的完整生产记录，而不是信任前端传入的缺陷列表。文档包含材料、检测记录、缺陷、采集文件、算法资格与标定追溯信息；对规范化文档计算 SHA-256 后生成 `RPT-<inspection>-<hash12>`。

归档根由 `STEEL_REPORT_ARCHIVE_ROOT` 指定；统一服务安装器固定派生为 `StateRoot\reports\inspection`。每个检测记录单独建目录，文件以 `create_new` 语义写入并 `sync_all`。相同业务快照重复签发返回已有报告且 `created=false`；记录内容变化会产生新 ID 和新文件，旧报告字节保持不变。重复签发已有文件前也会重新执行完整性校验，损坏文件不能被当作幂等成功。`POST /api/admin/records/reports` 用于签发；`GET /api/admin/records/reports?inspectionId=...` 返回历史摘要，但会逐份执行与正文相同的 schema、身份、内容寻址 ID 和 SHA-256 校验，任何损坏或目录内异常文件都会让整个列表返回 409 和损坏清单，不再静默漏掉；`GET /api/admin/records/reports/detail?inspectionId=...&reportId=...` 只在同一校验全部一致时返回正文。报表页只允许单个生产检测记录签发，并显示归档数量和最近签发时间；“打印版”必须重新读取该接口，不能拿当前筛选表格冒充历史归档。

报告归档已补独立灾备工具 `manage-report-archives.ps1`，随 runtime 包发布。它支持全树校验、Rust 权威复验、稳定清单备份和离线目录恢复；空归档、路径重叠、未权威校验备份误恢复、payload 篡改和旧树保留均有回归。备份期间源清单发生变化会失败，恢复只允许 StateRoot 内同卷 staging/rollback，收据写入失败也会回退旧树。数据库 v2 备份与报告归档备份保持独立，避免把两类资源伪装成单一原子事务；现场恢复必须在停服窗口按“数据库 → 报告归档 → 启动固定版本 → 带 token 的权威校验 → 历史/正文/打印与 readiness 复核”执行，并共同归档两份 manifest hash 和恢复收据。

前端打印导出为自包含 UTF-8 HTML，按 A4 横向定义分页样式，正文展示材料/结果摘要、算法/配置/标定/数据集/评测器追溯、全部缺陷和源帧/ROI/局部点云/双剖面索引，并预留检测、质量复核和批准签字栏。HTML 内所有归档数据都经过转义，顶部固定显示 reportId、签发人、签发时间和 documentSha256；用户可用系统打印对话框直接打印或保存 PDF。

功能验收至少覆盖：同内容重复签发幂等、缺陷追加后产生新版本、旧归档 hash 不变、篡改正文读取失败、服务重启后历史仍可查询、数据库记录清理不误删法定保留期内报告、备份恢复后报告与数据库引用可核对，以及目标机浏览器/WebView 的 A4 分页与中文字体。当前不可变 JSON 和绑定哈希的打印 HTML 已作为机器/人工复核底稿；现场抬头、最终质量结论文案和证据缩略图仍属于模板冻结项。

## 5. 八相机现场验收设计

### 5.1 进入条件

- F0-1 缺陷类别与质量指标已冻结，生产算法已通过冻结样本集验收；发布、安全类 P0 不作为进入本轮硬件功能验收的前置条件。
- 当前 `current-8-time-trigger` Profile 的 8 个 IP、SN、型号、存储目录和参数文件由现场双人复核。
- `H:/camera1..camera8` 均存在、可写、容量充足，且没有映射到系统盘或临时盘。
- 真实标定计划包含每台相机的 expected SN、目标文件和已验证 rollback 文件。
- 数据库、配置和设备参数已备份；维护窗口和紧急停止方案已确认。

### 5.2 必跑报告

按当前仓库脚本执行并归档：

1. `test-real-hardware-acceptance.ps1 -RunCapture`
2. `test-real-calibration-acceptance.ps1` 的 dry-run、apply、rollback 和验证帧
3. `test-real-calibration-crash-recovery.ps1` 的 ApplyCrash 与 RollbackCrash 两个场景
4. `test-real-calibration-integrity-generation.ps1` 的 stale generation、staged tamper、zero-write 和恢复验证
5. `test-integrated-capture-management-full.ps1` 的 `-RequireFullCoverage`，最终必须达到当前定义的 24/24
6. `test-production-stability.ps1` 的短稳定性、长时间 soak、异常注入和恢复；包内执行必须使用包外 `WorkRoot`，逐轮和最终状态必须满足队列、worker、active task、in-flight、active session 全部收敛，且所有 material/session/inspection ID 跨轮唯一

### 5.3 必验行为

- 八台相机发现、SN 绑定、参数 readback、同步触发和每轮完整帧数。
- `owned-offline-format0`、同帧 online/offline 深度一致性、format-2 fallback（如设备存在）。
- pending-byte backpressure、写队列满、慢盘、黑帧、缺帧和元数据最后提交。
- CTRL_BREAK 时已接收帧安全 drain；硬超时后返回 `49007/restartRequired` 并阻止不安全写入。
- 标定 apply/rollback、设备持久化、进程中断、重启 fence、SN/generation/hash 拒绝和零写证据。
- PLC/L2 重复、乱序、断网重连、服务重启和稳定 `requestId` 幂等。
- 算法输出 `syntheticDefectCount=0`，结果、告警、报告和选中记录的 3D 产物一致。

### 5.4 稳定性建议

最终阈值应由现场节拍和合同指标确认。建议至少分三层：

- 工程冒烟：覆盖一个完整钢材周期和所有异常分支。
- 交付试运行：覆盖连续班次、相机重连、服务重启和磁盘压力。
- 上线观察：覆盖完整生产周期，统计丢帧、失败任务、误报/漏报、写入延迟、磁盘增长和人工干预次数。

任何一次测试都必须记录软件版本、Profile、相机 SN、SDK 版本、数据库版本、开始/结束时间和失败证据，不能只保留“通过”截图。

## 6. Go/No-Go 清单

只有以下项目全部为“是”才允许正式上线：

| 门禁 | Go 条件 |
| --- | --- |
| 代码基线 | clean worktree、发布提交和标签已冻结，CI 全绿 |
| 构建产物 | Release 包、签名、哈希、依赖和版本清单齐全 |
| 离线安装 | 后台 runtime 服务和桌面 MSI/NSIS 两阶段安装完成；WebView2、VC++、SDK/驱动及数据库前置条件在断网干净机验证 |
| 算法 | 生产模式无 synthetic/mock；精度报告通过并绑定版本 |
| 真实硬件 | 当前八相机完整 24/24 报告通过，无跳过项 |
| 标定安全 | apply/rollback、崩溃恢复、tamper/generation 和验证帧全部通过 |
| 生产链 | 前置失败能阻断下游；重复/乱序触发不会产生重复副作用 |
| 安全 | 无默认密码；数据库和网关凭据已配置；网络边界已验收 |
| 数据 | 容量水位、文件保留、备份和新机恢复演练通过 |
| 运维 | Supervisor 进程树、三种 trigger listener、应用 readiness、SCM、业务 drain、运行中日志轮转、ACL、重启预算、开停机和升级回滚 SOP 已演练 |
| 升级一致性 | 版本目录、数据库账本/迁移、持久 journal、SCM 激活和逐 phase 故障注入均收敛到 committed、rolled-back 或 failed-safe |
| 现场签字 | 算法、设备、OT、质量、生产和运维负责人共同签字 |

任一 P0 未完成、任一真实硬件必选项被 skipped、算法仍产生 synthetic 缺陷、readiness 非 200，均为 **No-Go**。

## 7. 建议实施顺序与责任边界

| 批次 | 工作 | 主责角色 | 完成标志 |
| --- | --- | --- | --- |
| A | 禁止生产 mock、修复发布门禁、固定 Release 构建 | 算法/后端/构建 | 软件 CI 与模拟验收全绿 |
| B | 默认凭据、数据库 TLS、网关安全、配置路径收口 | 后端/安全/OT | production profile fail-closed |
| C | 任务依赖、文件生命周期、备份恢复、服务守护 | 后端/运维 | 异常与恢复演练通过 |
| D | 算法标注集、精度和节拍验收 | 算法/质量 | 版本化算法验收报告 |
| E | 八相机采集、标定、崩溃恢复和稳定性 | 采集/设备/QA | 无 skip 的 24/24 现场报告 |
| F | 候选包、试运行、现场签字和正式发布 | 项目/生产/运维 | Go/No-Go 清单全部通过 |

## 8. 与现有文档的关系

- API 和状态语义继续以 [`capture-api-contract.md`](capture-api-contract.md) 为准。
- 当前能力迁移和已知 backlog 以 [`qt-to-tauri-migration.md`](qt-to-tauri-migration.md) 为准。
- 集成验收项以 [`integrated-capture-management-acceptance.md`](integrated-capture-management-acceptance.md) 为准。
- 发布包、两阶段安装、离线前置条件、算法准入、Supervisor 现场验收、日常运维和证据目录以 [`release-deployment-and-operations.md`](release-deployment-and-operations.md) 为准。
- 版本目录、严格业务排空、数据库 schema 账本、升级 journal、SCM 切换、崩溃恢复与故障注入基线以 [`atomic-upgrade-and-database-migration-design.md`](atomic-upgrade-and-database-migration-design.md) 为准；该设计在目标机证据归档前仍是 P0 No-Go。
- 本文负责定义“从当前状态到正式上线”的差距、优先级、设计和 Go/No-Go 口径；实现后应同步更新上述关联文档，避免状态互相矛盾。
