param(
  [string]$ConfigPath = "",
  [string]$FrpcExe = "",
  [string]$RunRoot = "",
  [string]$PublicUrl = "http://kacg6rxr.zjz-service.cn",
  [ValidateRange(5, 120)]
  [int]$ReadyTimeoutSec = 30,
  [switch]$Install,
  [switch]$VerifyOnly,
  [switch]$Detach
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $RepoRoot "config\frp\steel-inspection-server.local.toml"
} elseif (-not [System.IO.Path]::IsPathRooted($ConfigPath)) {
  $ConfigPath = Join-Path $RepoRoot $ConfigPath
}
if ([string]::IsNullOrWhiteSpace($RunRoot)) {
  $RunRoot = Join-Path $RepoRoot "target\run\frp-client"
}

$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath -ErrorAction Stop).Path
$RunRoot = [System.IO.Path]::GetFullPath($RunRoot)
New-Item -ItemType Directory -Force -Path $RunRoot | Out-Null

function Protect-SecretFile {
  param([string]$Path)
  $Acl = Get-Acl -LiteralPath $Path
  $AllowedSids = @(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
    "S-1-5-18",
    "S-1-5-32-544"
  )
  $AccessSids = @($Acl.Access | ForEach-Object {
    $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  })
  $AlreadyProtected = $Acl.AreAccessRulesProtected -and
    @($AccessSids | Where-Object { $_ -notin $AllowedSids }).Count -eq 0 -and
    @($AllowedSids | Where-Object { $_ -notin $AccessSids }).Count -eq 0 -and
    @($Acl.Access | Where-Object {
      $_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl
    }).Count -eq 0
  if ($AlreadyProtected) {
    return
  }
  $Acl.SetAccessRuleProtection($true, $false)
  foreach ($Rule in @($Acl.Access)) {
    [void]$Acl.RemoveAccessRuleAll($Rule)
  }
  $Rights = [System.Security.AccessControl.FileSystemRights]::FullControl
  $Allow = [System.Security.AccessControl.AccessControlType]::Allow
  $CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $System = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
  $Administrators = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
  foreach ($Identity in @($CurrentUser, $System, $Administrators)) {
    $Acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($Identity, $Rights, $Allow))
  }
  Set-Acl -LiteralPath $Path -AclObject $Acl
}

function Invoke-DirectRequest {
  param([string]$Uri)
  Add-Type -AssemblyName System.Net.Http
  $Handler = [System.Net.Http.HttpClientHandler]::new()
  $Handler.UseProxy = $false
  $Client = [System.Net.Http.HttpClient]::new($Handler)
  $Client.Timeout = [TimeSpan]::FromSeconds(5)
  try {
    return $Client.GetAsync($Uri).GetAwaiter().GetResult()
  } finally {
    $Client.Dispose()
    $Handler.Dispose()
  }
}

$ConfigText = Get-Content -LiteralPath $ConfigPath -Raw
if ($ConfigText -match 'REPLACE_WITH_FRP_(?:USER|PASSWORD)') {
  throw "FRP local configuration still contains a credential placeholder."
}
if ($ConfigText -notmatch '(?m)^localIP\s*=\s*"127\.0\.0\.1"\s*$' -or
    $ConfigText -notmatch '(?m)^localPort\s*=\s*4873\s*$') {
  throw "FRP local configuration must publish only 127.0.0.1:4873."
}
if ($ConfigPath.StartsWith($RepoRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  $RelativeConfig = $ConfigPath.Substring($RepoRoot.Length + 1).Replace("\", "/")
  & git -C $RepoRoot check-ignore -q -- $RelativeConfig
  if ($LASTEXITCODE -ne 0) {
    throw "Repository-local FRP credential file is not ignored by Git: $RelativeConfig"
  }
}
Protect-SecretFile -Path $ConfigPath

if ([string]::IsNullOrWhiteSpace($FrpcExe)) {
  $FrpcExe = Join-Path $RepoRoot "target\tools\frp\0.71.0\expanded\frp_0.71.0_windows_amd64\frpc.exe"
}
if (-not (Test-Path -LiteralPath $FrpcExe -PathType Leaf)) {
  if (-not $Install) {
    throw "Missing frpc executable $FrpcExe. Run scripts/install-frp-client.ps1 or pass -Install."
  }
  $FrpcExe = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install-frp-client.ps1") | Select-Object -Last 1)
}
$FrpcExe = (Resolve-Path -LiteralPath $FrpcExe).Path

& $FrpcExe verify -c $ConfigPath
if ($LASTEXITCODE -ne 0) {
  throw "FRP client configuration validation failed."
}
if ($VerifyOnly) {
  Write-Host "FRP client configuration is valid and its local credential file has a restricted ACL."
  return
}

try {
  $Live = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4873/api/health/live" -TimeoutSec 3
  if ($Live.StatusCode -ne 200) { throw "unexpected status $($Live.StatusCode)" }
} catch {
  throw "The local inspection entrypoint is not live on 127.0.0.1:4873. FRP was not started. $($_.Exception.Message)"
}

$StdoutPath = Join-Path $RunRoot "frpc.stdout.log"
$StderrPath = Join-Path $RunRoot "frpc.stderr.log"
$StatePath = Join-Path $RunRoot "frpc-state.json"
if (Test-Path -LiteralPath $StatePath -PathType Leaf) {
  try {
    $ExistingState = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    $ExistingProcess = Get-Process -Id ([int]$ExistingState.pid) -ErrorAction SilentlyContinue
    if ($ExistingProcess -and $ExistingProcess.Path.Equals($FrpcExe, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "FRP client is already running with PID $($ExistingProcess.Id)."
    }
  } catch [System.Management.Automation.RuntimeException] {
    throw
  } catch {}
}

$Frpc = Start-Process `
  -FilePath $FrpcExe `
  -ArgumentList @("-c", "`"$ConfigPath`"") `
  -WorkingDirectory $RepoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $StdoutPath `
  -RedirectStandardError $StderrPath `
  -PassThru

$Ready = $false
$Deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
while ((Get-Date) -lt $Deadline) {
  if ($Frpc.HasExited) {
    $ErrorTail = @(Get-Content -LiteralPath $StderrPath -Tail 20 -ErrorAction SilentlyContinue)
    throw "FRP client exited before the proxy became ready. $($ErrorTail -join [Environment]::NewLine)"
  }
  $Logs = @(
    Get-Content -LiteralPath $StdoutPath -Raw -ErrorAction SilentlyContinue
    Get-Content -LiteralPath $StderrPath -Raw -ErrorAction SilentlyContinue
  ) -join [Environment]::NewLine
  if ($Logs -match 'login to server success' -and
      $Logs -match 'steel_inspection_server' -and
      $Logs -match 'start proxy success') {
    $Ready = $true
    break
  }
  Start-Sleep -Milliseconds 250
}
if (-not $Ready) {
  Stop-Process -Id $Frpc.Id -Force -ErrorAction SilentlyContinue
  throw "FRP client did not publish steel_inspection_server within $ReadyTimeoutSec seconds. Check the hosted FRP account and assigned proxy."
}

$PublicReady = $false
$PublicDeadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
while ((Get-Date) -lt $PublicDeadline) {
  try {
    $Response = Invoke-DirectRequest -Uri ($PublicUrl.TrimEnd("/") + "/api/health/live")
    try {
      if ([int]$Response.StatusCode -eq 200) {
        $PublicReady = $true
        break
      }
    } finally {
      $Response.Dispose()
    }
  } catch {}
  Start-Sleep -Milliseconds 500
}
if (-not $PublicReady) {
  Stop-Process -Id $Frpc.Id -Force -ErrorAction SilentlyContinue
  throw "FRP control connection succeeded, but the public health endpoint did not return HTTP 200: $PublicUrl"
}

$State = [ordered]@{
  schema = "steel.frp-client.state.v1"
  pid = $Frpc.Id
  executable = $FrpcExe
  config = $ConfigPath
  localPort = 4873
  publicUrl = $PublicUrl
  startedAt = (Get-Date).ToString("o")
}
$State | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding UTF8
Write-Host "FRP client ready: PID $($Frpc.Id); steel_inspection_server -> 127.0.0.1:4873"
Write-Host "Public endpoint verified: $PublicUrl"
if ($Detach) {
  return
}

try {
  Write-Host "Press Ctrl+C to stop the FRP client."
  $Frpc.WaitForExit()
} finally {
  if (-not $Frpc.HasExited) {
    Stop-Process -Id $Frpc.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
}
