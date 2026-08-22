# 建龙北满光学验收与在线同步

出厂报告中的 2D/3D 光学参数已固化为
`config/acceptance/jianslong-beiman-optical-fat.v1.json`。该文件是验收基线，不会自动向相机写参数；设备参数变更仍需走相机配置和标定审核流程。

基线包含：

- 六台 3D 相机的曝光时间、物距/视野、等高块测量值和拼接参数；
- 四台 2D 相机的 470 mm 工作距离、304 mm 视野及成像参数；
- 2D 5569 脉冲、3D 2784 脉冲和六相机计数一致性要求；
- 生产环境必须使用物理采集、六相机齐套、同步偏差为 0、GenTL 帧号无跳号、存储队列无丢轮/失败。

校验基线：

```powershell
D:\project\py312\python.exe -X utf8 scripts\validate_optical_acceptance.py
```

同时校验当前 SICK 六相机运行状态：

```powershell
D:\project\py312\python.exe -X utf8 scripts\validate_optical_acceptance.py `
  --capture-origin http://127.0.0.1:4317 `
  --output target\acceptance\optical-live.json
```

在线采集按“整轮”建立同步关系。灰度信号用于判断整根钢材进出；进入有钢状态后，同一轮中的所有非全黑相机帧都会保存，不再按单相机灰度信号删帧。`/health` 的 `acquisitionSynchronization` 返回最近 120 轮的完整率、各相机计数和偏差，实时监控页显示同一信息。

每个 `json/<index>.json` 帧元数据包含 `frameArtifact`（`steel.frame-artifact.v1`）：

- inspection、flow、session、同步轮次和同步组 ID；
- 相机 ID、SN、型号、固件和 IP；
- 本地帧序号、GenTL transport frame ID、设备/主机时间戳；
- 深度和灰度文件、尺寸、格式及 SHA-256；
- 采集 Profile 路径与 SHA-256；
- 标定文件路径、SHA-256 和 metric projection 是否已验证。

当前 SICK 深度以 `raw-device-code` 保存。只有标定配置明确声明且校验通过时，才能把 `metricProjectionVerified` 标记为 `true`；算法和生产报告不得把未验证的原始码值声明为毫米。
