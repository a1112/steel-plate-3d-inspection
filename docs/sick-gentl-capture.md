# SICK GenTL 采集与 LG_3D 兼容接入

本文说明如何把真实 SICK 3D 线扫相机接入当前系统，并同时生成
`LG_3D` 可直接读取的数据。当前实现是独立 Python sidecar：相机仍由单一进程
独占，Rust 服务通过既有 `external-api` HTTP 契约访问它，原 LVM/NVT C++
采集链路不受影响。

## 实现边界

- GenTL Producer：使用 SICK 安装包提供的 `SICKGigEVisionTL.cti`。
- GenICam 客户端：使用 Harvesters，按相机序列号唯一绑定设备。
- 采集模式：强制设置并回读 `DeviceScanType=Linescan3D`。
- 组件识别：按 GenICam `data_format` 选择 `Coord3D_C16` 和 `Mono8`，不依赖
  payload 中的组件位置。
- 原始深度：`Coord3D_C16` 以 `uint16` 保存。它是设备原始码值，不等同于
  毫米；物理坐标换算必须使用同帧配置中的 offset、scale 和 invalid value，
  并经过现场标定确认。
- 站点拓扑：仓库自带 `sick-single-lab` 单相机站点。算法和重建能力保持关闭，
  直到标定、多相机同步和 FAT 证据齐全。

## 1. 固化真实硬件身份

复制站点采集配置后，只在机器本地副本中填写真实值：

```powershell
Copy-Item `
  config\sites\sick-single-lab\capture.json `
  config\sites\sick-single-lab\capture.local.json

$env:SICK_GENTL_CTI = 'C:\Program Files\SICK\GenTL\SICKGigEVisionTL.cti'
Get-FileHash -Algorithm SHA256 $env:SICK_GENTL_CTI
```

必须替换以下占位项：

- `sick.ctiSha256`：FAT 审核过的 CTI SHA-256；
- `cameras[0].serialNumber`：探测结果中的精确序列号；
- `cameras[0].model`：设备回读的精确型号；
- `cameras[0].firmware`：设备页面或 SICK 工具回读的精确固件版本；
- `cameras[0].ip`：规划并实际配置的相机地址；
- `storageRoot` 和相机 `storageRoot`：目标机器上的数据盘目录；
- `nodeOverrides`：仅填写该型号已经确认、且要求固定回读的触发/编码器节点。

配置加载、CTI 哈希、序列号、型号或组件格式任一不一致都会关闭采集。不要把
占位值改成看似合法的假值来绕过预检。

> `capture.local.json` 只用于独立金样调试。接入 Rust 前，应通过后台的现场配置
> 克隆/发布流程，把相同的审核内容写入实际选中站点的 `capture.json`，并让
> sidecar 也读取这个文件。这样运行配置哈希和相机实际配置才保持一致；不要只改
> `config/project.json` 的默认站点指针。

## 2. 安装与探测

建议使用与 `LG_3D` 一致的 Python 3.11 运行环境：

```powershell
py -3.11 -m venv .venv-sick
.\.venv-sick\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r scripts\sick_capture_requirements.txt

python scripts\sick_probe.py `
  --cti $env:SICK_GENTL_CTI `
  --output target\sick-probe.json
```

探测结果会记录 CTI 路径、SHA-256、设备数量、序列号、型号和传输层类型。
预期只有一个与配置序列号完全一致的设备；0 个或多个匹配都会拒绝连接。

## 3. 单独采集金样数据

先绕过业务服务完成真实相机金样采集：

```powershell
python scripts\sick_capture_lg3d.py `
  --profile config\sites\sick-single-lab\capture.local.json `
  --material-id FAT-SICK-001 `
  --session-id FAT-SICK-001-RUN-01 `
  --rounds 20 `
  --discard-black-frames
```

校验 LG_3D 兼容目录：

```powershell
python scripts\validate_lg3d.py `
  D:\C1\FAT-SICK-001
```

每个相机、每个材料生成以下结构：

```text
<camera-storage-root>/<material-id>/
  camera_config.json
  3d/<zero-based-index>.npz
  2d/<zero-based-index>.jpg
  json/<zero-based-index>.json
  depth/<one-based-sequence>.png
  intensity/<one-based-sequence>.png
  metadata/<one-based-sequence>.json
```

LG_3D 目录严格使用 NPZ 键 `array` 和质量 95 的 JPEG。Steel 目录中的深度
PNG 仍是无损 `uint16` 原始 C16，不应标成毫米图。二进制文件先发布，LG_3D
元数据随后发布，`metadata/<sequence>.json` 最后写入并带有 `complete=true`，
它是 Steel 侧的完整帧提交标志。中断留下的二进制孤儿文件不会被当作完整帧，
后续采集会跳过已占用序号，且不会覆盖旧文件。

## 4. 接入 Rust 服务和操作端

先在独立终端启动 SICK sidecar：

```powershell
$env:SICK_GENTL_CTI = 'C:\Program Files\SICK\GenTL\SICKGigEVisionTL.cti'
python scripts\sick_capture_service.py `
  --profile config\sites\sick-single-lab\capture.json `
  --host 127.0.0.1 `
  --port 4317
```

预检 sidecar：

```powershell
Invoke-RestMethod http://127.0.0.1:4317/health
Invoke-RestMethod http://127.0.0.1:4317/api/storage/status
Invoke-RestMethod http://127.0.0.1:4317/api/cameras
```

然后复制并检查环境模板，再启动 Rust 服务：

```powershell
Copy-Item config\env\sick-gentl.env.example config\env\sick-gentl.local.env
scripts\run-service.ps1 `
  -EnvFile config\env\sick-gentl.local.env `
  -NoCaptureAutostart
```

关键设置如下：

- `STEEL_SITE_CONFIG_ID=sick-single-lab`；
- `STEEL_CAPTURE_PROVIDER=external-api`，Rust 只代理已启动的 sidecar；
- `STEEL_CAPTURE_SERVICE_AUTOSTART=0`，避免 Rust 启动原 C++ LVM 子进程；
- `CAPTURE_SERVICE_ORIGIN=http://127.0.0.1:4317`。

Rust 的生产采集现在从运行站点读取相机数量，单相机站点默认发送
`expectedCameras=1`。`steel-in` 之前的生产采集会以稳定错误
`49000/capture_discarded_not_armed` 拒绝；只有带材料 ID、会话 ID 且保存已启用
的进场事件才会打开生产写入门控。

## 5. FAT 最低检查项

1. 记录相机型号、序列号、固件、IP、SICK 安装包版本、CTI 路径和 SHA-256。
2. 记录 `DeviceScanType`、触发源、曝光、行频、编码器及所有 node override 的回读值。
3. 连续采集至少一组金样，验证没有组件格式漂移、短帧、黑帧或尺寸变化。
4. 用 `validate_lg3d.py` 校验目录，并用 `LG_3D` 实际加载同一份 NPZ/JPEG/JSON。
5. 校验相机时间戳频率、主机 UTC/单调时间、帧顺序和生产事件边界。
6. 模拟 sidecar 中止与磁盘写入失败，确认没有完整元数据标记的文件不进入业务记录。
7. 完成坐标标定后再启用物理尺寸、拼接、缺陷算法或 `reconstruction=true`。

本接入阶段提供真实 SICK 采集、LG_3D 兼容存储和现有 Rust/UI 契约适配；它不把
Python sidecar 宣称为最终量产 C++ 驱动，也不解除仓库现有的生产 No-Go 条件。
