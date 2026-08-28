# 服务器 FRP HTTP 隧道部署

本文用于把服务器本机的钢材检测业务服务 `http://127.0.0.1:4873`
通过 FRP 暴露为独立的公网 HTTP 地址。服务器隧道不得复用开发机现有的
`https_test` 名称或 `n9yhdrvz.zjz-service.cn` 域名，否则两台机器同时连接时会
争用同一个代理。

## 1. 服务端管理配置

FRP 配置管理页已经保存以下独立配置：

| 字段 | 值 |
|---|---|
| 配置 ID | `1727` |
| 配置名称 | `steel_inspection_server` |
| 类型 | `HTTP` |
| 本地 IP | `127.0.0.1` |
| 本地端口 | `4873` |
| 域名 | `kacg6rxr.zjz-service.cn` |
| 加密/压缩 | 默认关闭 |

服务器配置中的 `customDomains` 必须与该域名完全一致。广州节点的客户端连接
地址为 `frp-gz.zjz-service.cn:7000`。可在
[FRP 配置管理页](https://zjz-service.cn/frpm/cfg) 检查在线状态；部署前显示离线是正常的。

## 2. 准备服务器本地配置

仓库模板位于
[`config/frp/steel-inspection-server.example.toml`](../config/frp/steel-inspection-server.example.toml)。
在服务器管理员 PowerShell 中复制模板：

```powershell
$RepoRoot = 'D:\project\steel-plate-3d-inspection-main'
$FrpRoot = 'C:\ProgramData\SteelInspection\frp'
$Config = Join-Path $FrpRoot 'steel-inspection-server.local.toml'

New-Item -ItemType Directory -Force -Path $FrpRoot | Out-Null
Copy-Item `
  (Join-Path $RepoRoot 'config\frp\steel-inspection-server.example.toml') `
  $Config
notepad.exe $Config
```

只在服务器本地文件中替换 `REPLACE_WITH_FRP_USER` 和
`REPLACE_WITH_FRP_PASSWORD`。托管平台的技术 `user` 可能与网页登录名不同；
必须使用配置管理页为该代理分配的技术用户 ID。用户名和密码都只能保存在本机。
域名已经写入模板，不要替换为开发机的 `n9yhdrvz.zjz-service.cn`。

最终的服务器本地配置结构如下：

```toml
serverAddr = "frp-gz.zjz-service.cn"
serverPort = 7000
user = "本机填写托管平台分配的技术用户 ID"
loginFailExit = true

transport.protocol = "tcp"
transport.poolCount = 5
transport.tls.enable = true

[metadatas]
password = "在服务器本地填写 FRP 密码"

[[proxies]]
name = "steel_inspection_server"
type = "http"
localIP = "127.0.0.1"
localPort = 4873
customDomains = ["kacg6rxr.zjz-service.cn"]

[proxies.transport]
useEncryption = false
useCompression = false

[proxies.healthCheck]
type = "http"
path = "/api/health/live"
intervalSeconds = 10
timeoutSeconds = 3
maxFailed = 3
```

`*.local.toml` 已加入仓库忽略规则。真实用户名和密码只能保存在服务器本地配置中，
不得提交到 Git；本仓库是公开仓库。

## 3. 安装并前台验证

仓库安装器固定官方 FRP `v0.71.0` Windows amd64 版本并校验发布包
SHA-256；测试脚本还会用官方 `frpc verify` 验证模板。先执行：

```powershell
Set-Location 'D:\project\steel-plate-3d-inspection-main'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\install-frp-client.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\test-frp-client-contract.ps1
```

再确认服务器业务服务可访问：

```powershell
Invoke-WebRequest `
  -Uri 'http://127.0.0.1:4873/' `
  -UseBasicParsing `
  -TimeoutSec 20 |
  Select-Object StatusCode
```

验证本机配置，然后启动为隐藏的独立进程：

```powershell
$Config = 'C:\ProgramData\SteelInspection\frp\steel-inspection-server.local.toml'

powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run-frp-client.ps1 `
  -ConfigPath $Config `
  -VerifyOnly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run-frp-client.ps1 `
  -ConfigPath $Config `
  -Detach
```

启动器会限制本机配置 ACL，要求日志依次出现 `login to server success`、
`proxy added: [steel_inspection_server]` 和 `start proxy success`，并从公网域名
回测 `/api/health/live` 为 HTTP 200 后才报告成功。如果平台提示
代理名称或域名已被占用，应在管理页重新创建独立配置，不要停止或修改开发机的
`https_test`。

## 4. 公网验收

保持 `frpc` 前台运行，在另一终端测试管理页分配的新域名：

```powershell
$PublicDomain = 'kacg6rxr.zjz-service.cn'

curl.exe --noproxy '*' -I --max-time 20 "http://$PublicDomain/"
curl.exe --noproxy '*' --max-time 20 "http://$PublicDomain/api/health"
```

验收要求：

- 首页返回 HTTP `200`；
- 页面标题为“北满特钢小棒检测系统”；
- `/api/health` 能返回业务服务健康信息；
- 管理页中 `steel_inspection_server` 显示在线；
- 开发机 `https_test` 仍能独立启动，不出现名称或域名冲突。

## 5. 配置为开机启动

前台验收通过后按 SYSTEM 身份注册开机任务：

```powershell
$Frpc = 'C:\Program Files\frp\frpc.exe'
$Config = 'C:\ProgramData\SteelInspection\frp\steel-inspection-server.local.toml'
$TaskName = 'SteelInspectionFrpc'

$Action = New-ScheduledTaskAction `
  -Execute $Frpc `
  -Argument "-c `"$Config`"" `
  -WorkingDirectory (Split-Path -Parent $Frpc)
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal `
  -UserId 'SYSTEM' `
  -LogonType ServiceAccount `
  -RunLevel Highest

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Description 'Steel inspection FRP HTTP tunnel' `
  -Force
Start-ScheduledTask -TaskName $TaskName
Get-ScheduledTaskInfo -TaskName $TaskName
```

最后重复公网验收。修改本地端口、域名或密码后，应重启
`SteelInspectionFrpc` 任务并再次检查管理页在线状态。
