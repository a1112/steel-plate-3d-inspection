param(
  [string]$FrpcExe = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TemplatePath = Join-Path $RepoRoot "config\frp\steel-inspection-server.example.toml"
if ([string]::IsNullOrWhiteSpace($FrpcExe)) {
  $FrpcExe = Join-Path $RepoRoot "target\tools\frp\0.71.0\expanded\frp_0.71.0_windows_amd64\frpc.exe"
}
if (-not (Test-Path -LiteralPath $FrpcExe -PathType Leaf)) {
  throw "Missing frpc executable. Run scripts/install-frp-client.ps1 first."
}

function Assert-Condition {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

$Template = Get-Content -LiteralPath $TemplatePath -Raw
Assert-Condition ($Template -match '(?m)^serverAddr = "frp-gz\.zjz-service\.cn"\r?$') "FRP server address changed unexpectedly."
Assert-Condition ($Template -match '(?m)^serverPort = 7000\r?$') "FRP server port changed unexpectedly."
Assert-Condition ($Template -match '(?m)^user = "REPLACE_WITH_FRP_USER"\r?$') "Committed FRP template must not contain the account name."
Assert-Condition ($Template -match '(?m)^password = "REPLACE_WITH_FRP_PASSWORD"\r?$') "Committed FRP template must not contain the account password."
Assert-Condition ($Template -match '(?m)^name = "steel_inspection_server"\r?$') "FRP proxy name changed unexpectedly."
Assert-Condition ($Template -match '(?m)^type = "http"\r?$') "FRP proxy must use HTTP mode."
Assert-Condition ($Template -match '(?m)^localIP = "127\.0\.0\.1"\r?$') "FRP must publish only a loopback target."
Assert-Condition ($Template -match '(?m)^localPort = 4873\r?$') "FRP must publish only the unified business entrypoint."
Assert-Condition ($Template -match '(?m)^customDomains = \["kacg6rxr\.zjz-service\.cn"\]\r?$') "FRP domain changed unexpectedly."
Assert-Condition ($Template -match '(?m)^transport\.tls\.enable = true\r?$') "FRP control transport must enable TLS."
Assert-Condition ($Template -match '(?m)^useCompression = false\r?$') "FRP must avoid recompressing image responses."
Assert-Condition ($Template -match '(?m)^path = "/api/health/live"\r?$') "FRP must health-check the live endpoint."

$RunRoot = Join-Path $RepoRoot ("target\test\frp-client-contract\" + (Get-Date -Format "yyyyMMdd-HHmmss-fff"))
New-Item -ItemType Directory -Force -Path $RunRoot | Out-Null
$TestConfig = Join-Path $RunRoot "steel-inspection-server.local.toml"
$Rendered = $Template.Replace("REPLACE_WITH_FRP_USER", "contract-user").Replace("REPLACE_WITH_FRP_PASSWORD", "contract-password")
[System.IO.File]::WriteAllText($TestConfig, $Rendered, [System.Text.UTF8Encoding]::new($false))
& $FrpcExe verify -c $TestConfig
Assert-Condition ($LASTEXITCODE -eq 0) "Official frpc rejected the committed TOML template."
Write-Host "FRP client contract passed: hosted account metadata, TLS, assigned HTTP proxy, loopback target, no recompression, and official config verification."
