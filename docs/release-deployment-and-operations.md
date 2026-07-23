# 上线发布、安装与运维手册

> 文档基线：2026-07-16 当前工作区  
> 适用范围：棒材表面 3D 检测系统的发布候选包、Windows 现场部署、运维交接和生产放行  
> 当前结论：**No-Go。当前产物只能作为工程验证证据，不能作为正式生产发布包。**

## 1. 文档目的与状态口径

本文是发布经理、现场实施、设备、OT、质量和运维共同使用的上线主文档。接口细节、相机验收项和差距分析仍由对应专题文档维护，但正式上线判定以本文的交付形态、证据要求和 Go/No-Go 表为准。

所有状态只使用以下四种口径：

| 状态 | 含义 | 能否作为正式上线证据 |
| --- | --- | --- |
| 已验证 | 已在明确提交、环境和命令下执行，并保留可复核报告 | 可以，但环境或版本变化后必须重跑 |
| 工程包 | 用于布局、联调、模拟运行或问题定位的产物 | 不可以 |
| 发布阻断 | 正式上线前必须关闭的构建、签名、安全或运行风险 | 不可以，任一项存在即 No-Go |
| 现场验收 | 只能在目标机、真实八相机、真实 OT 网络或生产节拍下取得的证据 | 完成并签字后可以 |

“源码中存在检查”“静态契约通过”“服务显示 Running”均不等于生产链路已验收。证据必须同时绑定 Git commit、构建配置、产物哈希、目标机和执行时间。

## 2. 当前真实状态

| 范围 | 当前状态 | 已有证据 | 仍需完成 |
| --- | --- | --- | --- |
| 软件边界与模拟链路 | 已验证的工程基线 | Tauri/React → Rust → headless C++，独立触发网关；已有单元、静态架构和模拟运行证据 | 在最终 clean commit 上完整重跑并归档 |
| 当前运行包 | `engineering`，服务安装器会拒绝 | 最新工程包使用现有 Release 后台产物重新生成；48 项必需布局检查、41 个 PowerShell 脚本、122 个包内文件、报告归档灾备包内回归和 manifest 架构合同通过。manifest 明确标记 `prebuilt-engineering-only` | 必须从冻结的非占位版本/精确 tag 提交重新生成 `formal-release`，纳入同次全量构建、lock/config、SBOM/外部组件、数据库契约、桌面安装器、签名 catalog、供应链和完整回归证据 |
| Tauri 桌面端 | no-bundle Release 已构建，安装器仍阻断 | 完整构建 56.64 秒，产物 `target/cargo/release/steel-plate-3d-inspection-tauri.exe` 为 23,113,728 bytes，production devtools=0；已配置 WebView2 offlineInstaller、NSIS perMachine、禁止降级和 publisher；离线 WiX/NSIS/WebView2 清单生成、包外 hash、精确播种和构建后复验已实现并通过篡改测试 | 仍须由发布负责人提供受审计的真实离线工具 payload 并批准其 manifest hash；历史在线 bundle 未生成 MSI/NSIS。这不是源码编译失败；当前 EXE 为 NotSigned 且依赖 VCRUNTIME140.dll |
| 代码签名 | 门禁已实现，证据仍为发布阻断 | 正式包已要求桌面 EXE/MSI/NSIS、全部首方后台 EXE 和 vendor SDK DLL 均为 Authenticode Valid 且有可信时间戳；首方文件还绑定批准证书指纹 | 当前本地产物仍为 NotSigned，尚无真实发布证书/时间戳，也没有可归档的 vendor DLL 有效签名证据 |
| 包完整性 | 生成、独立复验和安装前拒绝代码已实现，正式证据仍阻断 | `checksums.sha256` 双向闭包、SHA-256 Windows catalog、catalog Authenticode/时间戳、部署侧证书指纹和完整 `Test-FileCatalog` 均已接入；安装器在写可变状态前验证 | 当前没有真实证书、签名 `release-integrity.cat` 或可独立复验的 `formal-release` 包，不能把工程包哈希清单当作正式防篡改证据 |
| SBOM 与外部组件 | 离线生成/语义复验代码已完成，正式审批证据未生成 | CycloneDX 1.5 绑定 commit、四个 lock、脚本 hash、Git/PowerShell 版本和六类外部组件；离线负向测试 11/11；当前工作区可枚举 npm 315、Cargo 627、external 6，共 948 个组件 | 用真实版本、来源、许可证和 artifact SHA-256 把 external policy 从 example/pending 变为批准输入；在最终 clean commit 生成、验真并纳入 formal-release/catalog |
| 算法生产策略 | 生产防护、候选降级语义与完整绑定代码已落地，真实准入仍阻断 | 生产档拒绝 mock/synthetic；径向异常保留兼容 ID 但显式标记 `candidate-only`，界面/报告不再冒充已完成材料缺陷分类；版本化配置、校验器、安装器、Python 运行和 Rust readiness/运行门禁逐项绑定 config、calibration、script、core、release commit、dataset/evaluator、报告和输入产物 | 用冻结数据集完成类别、精度和误报/漏报验收，生成有真实指标与两方签字的 status=pass 报告；在最终包与一次真实运行上归档绑定证据 |
| Windows 统一宿主 | 版本化部署、严格排空和在线轮转本机回归通过，管理员现场仍阻断 | Job Object、句柄白名单、三 listener 和应用 readiness 已落地；Service 134/134、Trigger 17/17、C++ 9/9、Supervisor 综合脚本通过。Trigger→Service drain、连续 4 次零状态、受管 49007 两次确认、标定绕过拒绝、算法计算取消/超时/直接完成后的派生进程整树回收/有界输出、50 MiB 在线轮转/5 代保留已测；Supervisor 环境白名单现与安装器实际生成的采集根、算法根、报告根和超时字段一致；安装器已实现三段完整验证、不可变版本目录、mutex、持久 journal、pre-DB 恢复和 SCM 直指 | 用真实签名 formal-release 在管理员目标机验证 install/upgrade/rollback/uninstall、SCM 状态与约 90 秒最坏 stop 预算、effective ACL、开机自启、逐 phase 恢复、整树回收和五端口释放 |
| 八相机与标定 | 完整采集功能通过，异常矩阵未全部关闭 | 当前真实材料完成 184/184 完整帧，八台各 23 组 depth/intensity/metadata、零失败；同批重建 20/20，启动自动连接和精确 8/8 readiness 已实测 | 归档无 skip 的正式 24/24 管理报告、标定崩溃恢复、受管 49007 恢复与连续班次报告 |
| OT、账号、数据库和灾备 | 代码防护、数据库 v2 与报告归档 v1 灾备工具已存在 | 触发 HMAC/重放/来源策略、生产凭据 fail-closed；数据库备份绑定 active release/schema/hash，SQLite 原子恢复契约 10 项通过；报告归档支持 Rust 权威复验、稳定清单、文件哈希、离线恢复和旧树保留；MySQL 强制 InnoDB/临时库证明/非原子回退前置备份 | 冻结真实点表和时序；执行秘密轮换、目标机 SQLite+报告归档新机联合恢复、MySQL DBA 回退、账号交接和网络验收 |

以上状态是 2026-07-16 的工作区快照。任何后续代码修改都会使旧的构建和测试证据失效，必须按最终提交重新生成。

## 3. 正式交付形态：两个独立安装阶段

正式交付不是一个安装器完成全部部署，而是两个相互独立的阶段：

    已签名发布候选包
      ├─ 阶段 A：后台 runtime 包
      │    └─ SteelInspectionRuntime Windows 服务
      │         └─ capture → trigger → Rust service
      └─ 阶段 B：Tauri 桌面安装器
           └─ 操作员桌面客户端
                └─ 仅访问 Rust 127.0.0.1:4873

### 3.1 阶段 A：后台 runtime 与 Windows 服务

后台 runtime 包至少包含：

- service/steel-runtime-supervisor.exe、Rust service、trigger gateway、headless capture provider；
- 相机 SDK 运行库和经批准的配置；
- config/algorithm/bar-surface-production.json；
- 算法准入报告校验脚本、安装/卸载脚本和现场验收脚本；
- manifest.json、checksums.sha256、正式包的 release-integrity.cat、架构契约、第三方依赖/SBOM 和回滚说明。

后台由提升权限的管理员安装为 SteelInspectionRuntime，运行身份当前设计为 LocalSystem。它不由桌面端安装器创建，也不能依赖登录用户打开 PowerShell 窗口。安装命令中的 `RuntimeRoot` 仅是只读源包；签名 payload 被发布到 `%ProgramFiles%\SteelInspectionRuntime\releases\<semver>-<commit12>`，只读执行且由 SCM 直接引用。公共配置、日志、SQLite/服务状态、采集配置、临时文件、部署 journal 和恢复收据位于独立可变 `StateRoot`，默认 `%ProgramData%\SteelInspectionRuntime`。SourcePackageRoot、InstallRoot、StateRoot、secret 和算法准入报告互不重叠。
服务安装器要求 `packageClass=formal-release`，并拒绝 dirty、占位版本、非 Release、非同次构建或缺少精确 tag/commit 的包。它在源包、`.incoming-*` 暂存、锁定后的暂存以及最终版本目录执行完整 catalog/PE 验证；同卷 rename 发布且拒绝覆盖同名版本。全局 mutex 与持久 journal 在任何可恢复状态变化前建立。因此当前工程包不能通过正式服务安装路径。

### 3.2 阶段 B：Tauri 桌面客户端

桌面端通过 MSI 或 NSIS 安装器单独安装。它只负责操作界面，不启动、不停止、不守护后台进程，也不直接加载相机 SDK。

正式候选包当前明确要求同时交付一个 MSI 和一个 NSIS 安装器。打包门禁还要求桌面主 EXE 与两种安装器均为有效 Authenticode 签名且带可信时间戳。“配置中声明目标”不等于安装器已经成功生成或验收；截至本文基线，两种安装器仍未生成。

### 3.3 推荐安装顺序

1. 在部署侧以独立信任锚校验 manifest、双向 checksum 清单、catalog、签名和时间戳。
2. 安装目标机离线前置依赖。
3. 把后台源包放入受保护的 release drop；由安装器验证后同卷发布到最终 `InstallRoot\releases\<version>-<commit12>`，保护并复验 ACL/catalog；创建或审计独立 `StateRoot`。
4. 校验算法配置与已批准的算法准入报告。
5. 安装并验收 SteelInspectionRuntime，确认后台 readiness。
6. 安装 Tauri 桌面端，确认只能通过 Rust API 访问后台。
7. 执行真实八相机、OT、数据恢复和试运行验收。

卸载顺序相反。卸载桌面端不得停止生产服务；后台默认卸载只删除 SCM/注册表和与 active/SCM 精确绑定的当前 release，保留其它 releases 与整个 StateRoot，因此不得删除数据库、相机配置、秘密、日志或生产产物。只有 `committed`/`rolled-back` journal 才允许卸载；`failed-safe` 或非终态必须先人工恢复。Purge 另需显式双 root、可信部署证据和路径绑定确认短语。

## 4. 离线前置条件与发布依赖

以下内容必须在目标机断网条件下可安装、可校验、可回滚：

| 前置条件 | 当前状态 | 正式门禁 |
| --- | --- | --- |
| Windows 与补丁基线 | 尚未冻结 | 记录系统版本、补丁、区域/时区、文件系统和重启策略 |
| WebView2 Runtime | Tauri 已配置 offlineInstaller 和静默安装，避免目标机在线 bootstrapper | 实际生成 MSI/NSIS，确认离线安装器被嵌入/随包交付；在无 WebView2、断网的干净机安装并记录版本 |
| Microsoft VC++ Runtime | dumpbin 已确认原始 Tauri EXE 依赖 VCRUNTIME140.dll；正式打包门禁要求 VC_redist.x64.exe | 提供 Microsoft 有效签名且带时间戳的 x64 Redistributable，纳入 prerequisites 和校验清单；断网冷机验证 |
| 相机 SDK/DLL | 后台包包含运行文件的路径已有设计 | 锁定供应商版本、许可证、哈希和驱动依赖；在无开发环境目标机验证加载 |
| 数据库 | SQLite 可本机运行；MySQL 需现场服务 | 冻结引擎、版本、最小权限账号、TLS 证书链、备份客户端和恢复工具 |
| Python/算法运行时 | 由后台算法链使用 | 冻结解释器和依赖，禁止依赖构建机全局 Python；生成依赖清单和离线安装验证 |
| Cargo/NPM 供应链 | locked Rust 依赖已成功构建；离线 CycloneDX 1.5 生成/验证器可从 npm 与三份 Cargo lock 枚举当前 942 个锁定组件，并另要求六类外部组件 | 用包外批准的真实 external-components policy 生成最终 SBOM，纳入 build-evidence、manifest、checksum/catalog 和 package-only 复验；在受审计缓存/镜像复现，禁止删除锁文件绕过 |
| WiX/NSIS bundle 工具链 | 包外清单生成、逐文件 component/size/SHA-256、外部批准 manifest hash、构建前源验证、清理后播种和构建后双向复验代码已完成；测试已拒绝错误 hash、篡改和增文件 | 发布负责人在仓库外提供真实只读 payload，复核版本/许可证/来源并批准 `STEEL_BUNDLE_TOOLCHAIN_MANIFEST_SHA256`；使用该输入完成签名 MSI+NSIS 构建前保持 No-Go |

发布机可使用经批准的进程级网络配置拉取锁定依赖，但不得把本机代理地址写入仓库或正式包。最终构建必须能说明每个依赖来自哪里、版本为何、哈希是什么。

## 5. 签名、版本和候选包门禁

### 5.1 包类别与同次构建来源

`manifest.json` 的 `packageClass` 只有两个合法值：

| 类别 | 用途 | 强制约束 |
| --- | --- | --- |
| `formal-release` | 可进入独立验包和生产安装流程的候选包 | clean HEAD、稳定非占位版本、精确 tag、Release/locked、本次全量重建、桌面 bundle、签名和 catalog 全部满足 |
| `engineering` | 布局、联调、模拟或问题定位 | 可显式使用 dirty/debug/跳过构建或桌面 bundle 等逃生参数，但永远不是正式候选包，生产安装器拒绝 |

正式打包明确禁止 `-SkipBuild`、`-AllowDirtyWorktree`、`-AllowDebugPackage` 和 `-SkipDesktopBundle`，并要求包外审批的 `STEEL_RELEASE_POLICY_SHA256` 精确匹配源控策略。它还要求仓库外 `TAURI_BUNDLE_TOOLCHAIN_ROOT`、批准的 `STEEL_BUNDLE_TOOLCHAIN_MANIFEST_SHA256`、批准的 `STEEL_EXTERNAL_COMPONENTS_PATH` 及其包外 `STEEL_EXTERNAL_COMPONENTS_SHA256`：先验证 WiX/NSIS/WebView2 源清单、全部 payload 和六类外部组件审批，再清空 `target/capture`、`target/cargo`、`target/trigger`、`target/algorithm-core`、`target/client/frontend-dist`，把精确 payload 播种到 `target/cargo/.tauri`，执行干净的 `npm ci`，然后在同一次 `package-runtime.ps1` 调用中重建全部交付物；构建后再次复验工具目录无缺失、增项或篡改。构建完成后和写 manifest 前各再次核对精确 Git HEAD 与空 worktree，任何源文件或提交变化均中止。正式桌面构建显式指定 `x86_64-pc-windows-msvc`，要求 `build.features=[]`、release `debug-assertions=false`，拒绝自动合并的 Tauri 平台配置、未批准 `TAURI_*`/Rust 编译器/Cargo profile 覆盖及包外 Cargo config，并直接核验桌面和后台 PE 的 x86-64 Machine 字段。

Tauri 配置、npm、Tauri Cargo、Rust service 和 trigger 的版本必须同步；`releaseVersion` 绑定该版本，并绑定同一提交上的精确 `v<version>` 或 `<version>` tag。正式安装只接受无数字前导零的规范稳定 `x.y.z`，占位 `0.1.0` 明确阻断。manifest 同时记录 `build.performed=true`、`provenance=built-in-this-invocation`、与 source commit 相同的 build source commit 和 `dependencyInstall=npm-ci`；包内 `build-evidence` 保存 npm `package-lock.json`、Tauri/service/trigger 三个 Cargo.lock、精确 `tauri.conf.json`、Tauri `Cargo.toml`、`desktop-release-policy.json`、`tauri-feature-resolution.json`、`bundle-toolchain-manifest.json`、`external-components.json` 和 CycloneDX 1.5 SBOM，包内 `database` 保存契约与 migration index；manifest 逐项绑定 SHA-256、schema、target、组件数与文件数。

正式构建机还必须显式提供 `TAURI_WINDOWS_CERTIFICATE_THUMBPRINT`、HTTPS `TAURI_WINDOWS_TIMESTAMP_URL`、与 Tauri config/release policy 完全一致的 `TAURI_WINDOWS_PUBLISHER`，以及指向 Microsoft 有效签名且带可信时间戳文件的 `VC_REDIST_X64_PATH`。证书须未过期、具代码签名用途且私钥可用。构建侧输入不替代部署侧独立的 signer/vendor/publisher/policy hash 信任锚。

### 5.2 双向 checksum 与签名 catalog

`checksums.sha256` 不是只做“清单中每项能算对”的单向检查。验包会同时枚举实际文件集合，拒绝缺项、多项、重复、非规范路径、越界路径、被排除项和哈希不一致：

- `engineering` 精确排除 `checksums.sha256` 自身；
- `formal-release` 精确排除 `checksums.sha256` 和 `release-integrity.cat`；
- 正式 checksum 因此覆盖其余全部 payload；
- `release-integrity.cat` 使用 Windows catalog v2/SHA-256，覆盖 checksum 文件和全部 payload；
- catalog 自身使用批准的首方证书做 Authenticode 签名并要求可信时间戳。

正式打包在 catalog 生成后立即执行 `Test-FileCatalog`；独立验包和服务安装前再次验证 catalog、SHA-256 算法、catalog 签名/时间戳以及部署侧批准的证书指纹。缺文件、增文件、替换内容、修改 checksum、伪造 manifest 或使用未批准证书都会 fail-closed。该生成、完整复验和篡改拒绝代码已经接入；但当前没有真实签名证书、签名 catalog 或正式包，所以证据状态仍是 No-Go。

2026-07-16 的隔离工程 fixture 已证明：合法 engineering 包静态验证 exit 0；增加未列文件和修改已列 README 分别因双向库存/SHA 不符 exit 1；把包内 migration 脚本替换成写外部 marker 并重算 checksum 后，未授权工程验包仍 exit 0 且 marker 不存在；wrapper 默认正式模式拒绝旧 engineering 包，验包前后包目录哈希不变。这是 verifier 行为证据，不是签名 formal-release/catalog 证据。

### 5.3 部署侧 package-only 正式验包

正式包必须先在部署侧使用包外信任锚验证，不得从包内 manifest 学习“批准证书”：

```powershell
scripts/verify-runtime-package.ps1 `
  -PackageDir target/packages/steel-inspection-runtime `
  -ExpectedFirstPartyThumbprint $env:STEEL_RELEASE_SIGNER_THUMBPRINT `
  -AllowedVendorSdkSignerThumbprints @($env:STEEL_VENDOR_SDK_SIGNER_THUMBPRINTS -split ',') `
  -ExpectedPublisher $env:STEEL_DESKTOP_PUBLISHER `
  -ExpectedReleasePolicySha256 $env:STEEL_RELEASE_POLICY_SHA256 `
  -ExpectedBundleToolchainManifestSha256 $env:STEEL_BUNDLE_TOOLCHAIN_MANIFEST_SHA256 `
  -ExpectedExternalComponentsSha256 $env:STEEL_EXTERNAL_COMPONENTS_SHA256
```

wrapper 默认要求正式包。首方 signer、vendor allowlist、精确 publisher、策略 SHA-256、bundle-toolchain manifest SHA-256 和 external-components policy SHA-256 这六类信任输入都必须来自包外发布审批；不得从 manifest 或包内证据文件自动接受。它先以这些信任锚、双向 checksum 和完整 catalog 建立信任，再允许执行包内契约/客户端检查；不会先运行未验证包中的脚本。该流程还核对 package class、同次构建来源、`npm ci`、四个 lock、tauri.conf/Tauri Cargo manifest、CycloneDX SBOM/external policy、数据库 contract/migration index、`build-evidence/desktop-release-policy.json`、`tauri-feature-resolution.json`（解析 target/features 且禁用 devtools）和 `bundle-toolchain-manifest.json` 的精确组件/文件清单、releaseVersion/tag/commit，并要求：精确一个 MSI 和一个 NSIS；MSI ProductVersion、NSIS/桌面 EXE 文件版本等于 releaseVersion；桌面 EXE/MSI/NSIS、五个首方后台 EXE 和 catalog 均由指定首方证书有效签名并带时间戳；`nvt_lvm_sdk.dll` 的 signer 位于 vendor allowlist；VC_redist.x64.exe 由 Microsoft Corporation 有效签名；WebView2 声明为 offlineInstaller。

SBOM 当前门禁的边界必须保留在发布风险记录中：六个类别都要求至少一项，但每类允许多项，不能把 external component 总数写死为 6；静态验包已绑定 SBOM/external policy 的 hash、serial、计数、lock 和工具证据，但尚未从四个 lock 独立重建完整 npm/Cargo inventory；PowerShell JSON 解析后也不能可靠识别重复 member。正式构建/语义验证固定使用 Windows PowerShell 5.1 或 PowerShell 6.2+，禁止 6.0/6.1。批准版 `external-components.json` 及其带外 hash 尚未提供，因此当前不能生成真实 formal-release SBOM。

工程包必须显式传 `-Engineering`，默认只做静态 manifest/布局/哈希检查，不执行包内脚本。只有本机生成且已通过其他方式确认可信的工程包，才可再显式传 `-AllowPackageCodeExecution` 运行包内检查；该开关不改变其 engineering 身份，也不能用于生产安装。

对关键文件仍可保留人工复核：

    Get-AuthenticodeSignature <file> | Format-List Status,StatusMessage,SignerCertificate,TimeStamperCertificate
    Get-FileHash <file> -Algorithm SHA256

当前没有可用的代码签名证书，当前裸 Tauri EXE 为 `NotSigned`，没有 MSI/NSIS、签名 catalog 或合格正式包。签名和完整性门禁的实现不能替代这些真实证据，也不能替代无源码、无开发工具、断网干净目标机上的安装、启动、升级、回滚和卸载。

## 6. 算法配置、准入报告与运行追溯

### 6.1 生产算法配置

生产配置固定为包内 config/algorithm/bar-surface-production.json，schema 为 steel.algorithm-config.v1。它至少绑定：

- algorithmName、algorithmVersion、configRevision；
- 网格、轮廓裁剪、MAD、缺陷深度/面积、严重度和置信度等全部生产阈值；
- 精确 requiredCameraCount=8；
- 每台相机都必须有标定、重建质量门禁必须通过、maximumSyntheticDefectCount=0。

生产运行禁止通过 CLI 或请求体悄悄覆盖版本化阈值。任何配置内容变化都会改变 configSha256，必须生成新 revision、重跑算法验收并重新签发候选包。

### 6.2 算法准入报告

config/algorithm/acceptance-report.example.json 只是模板，默认 status=pending-site-approval，**不能用于生产安装**。经批准的报告 schema 为 steel.algorithm-acceptance.v1，至少包含：

    {
      "status": "pass",
      "algorithmName": "...",
      "algorithmVersion": "...",
      "configRevision": "...",
      "configSha256": "...",
      "scriptSha256": "...",
      "coreSha256": "...",
      "releaseCommit": "...",
      "datasetRevision": "...",
      "datasetSha256": "...",
      "evaluatorRevision": "...",
      "evaluatorSha256": "...",
      "calibrationRevision": "...",
      "calibrationSha256": "...",
      "metrics": {},
      "acceptanceCriteria": {},
      "approvals": {
        "algorithmOwner": "...",
        "qualityOwner": "...",
        "approvedAt": "..."
      }
    }

报告中的批准人字段是质量流程记录，不是数字签名。报告文件仍必须通过发布包 SHA-256、ACL 和发布签名链防篡改。只有以下条件全部成立才能把 status 改为 pass：冻结数据集、评测器、算法脚本、C++ core、生产配置和标定文件的哈希均一致；所有指标满足已签字阈值；算法和质量负责人完成审批。

安装时必须显式传入真实报告：

    $package = 'D:\ReleaseDrop\steel-inspection-runtime'
    $installArgs = @{
      RuntimeRoot = $package
      InstallRoot = 'C:\Program Files\SteelInspectionRuntime'
      StateRoot = 'C:\ProgramData\SteelInspectionRuntime'
      SecretEnvFile = 'C:\ProgramData\SteelInspection\secrets\runtime-secrets.env'
      AlgorithmAcceptanceReport = 'C:\ProgramData\SteelInspection\release\algorithm-acceptance.json'
      ExpectedFirstPartyThumbprint = $env:STEEL_RELEASE_SIGNER_THUMBPRINT
      AllowedVendorSdkSignerThumbprints = @($env:STEEL_VENDOR_SDK_SIGNER_THUMBPRINTS -split ',')
      StorageRoot = 'H:\'
      CameraStorageRoot = 'H:\'
      ArtifactAllowedRoots = 'H:\production;H:\camera1;H:\camera2;H:\camera3;H:\camera4;H:\camera5;H:\camera6;H:\camera7;H:\camera8;G:\bar-surface-algorithm'
    }
    & (Join-Path $package 'install-runtime-service.ps1') @installArgs

安装前运行校验器并保存 JSON 审计输出：

    & (Join-Path $package 'test-algorithm-acceptance-report.ps1') -ReportPath 'C:\ProgramData\SteelInspection\release\algorithm-acceptance.json' -ConfigPath (Join-Path $package 'config\algorithm\bar-surface-production.json')

当前校验器强制检查 status、算法/配置身份与配置哈希、dataset/evaluator、calibration、script/core、release commit、六项指标/标准和两方审批。安装器还把报告与包内实际配置、标定、Python 脚本、C++ core 及 manifest release commit 做精确比对。校验通过仍只证明“报告与候选包一致”，不能替代冻结数据集、真实指标和负责人签字本身。

### 6.3 每次运行必须持久化的追溯信息

每次生产算法运行的 manifest/记录至少必须保存并通过 Rust 生产门禁：

    {
      "algorithmName": "...",
      "algorithmVersion": "...",
      "configRevision": "...",
      "configSha256": "...",
      "calibrationRevision": "...",
      "calibrationSha256": "...",
      "inputSummarySha256": "...",
      "inputFrameIds": [],
      "inputArtifactCount": 0,
      "inputArtifacts": [
        { "camera": "...", "frameId": "...", "kind": "depth", "bytes": 0, "sha256": "..." }
      ],
      "thresholds": {},
      "qualityGate": { "passed": true, "reasons": [] },
      "realDefectCount": 0,
      "syntheticDefectCount": 0
    }

生产实现还把每次运行绑定到 acceptanceReportSha256、datasetRevision/datasetSha256、evaluatorRevision/evaluatorSha256、scriptSha256、coreSha256 和 releaseCommit；Python 与 Rust 分别校验，readiness 也与当前包内文件逐项比对。输入文件在处理前计算逐文件哈希，并在完成后复核，防止处理期间被替换。缺字段、哈希不一致、八相机不完整、质量门禁失败或 synthetic 数量非零时，算法任务必须失败，readiness 必须为 503，不得生成生产质量结论。正式放行仍需用真实通过报告和现场输入跑出一份可复核证据。

### 6.4 检测报告归档与打印

生产报告先由 Service 从数据库重新读取完整检测记录，形成 `steel.inspection.report.v1` 文档；其 SHA-256 决定 `RPT-<inspection>-<hash12>`，再以 `steel.inspection.report-archive.v1` 信封不可变落盘。相同快照重复签发复用原文件，记录变化产生新版本，旧字节不能覆盖。

数据库备份不包含 `StateRoot\reports\inspection` 下的正式报告归档，必须使用随包发布的 `manage-report-archives.ps1` 单独执行 `Verify`、`Backup` 和离线 `Restore`。脚本先校验信封、目录/文件身份和文件哈希；生产 `Verify/Backup` 必须提供管理员 token，逐 inspection 调用 Service 历史接口，由 Rust 使用与签发相同的序列化逻辑重算 document SHA-256、内容寻址 reportId 及全部身份约束，避免跨语言 JSON 数值格式造成误判。备份复制后重新核对源清单，复制期间若有新签发或变化则拒绝发布不一致快照；`-AllowOfflineBackupWithoutServiceValidation` 仅供隔离回归，生产不得使用。恢复默认拒绝 manifest 中 `serviceValidated=false` 的备份；紧急使用 `-AllowRestoreFromOfflineUnvalidatedBackup` 后必须保持生产准入关闭，直至固定版本 Service 启动并完成带 token 的权威 `Verify`。恢复要求独立保存的 manifest SHA-256 和 `RESTORE REPORTS <backupId>` 确认短语，先在 StateRoot 同卷目标目录完整暂存并复验，再保留旧归档树、rename 发布新树；收据写入也属于提交条件，失败会恢复旧树。数据库与报告恢复是两个有序操作，复产前必须把两份收据一起复核，并实测历史列表、指定版本正文和打印。

历史列表只返回摘要，但 Service 会先逐份重算并校验 schema、文件名/reportId、内容寻址 ID、归档/文档 inspectionId、materialId 和 documentSha256；目录内出现损坏 JSON、异常文件或任一不一致时，整个列表返回 409、损坏数量与文件名，客户端显示“停止打印并恢复归档”，不能静默减少报告份数。重复签发命中已有文件时执行同一校验。打印或导出某一历史报告时，客户端必须调用 `GET /api/admin/records/reports/detail?inspectionId=<id>&reportId=<id>`；失败时不允许退回当前页面数据。前端据此生成 UTF-8、A4 横向打印 HTML，包含全部缺陷、算法/配置/标定/数据集/评测器、质量门禁、源帧/ROI/点云/剖面索引以及三方签字栏。现场验收应把 HTML 打印为 PDF，核对多页表头重复、中文字体、长路径换行、空缺陷记录和最大缺陷数量分页。

## 7. 后台服务安装前检查

### 7.1 目录与 ACL

- 安装参数 `RuntimeRoot` 是只读源包，`InstallRoot` 默认 `%ProgramFiles%\SteelInspectionRuntime`，最终运行目录固定为其 `releases\<semver>-<commit12>` 子目录。三者都不能是卷根；SourcePackageRoot、InstallRoot、StateRoot、secret/report policy 与生产数据写域必须双向互不包含/重叠。安装器拒绝 reparse point，对源、暂存和最终树重复执行无跳过的 catalog/签名验证，锁定暂存树后同卷 rename，已有同名最终目录一律拒绝覆盖。SCM `ImagePath` 不使用 junction/current 链接。
- `StateRoot` 默认 `%ProgramData%\SteelInspectionRuntime`，必须与源包和 InstallRoot 不重叠。其 `config/runtime-service.env`、`logs`、`service`、`capture-config`、`temp`、`work` 和 `deployment` 用于可变状态；`deployment` 包含 `upgrade.json`、`active.json`、history、backups 与 restore-history。既有状态树在任何写入前检查 owner、DACL、祖先和 reparse，异常即 fail-closed；SYSTEM/Administrators 对普通状态项有 FullControl，公共 env 单独按只读策略保护。
- 旧版本若曾把可变文件写在 `RuntimeRoot` 内，不能通过“catalog 跳过这些文件”原地升级。必须部署新的完整签名 payload root，把批准的状态迁移到受保护 `StateRoot`，并做迁移/回滚验收。
- 外部 secret env 和算法准入报告不得位于 RuntimeRoot 或 StateRoot 内，并同样被保护及检查祖先目录。它们必须位于 owner 为 SYSTEM、Administrators 或 TrustedInstaller，且非受信账号没有删除/替换权限的受保护目录，否则安装 fail-closed。
- 生产数据目录与 `StateRoot` 应允许服务账户执行必要写入，但不得因此放宽不可变二进制目录权限。

建议归档：

    icacls 'C:\Program Files\SteelInspectionRuntime\releases' /T
    icacls 'C:\ProgramData\SteelInspectionRuntime' /T
    icacls 'C:\ProgramData\SteelInspection\secrets' /T
    icacls 'C:\ProgramData\SteelInspection\release\algorithm-acceptance.json'

### 7.2 端口、存储和秘密

- TCP 4317/4873/4881/4882 和 UDP 4883 的占用情况明确；只开放批准的 OT 边界。
- H:\camera1..camera8、H:\production 和算法产物目录存在、映射正确、可写且水位满足现场容量模型。
- ArtifactAllowedRoots 只列狭窄产物目录，不能包含盘符根、配置、标定或维护目录。
- secret env 只允许 TRIGGER_SHARED_SECRET、TRIGGER_OPERATOR_TOKEN、STEEL_DATABASE_URL 和 STEEL_BOOTSTRAP_ADMIN_PASSWORD。两个触发秘密必须不同，且各至少 32 UTF-8 字节。
- 生产报告、日志和命令行输出不得包含 secret、数据库密码或完整连接串。

## 8. Supervisor 风险、验收与放行条件

Supervisor 的静态契约和 --check 只能证明配置/布局预检，不能证明 Windows 服务生命周期正确。以下项目必须逐项取得运行证据：

当前源码已实现并通过本机回归的部分包括：子进程以挂起状态创建，限制可继承 stdin/stdout/stderr 句柄，分配带 KILL_ON_JOB_CLOSE 的 Job Object 后再恢复；capture、trigger 和 service 使用应用级 HTTP 身份/健康探针；trigger 同步绑定 4881/4882/4883。Trigger/Service admission 检查和 `inFlight` 增加位于同一互斥区，RAII 递减；排空依次请求 Trigger 和 Service，连续 4 次确认两端零状态。Service 会先发布 drain 状态，再等待生产命令屏障：纯算法计算因此可以合作取消，已进入相机或设备写入边界的操作仍等待真实结果。日志泵在子进程不停机时按精确 50 MiB 轮转并保留 5 代。Supervisor 原子写入 `StateRoot/service/supervisor-status.json`，预算耗尽跨退出保留，整组连续稳定 30 秒后恢复；Rust 将耗尽或非法状态转为持久系统告警。已有 Service 140/140、Trigger 17/17、C++ 9/9、Supervisor MSVC Release 构建和综合脚本证据；仍须在最终 clean commit 和管理员目标机上重跑。

| 项目 | 目标行为 | 当前放行要求 |
| --- | --- | --- |
| 子进程句柄 | stdout/stderr 可继承但不泄漏其他宿主句柄 | 回归证明三进程日志可持续写入，非目标句柄未继承 |
| 进程树回收 | 每个子进程及其后代受 Job Object 管理，宿主异常退出不会留下孤儿 | 分别注入 capture/trigger/service/supervisor 崩溃，确认整树退出、端口释放并按策略恢复 |
| 触发监听器 | HTTP 4881、TCP 4882、UDP 4883 任一绑定失败都使 trigger 启动失败 | 逐个占用端口并证明 SCM 不会误报可用；健康响应显示每个 listener bound |
| 应用级 readiness | 不是只做 TCP connect，而是校验正确服务和业务健康字段 | 用错误进程占端口、返回 500、依赖不健康三种场景证明 fail-closed |
| 优雅停止 | 先 Trigger drain、再 Service drain；完成既有安全收尾后同时通知子进程退出 | 本地已覆盖 drain 成功/超时与严格白名单；业务排空最多 60 秒，停止阶段最多 30 秒，SCM 最坏约 90 秒。目标机需核对 wait hint 100 秒、安装器等待 120 秒和真实节拍 |
| SCM 状态机 | START_PENDING/RUNNING/STOP_PENDING/STOPPED、checkpoint 和错误码合法 | 用 Windows 事件日志与 sc queryex 归档启动、停止、启动失败和内部重启全过程 |
| 重启预算 | 进程内预算与 SCM failure actions 不形成无限重启 | 预算耗尽会原子持久化并生成 `supervisor-restart-budget-exhausted` 告警，整组稳定 30 秒后自动闭环；SCM 已改为 5 秒重启、30 秒重启、第三次 none。仍须用目标机连续故障证明两层策略组合后稳定停止 |
| 日志轮转 | 运行中达到阈值会切换到新文件并保留约定代数 | 本地持续输出已证明 50 MiB 在线切换与 `.1`–`.5`；最终包在真实 StateRoot 再归档一次 |
| 升级事务 | 失败时不会留下已停服或半配置 SCM/env 状态 | 版本目录、三段验证、mutex、持久 journal、SCM 直指和 pre-DB 恢复已实现；数据库迁移 phase、签名 recover-only、开机恢复和逐 phase 断电演练仍缺失 |
| 运行目录 ACL | LocalSystem 不会执行普通用户可写二进制 | 在目标机执行 ACL 审计并由安全/运维签字 |

Supervisor 回归至少包括：正常启动/停止、单子进程异常、Supervisor 异常、端口冲突、错误服务占端口、磁盘写满、日志阈值、秘密缺失、算法报告失效、存储水位不足、开机自启、升级失败和卸载后端口释放。

## 9. 正常运维 SOP

### 9.1 开机

1. 核对相机、存储、网络、时间同步和数据库状态。
2. 启动 SteelInspectionRuntime，确认 Windows 服务状态。
3. 检查 Rust /api/health/ready/details；至少核对 database、taskWorker、capture、calibration、storage、trigger、algorithm、productionPolicy。
4. 确认 capture 八相机发现/SN 映射、trigger 三种 listener 和存储水位；`level=warning` 时必须记录剩余 GiB、百分比和预计剩余小时，并在进入 hard watermark 前释放容量。
5. 打开 Tauri 客户端，以命名账号登录；首次管理员必须完成强制改密。
6. 在放行进钢前执行一次只读检查，并记录班次开始时间和软件版本。

只有服务 Running 但 readiness 非 200 时，生产仍为 No-Go。

开发现场若正在用 `target/capture/Release` 连续采集，不要为了验证候选直接覆盖该目录。使用 `build-capture-headless.ps1 -BuildDir app/capture/build` 构建隔离候选，再以 `package-runtime.ps1 ... -CaptureBuildRoot app/capture/build` 生成 engineering 包。该路径只用于不停线候选验证；正式发布仍必须在维护/受审计构建环境中从 clean tag 清理并重建 canonical `target/capture`。

包内模拟验收必须显式运行在 `development + demo`，并让 Trigger 的 HTTP/TCP/UDP 使用连续的隔离端口组。例：`-ServicePort 5073 -TriggerPort 5081` 对应 5081/5082/5083。验收报告必须同时给出三个端口、四个 durable task ID、稳定 chainId、`require-success` 和精确依赖顺序；只证明 HTTP 端口可用不算 Trigger 隔离完成。

任何 package-only 或包内功能验收都不得把数据库、日志、报告或 simulated 产物写入 RuntimeRoot。使用 `test-runtime-acceptance.ps1 -WorkRoot <StateOrEvidenceRoot>`，稳定性验收使用 `test-production-stability.ps1 -WorkRoot <StateOrEvidenceRoot>`；不传时两者的 packaged 模式均使用系统临时目录。验收完成后必须再次运行 `verify-runtime-package.ps1`，并比较验收前后的 `checksums.sha256` 文件哈希和递归文件数。若验收后出现新增文件或任一值变化，视为运行包已被污染，必须丢弃并重新生成。

稳定性脚本按 provider 类型验证不同证据。真实 provider 必须检查八台设备参数和每台物理 depth/intensity/metadata 文件；simulated provider 不具备设备 trigger 字段，也不写伪物理图像，必须检查 `simulated-uri-ledger`、每轮 24 条 URI 记录、材料命名空间和 summary 计数。每轮出钢后及最终结束时必须同时满足：`activeSession=null`、任务队列可观测且深度为 0、worker 正在运行、`activeTaskId=null`、`admission.inFlight=0`；全部 material/session/inspection ID 必须非空、跨轮唯一，并且 steel-in 返回值及 summary 顶层/session/inspection 三处身份必须绑定同一轮材料。模拟多轮通过只能证明会话、任务和账本稳定，不能替代真实相机整班 soak。

当前隔离工程候选包已在外部 WorkRoot 完成 10/10 轮稳定性验收：80 个完整帧、80 个 metadata、10 组 material/session/inspection 标识全部唯一且绑定当前轮次，身份绑定失败 0，逐轮和最终收敛均通过。报告为 `production-stability-20260716-195635-841.json`，SHA-256 为 `473cae43ad767f4510e7615dd0c65d486c09a6f54d3ae1d766358efd0e1a815f`。验收前后 `checksums.sha256` 文件哈希均为 `4ce56738fedbd1b07dcd927726a8cc43e56bf6345da862576a3c740d82f418ae`，包文件数均为 111，验收后 package-only 复验通过。

稳定性脚本读取采集响应中的 `provider.summaryOutput`：绝对路径直接使用，相对路径在 `WorkRoot` 下解析，仅字段缺失时才回退到旧 `CaptureRoot\production` 推导。这样模拟验收不再因默认 `H:\` 与服务外部工作根不同而误报 summary 缺失。`test-integrated-management-smoke.ps1 -KeepRunning` 的成功报告同时返回精确 `startedProcesses` 和 `startedListeners`，便于后续脚本只回收本轮隔离实例。

上述行为由包内 `test-production-stability-workroot-contract.ps1` 固化回归。契约使用独立端口和包外目录，要求 KeepRunning 有界返回、两项进程收据和四个监听端口收据完整，随后在不传 `CaptureRoot` 的情况下完成一轮生产稳定性并证明 summary 位于服务 WorkRoot，最后精确释放本轮 TCP/UDP listener。

### 9.2 停机

1. 停止接收新 steel-info/steel-in，确认当前钢材安全出钢。
2. 等待 durable task 无运行项、writer queue 清空、无未决标定或清理事务。
3. 关闭桌面客户端；其退出不应影响后台。
4. 停止 SteelInspectionRuntime，验证 Trigger→Service 业务 drain、全部子进程同时收到 CTRL_BREAK 后在共享预算内退出、端口释放和无孤儿进程；若 60 秒业务 drain 超时，必须记录为异常停止证据。
5. 归档日志、活动告警和异常任务；必要时执行数据库备份。

### 9.3 故障处置

- 49007/restartRequired：C++ 与 Rust readiness 立即停止接单并保存 manifest/日志。Supervisor 仅在连续两次健康响应同时满足 `HTTP 200`、`restartRequired=true`、`sdkCode=49007`、无 `recoveryRequired`、无 `invalidManifest` 时，按既有重启预算自动重启整个 runtime group；恢复后必须确认精确 8/8 和新鲜完整帧。不得手工删除 fence。
- supervisor-restart-budget-exhausted：表示 600 秒窗口内已超过 5 次整组重启，Supervisor 已停止自动恢复。先保存 `StateRoot/service/supervisor-status.json` 和三进程日志，排除导致持续退出的功能原因后再人工启动服务；不得通过删除状态文件伪造恢复。整组连续稳定 30 秒后告警应自动确认并解决。若出现 `supervisor-status-invalid`，先检查状态文件是否完整且 schema 为 `steel.runtime-supervisor.status.v1`。
- 算法计算卡住/取消/异常刷屏：每次 Python 重建、标定拟合和 C++ core 都进入独立 Windows Job Object，取消、超时或直接子进程退出会回收整棵派生进程树；Job 约束建立失败时拒绝启动算法。计算受 `STEEL_ALGORITHM_PROCESS_TIMEOUT_SEC` 约束，默认 1800 秒、允许 10–7200 秒。stdout/stderr 始终被并行排空，但每个流最多保留最后 4 MiB，结果中的 `processOutput` 给出总量、保留量和截断状态；标定拟合的成功 JSON 一旦截断或无效即失败。队列取消或 Service drain 只终止纯计算阶段，任务落为 `cancelled` 并恢复运行前 `latest` 指针；排空先关闭准入，再等待生产命令锁，避免算法持锁时无法看见 drain。相机采集或标定设备写入一旦越过 dispatch 边界，不强杀 provider，以真实结果完成；仅人工迟到取消记录 `cancel_too_late`。
- 标定 needs-reconciliation：禁止设备写入，只能按原 operationId 执行 provider 确认的父子绑定回滚。
- readiness 503：按 reason 定位依赖；不得绕过 algorithm、productionPolicy、storage 或 trigger 门禁。
- 磁盘 warning：readiness 仍可用，禁止忽略；根据界面显示的剩余容量和预计时间执行归档/清理，并核对八个相机目录所在卷，避免只处理全局目录。
- 磁盘 critical：禁止新会话，允许当前会话安全收尾；按持久化 cleanup 清单处理，不得直接批量删除目录。
- `system-health` 活动告警：生产服务每 10 秒同步一次健康异常；同一异常持续期间只应有一个开放 episode。恢复后由 `system-health-monitor` 自动确认并解除；若故障再次发生，必须出现新的报警 ID。若健康状态已恢复但告警仍未闭环，按数据库/监视线程故障处理。
- 触发重放/时间窗异常：检查 NTP/PTP、来源地址和 nonce；不得长期放宽时间窗代替修复时钟。

### 9.4 BKV 六相机离线模式

1. 在 `config/project.json` 中选择 `config/runtime-modes/bkv-6.json`，并让
   `STEEL_PROJECT_CONFIG_PATH` 指向同一项目文件、`STEEL_CAPTURE_PROVIDER=bkv`。
   配置保存只更新磁盘版本；后台返回 `restartRequired:true` 后必须重启 Rust
   服务，不能把已保存配置误认为当前已生效配置。
2. 将旧 BKV 数据作为只读源放在 profile 的 `storage.sourceRoot`。先运行
   `python scripts/bkv_import_service.py --project config/project.json --once`；
   常驻管理模式使用 `--serve --port 4893`，只允许绑定 loopback。后台管理页
   通过受限代理查看任务、启动和重试，不接受浏览器提交的任意本地路径。
3. 标准输出固定在 `storage.convertedRoot`：`catalog.db` 加
   `records/<inspectionId>/record.json`、`source-provenance.json`、
   `cameras/C1..C6/frames/<sequence>/{intensity.jpg,depth.npz}` 和
   `defects/defects.json`。导入使用 `.staging` 后同卷原子发布；校验失败进入
   `imports/quarantine`，中断任务按原 job ID 重试。Windows 短暂目录占用会在
   原子 rename 边界进行有界退避重试，持续失败仍隔离并保留错误。
4. 重跑同一 source/config hash 必须得到全部 `skipped`。运维审计至少核对
   记录范围、每条 C1-C6、JPEG 可解码、NPZ schema/相机/材料/帧身份、缺陷帧
   关联、来源 SHA-256，以及 catalog 中没有 `staging` 业务记录。
5. BKV 的业务记录只读 converted catalog；服务运行状态使用本地 SQLite，
   `STEEL_DATABASE_ENGINE=sqlite` 且 `STEEL_DATABASE_FALLBACK=none`。不得配置
   在线 MySQL 连接。在线直连 profile 则继续使用其 MySQL/采集链路，不得打开
   BKV converted root。
6. BKV 不启动相机 SDK，也不显示采集管理和 3D 重建；离线回放与后台管理保留。
   直接访问这些禁用深链会回到检测终端并显示能力提示。浏览器中的后台/工具
   入口在当前页跳转，Tauri 桌面端仍使用受管独立窗口。

当前工程数据审计（2026-07-23）覆盖旧序号 1893700–1893710：11 条记录、
6 路相机、2,592 个 capture file（1,296 JPEG + 1,296 NPZ）、2 条缺陷；最终
幂等任务为 0 converted / 11 skipped / 0 quarantined。该结果是本地转换完整性
证据，不替代正式生产发布、真实相机或质量算法验收。

## 10. 升级、回滚和卸载

版本化载荷、数据库 contract/账本、持久升级 journal、SCM 激活指针、崩溃恢复和逐 phase 故障注入的规范见 [`atomic-upgrade-and-database-migration-design.md`](atomic-upgrade-and-database-migration-design.md)。在该设计的 U1–U4 验收未全部完成前，不能把当前 `-Upgrade` 的进程内 catch 回滚描述为断电安全的生产升级事务。

升级前必须：冻结新任务、完成当前会话、备份数据库/配置/算法报告、记录服务状态和开放告警、验证上一版本安装介质可用。

当前安装脚本使用 `-Upgrade` 表达显式升级意图。CLI `RuntimeRoot` 是源包；候选经过完整验证后复制到同卷 `.incoming-*`，锁定并再验证，rename 到不可变版本目录，最终再验证，SCM 直接指向该目录。`Global\SteelInspectionRuntime-Deployment`、`upgrade.json`、active/history/backups 已实现，旧 env、SCM/CIM、关键注册表和运行态在 DB 未开始时可恢复；其他不确定 DB phase 进入 failed-safe。安装器会在 catalog 信任边界之后校验数据库 contract/index，但由于没有迁移执行器，会在任何状态变化前拒绝非空 migration index；升级或复用保留 StateRoot 的重装还必须由旧 `active.json` 证明 schema 与目标相同。当前仍没有签名迁移执行器、boot-time recover-only 或完整 health-accepted commit 编排，因此只能验证同 schema 的文件/SCM 子事务：

- 失败时 SCM binPath、不可变 payload 选择、StateRoot 公共 env 和秘密引用回到旧版本；
- 数据库 migration 可回滚，或不可逆变更有单独审批和恢复方案；
- 算法报告/配置/脚本/core 不会跨版本混用；
- 回滚后重新执行 readiness、一个模拟链路和只读八相机检查。

卸载脚本与安装/升级/备份/恢复共用 `Global\SteelInspectionRuntime-Deployment`。它只接受 `committed` 或 `rolled-back` journal；非终态、`failed-safe`、损坏或 history/backup 路径越界会在任何 SCM 变更前拒绝。registry、SCM `ImagePath`、active receipt、InstallRoot/StateRoot 和当前 release 必须相互一致。默认卸载先有界停服和移除 SCM/注册表，确认 4317/4873/4881/4882/4883 TCP/UDP 绑定释放，再只删除精确当前版本目录；其它 releases、整个 StateRoot、deployment backups/history、数据库、配置、秘密、日志和生产数据均保留。`-RemoveRuntimeEnvironment` 只额外删生成的 env。`-Purge` 必须显式传双 root、具有可信部署证据、拒绝 protected root/reparse/重叠路径，并提供路径绑定短语 `PURGE SteelInspectionRuntime|INSTALL=<absolute InstallRoot>|STATE=<absolute StateRoot>`；它是顺序清理，不是跨资源原子事务。管理员目标机仍须验证无残留进程和保留边界。

## 11. 现场验收与证据归档

### 11.1 必须执行

1. 发布包布局、manifest/packageClass、双向 checksums、签名 catalog、部署侧证书 allowlist 和离线前置依赖检查；保存 package-only 机器可读结果及至少一次篡改拒绝证据。
2. 算法准入报告校验、readiness 算法门禁和一次真实运行追溯复核。
3. Windows 服务安装、开机自启、停止 drain、崩溃恢复、重启预算、日志轮转、升级/回滚、卸载。
4. test-real-hardware-acceptance.ps1 -RunCapture。
5. 八相机标定 dry-run、apply/rollback、ApplyCrash、RollbackCrash、generation/tamper 零写验证。
6. test-integrated-capture-management-full.ps1 -RequireFullCoverage 和逐项审计；当前定义必须无 skip 达到 24/24。
7. PLC/L2 HTTP/TCP/UDP 签名、重放、乱序、断网、重启和 ACK/重试时序。
8. SQLite/MySQL 备份与一台新机恢复；复核任务、告警、标定、cleanup 和产物引用。
9. 连续班次 soak、磁盘压力、相机重连、误报/漏报和处理节拍。

24/24 集成报告只证明集成矩阵，不单独代表生产 Go；算法准入、签名、离线安装、服务生命周期、灾备和责任人签字仍是独立门禁。

### 11.2 推荐证据目录

    release-evidence/<release-version>/
      00-baseline/          commit、tag、dirty 状态、版本
      01-build/             构建日志、锁文件、SBOM、编译器/SDK
      02-signatures/        签名、时间戳、证书指纹、SHA-256
      03-algorithm/         配置、准入报告、数据集/评测器清单、运行追溯
      04-install/           前置依赖、ACL、MSI/NSIS、runtime service
      05-supervisor/        SCM、进程树、端口、drain、轮转、恢复
      06-hardware/          八相机、标定、真实采集
      07-ot/                点表、HMAC、时钟、重试、网络边界
      08-data-recovery/     备份、恢复、数据一致性
      09-soak/              节拍、稳定性、异常注入
      10-signoff/           Go/No-Go 与责任人签字

每份报告必须记录 release version、commit、目标机、操作者、开始/结束时间、命令、退出码、原始日志路径和失败证据。截图只能作为辅助，不能代替机器可读报告。

## 12. Go/No-Go 签字表

正式功能放行不再通过人工浏览多份报告得出结论。复制包内 `config\acceptance` 的三个模板，填入同一 release version/commit 和证据路径，执行：

```powershell
.\new-functional-acceptance-workspace.ps1 `
  -ReleaseManifestPath .\manifest.json `
  -WorkspaceRoot D:\steel-acceptance\release-1.2.3 `
  -Line line-1 -Plc plc-1 -L2 l2-1 -TargetMachine ipc-01

.\test-functional-go-live-readiness.ps1 `
  -PlanPath D:\steel-acceptance\release-1.2.3\functional-go-live-plan.json `
  -ReportDir D:\steel-acceptance\release-1.2.3\10-signoff
```

初始化器从当前候选 manifest 自动创建 `00-release`、算法、24/24、PLC/L2、班次、目标机和签字目录，生成统一计划及两份 fail-closed 场景报告。目标目录必须为空；工具不会删除或覆盖已有验收资料。候选包一旦变化，应建立新的工作区，禁止在旧目录上换 manifest。

该汇总器只判定功能性，不把安全、签名和供应链状态计入本次 Go/No-Go。它要求六项全部通过：发布身份一致、真实标注算法验收、真实八相机无跳项 24/24、真实 PLC/L2 全链与异常场景、真实 provider 至少一个 8 小时完整班次、干净目标机完整生命周期。24/24 与稳定性脚本会把 release version、commit 和 manifest SHA-256 写入报告，汇总器逐项与当前包复核，禁止跨候选复用旧现场证据。PLC/L2 和目标机的每个场景还必须引用 `steel.functional-scenario-evidence.v1` JSON 及 lowercase SHA-256；相对路径以场景报告目录为根。证据正文必须绑定同一 release、精确 scenarioId、`result=pass`、来源系统/执行命令/raw log，并且 `observedAt` 位于本次执行开始与结束之间；批准时间不得早于执行完成。缺报告、缺场景、证据文件缺失/篡改/语义不符、版本或 manifest hash 不一致、simulated provider、时长/轮数不足、队列或会话未收敛、跨材料串账、负责人未确认，均输出结构化 `no-go`。现场采集中可加 `-AllowNoGo` 生成进度报告，但不得将其作为放行结果。

现场不要手算证据哈希。每完成一个场景，立即使用包内 `new-functional-scenario-evidence.ps1`，传入当前包 `manifest.json`、精确场景 ID、来源系统、实际操作步骤和原始日志。工具原子写入证据 JSON，并返回可直接填入场景报告的 path/SHA-256；证据同时绑定 manifest SHA-256 和 raw-log SHA-256。最终汇总会重新校验证据文件与原始日志，因此日志被替换、删除或修改都会使该场景 No-Go。

在标准工作区中应直接使用 `add-functional-scenario-evidence.ps1` 完成挂接：先填写对应报告的 `startedAt/finishedAt`，把原始日志放入该范围的 `raw` 目录，再传入 scope、scenarioId、来源系统、步骤和观测时间。工具调用生成器并原子更新唯一场景，禁止重复挂接、工作区外日志、执行窗口外观测和未知场景；写入前还会复核报告原始 SHA-256，发现另一操作员已修改报告时清理新生成的孤立证据并要求重试。负责人填写 `approvals.approvedAt` 后，整份场景报告进入冻结状态，工具拒绝继续增加或替换证据；如需重测必须创建新的候选工作区或在批准前完成全部场景。

候选 manifest 的精确 SHA-256 只记录在包外功能验收工作区和 Go/No-Go 机器报告中，不写回随包文档，避免文档参与 checksum 后形成自引用。当前功能汇总仍为 `1/6`：已通过发布身份；其余五项是实际标注算法验收、当前候选真实八相机无跳项 24/24、真实 PLC/L2 场景、真实 provider 完整 8 小时班次、干净目标机完整生命周期。最终包内短模拟循环已证明 8 个完整帧、8 个 metadata、24 条 summary 记录、身份绑定、最终收敛以及相对 `provider.summaryOutput` 的 WorkRoot 解析，但按设计不能替代真实班次。

当前候选状态报告为 `1/6`：仅 release identity 通过，另外五项均未取得最终现场证据。报告还证明现有 10 轮 simulated 验收不会被误判为生产班次，因为它同时触发 provider、8 小时时长和最小周期数三项拒绝。

| 门禁 | 当前状态 | 放行证据 | 责任人 |
| --- | --- | --- | --- |
| clean commit、tag、版本冻结、CI 全绿 | workflow 代码已补齐，发布证据未完成 | 当前仍是 dirty `0.1.0`，无 release tag，且尚无远端 CI run；最终提交必须重跑全部门禁 | 发布负责人 |
| 锁定 Release 构建和 SBOM | 代码完成，正式证据未完成 | 离线 CycloneDX 生成/复验与 11 项负向测试通过；真实 external policy、最终 clean 构建和包内证据待完成 | 构建、供应链负责人 |
| MSI/NSIS、离线 WebView2、VC++ 前置条件 | 未完成 |  | 桌面/实施负责人 |
| 全部 PE/安装器签名和时间戳 | 未完成 |  | 安全/发布负责人 |
| 双向 checksum、签名 catalog、package-only 和安装前篡改拒绝 | 代码已实现，正式证据未完成 | 无真实证书、签名 catalog 或 formal-release 包 | 安全、发布、实施负责人 |
| 算法 status=pass 准入报告和运行追溯 | 未完成 |  | 算法、质量负责人 |
| Supervisor/SCM/ACL/升级回滚现场验收 | 本机合同完成，现场未完成 | Service 134/134、Trigger 17/17、C++ 9/9、Supervisor drain/轮转/受管 49007 恢复综合检查和卸载 14/14 通过；真实管理员 SCM/effective ACL/端口/升级回滚待归档 | 后端、运维负责人 |
| 版本目录、数据库迁移账本、持久 journal 与断电恢复 | 同 schema 子事务完成，生产迁移事务未完成 | 版本目录/三段验真/journal 8/8、schema ledger 与包内 database contract/index 已实现；非空 migration index 当前 fail-closed，签名迁移器、recover-only 和逐 phase 目标机故障注入待完成 | 后端、DBA、运维负责人 |
| 当前八相机完整采集 | 功能通过，正式异常矩阵未关闭 | `BAR-20260716-114758`：184/184 完整帧，八台各 23 组 depth/intensity/metadata、零失败；仍需无 skip 的 24/24 管理报告、标定崩溃与受管恢复证据 | 设备、QA 负责人 |
| PLC/L2/OT 网络和秘密轮换 | 未完成 |  | 自动化、OT 负责人 |
| 备份与新机恢复 | v2 工具和本机合同完成，现场未完成 | SQLite 原子恢复/篡改拒绝/共享 mutex 10 项通过；真实在线备份、新机恢复、MySQL 临时库/DBA 回退和离机保存待签字 | DBA、运维负责人 |
| 生产 soak 与质量指标 | 未完成 |  | 生产、质量负责人 |

任一行未关闭，结论均为 **No-Go**。正式放行需要算法、设备、OT、安全、质量、生产、运维和发布负责人共同签字。

## 13. 关联文档

- [上线差距与收口设计](production-readiness-gap-and-closure-design.md)
- [原子载荷切换与数据库迁移设计](atomic-upgrade-and-database-migration-design.md)
- [独立运行时架构](independent-architecture.md)
- [集成采集管理验收矩阵](integrated-capture-management-acceptance.md)
- [采集 API 契约](capture-api-contract.md)
- [Qt 到 Tauri 迁移说明](qt-to-tauri-migration.md)
- [脚本使用说明](../scripts/README.md)
