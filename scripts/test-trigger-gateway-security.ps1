param(
  [string]$GatewayExe = "",
  [int]$TimeoutSec = 15,
  [string]$LogRoot = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($GatewayExe)) {
  $SourceExe = Join-Path $RepoRoot "target\trigger\debug\steel-trigger-gateway.exe"
  $RuntimeExe = Join-Path $PSScriptRoot "service\steel-trigger-gateway.exe"
  $TargetRuntimeExe = Join-Path $PSScriptRoot "trigger\steel-trigger-gateway.exe"
  $GatewayExe = @($SourceExe, $RuntimeExe, $TargetRuntimeExe) | Where-Object { Test-Path $_ -PathType Leaf } | Select-Object -First 1
}
if ([string]::IsNullOrWhiteSpace($GatewayExe) -or -not (Test-Path $GatewayExe -PathType Leaf)) {
  throw "Missing trigger gateway executable. Build it first or pass -GatewayExe."
}
$GatewayExe = (Resolve-Path $GatewayExe).Path
if ([string]::IsNullOrWhiteSpace($LogRoot)) {
  $LogRoot = Join-Path $RepoRoot "target\logs\trigger-gateway-security"
}
$RunId = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$RunRoot = Join-Path $LogRoot $RunId
New-Item -ItemType Directory -Force -Path $RunRoot | Out-Null

function Assert-Condition {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Get-FreeTcpPort {
  $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $Listener.Start()
  try { return ([System.Net.IPEndPoint]$Listener.LocalEndpoint).Port } finally { $Listener.Stop() }
}

function Get-FreeUdpPort {
  $Client = [System.Net.Sockets.UdpClient]::new(0)
  try { return ([System.Net.IPEndPoint]$Client.Client.LocalEndPoint).Port } finally { $Client.Dispose() }
}

function Get-TriggerSignature {
  param(
    [string]$Secret,
    [string]$Timestamp,
    [string]$Nonce,
    [string]$Transport,
    [string]$Body
  )
  $Message = "steel-trigger-v1`n$Timestamp`n$Nonce`n$Transport`n$Body"
  $Hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($Secret))
  try {
    return -join ($Hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($Message)) | ForEach-Object { $_.ToString("x2") })
  } finally {
    $Hmac.Dispose()
  }
}

function Invoke-HttpEvidence {
  param(
    [string]$Method,
    [string]$Uri,
    [string]$Body = "",
    [hashtable]$Headers = @{}
  )
  Add-Type -AssemblyName System.Net.Http
  $Handler = [Net.Http.HttpClientHandler]::new()
  $Handler.UseProxy = $false
  $Client = [Net.Http.HttpClient]::new($Handler)
  $Client.Timeout = [TimeSpan]::FromSeconds(5)
  $Request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method), $Uri)
  try {
    foreach ($Header in $Headers.GetEnumerator()) {
      $null = $Request.Headers.TryAddWithoutValidation([string]$Header.Key, [string]$Header.Value)
    }
    if ($Method -notin @("GET", "HEAD")) {
      $Request.Content = [Net.Http.StringContent]::new($Body, [Text.Encoding]::UTF8, "application/json")
    }
    $Response = $Client.SendAsync($Request).GetAwaiter().GetResult()
    try {
      $Content = $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      $ResponseHeaders = @{}
      foreach ($Header in $Response.Headers) { $ResponseHeaders[$Header.Key] = ($Header.Value -join ",") }
      foreach ($Header in $Response.Content.Headers) { $ResponseHeaders[$Header.Key] = ($Header.Value -join ",") }
      return [ordered]@{ statusCode = [int]$Response.StatusCode; headers = $ResponseHeaders; body = $Content; json = if ($Content) { $Content | ConvertFrom-Json } else { $null } }
    } finally { $Response.Dispose() }
  } finally {
    $Request.Dispose()
    $Client.Dispose()
    $Handler.Dispose()
  }
}

function Wait-HttpReady {
  param([string]$Uri, [System.Diagnostics.Process]$Process)
  $Deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    if ($Process.HasExited) { throw "Trigger gateway exited before becoming ready with code $($Process.ExitCode)." }
    try {
      $Response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2
      if ($Response.StatusCode -eq 200) { return }
    } catch {}
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $Deadline)
  throw "Trigger gateway did not become ready at $Uri."
}

function Send-TcpJsonLine {
  param([int]$Port, [string]$Line)
  $Client = [Net.Sockets.TcpClient]::new()
  try {
    $Client.Connect("127.0.0.1", $Port)
    $Stream = $Client.GetStream()
    $Writer = [IO.StreamWriter]::new($Stream, [Text.UTF8Encoding]::new($false), 1024, $true)
    $Writer.NewLine = "`n"
    $Reader = [IO.StreamReader]::new($Stream, [Text.UTF8Encoding]::new($false), $false, 1024, $true)
    try {
      $Writer.WriteLine($Line); $Writer.Flush()
      return $Reader.ReadLine() | ConvertFrom-Json
    } finally { $Reader.Dispose(); $Writer.Dispose(); $Stream.Dispose() }
  } finally { $Client.Dispose() }
}

function Send-UdpJson {
  param([int]$Port, [string]$Payload)
  $Client = [Net.Sockets.UdpClient]::new()
  $Client.Client.ReceiveTimeout = 5000
  try {
    $Bytes = [Text.Encoding]::UTF8.GetBytes($Payload)
    $null = $Client.Send($Bytes, $Bytes.Length, "127.0.0.1", $Port)
    $Peer = [Net.IPEndPoint]::new([Net.IPAddress]::Any, 0)
    return [Text.Encoding]::UTF8.GetString($Client.Receive([ref]$Peer)) | ConvertFrom-Json
  } finally { $Client.Dispose() }
}

$HttpPort = Get-FreeTcpPort
$TcpPort = Get-FreeTcpPort
$UdpPort = Get-FreeUdpPort
$OfflineServicePort = Get-FreeTcpPort
$Secret = "security-smoke-0123456789-ABCDEF!"
$OperatorToken = "operator-smoke-0123456789-ABCDEF!"
$Previous = @{}
foreach ($Name in @("STEEL_RUNTIME_PROFILE", "TRIGGER_GATEWAY_HOST", "TRIGGER_GATEWAY_PORT", "TRIGGER_TCP_PORT", "TRIGGER_UDP_PORT", "INSPECTION_SERVICE_ORIGIN", "TRIGGER_MODE", "TRIGGER_SHARED_SECRET", "TRIGGER_OPERATOR_TOKEN", "TRIGGER_SOURCE_ALLOWLIST", "TRIGGER_ALLOW_MODE_MUTATION")) {
  $Previous[$Name] = [Environment]::GetEnvironmentVariable($Name, "Process")
}
$Gateway = $null
$MissingSecret = $null
$TcpCollisionProcess = $null
$UdpCollisionProcess = $null
$TcpCollisionOwner = $null
$UdpCollisionOwner = $null
try {
  $env:STEEL_RUNTIME_PROFILE = "production"
  $env:TRIGGER_GATEWAY_HOST = "127.0.0.1"
  $env:TRIGGER_GATEWAY_PORT = [string]$HttpPort
  $env:TRIGGER_TCP_PORT = [string]$TcpPort
  $env:TRIGGER_UDP_PORT = [string]$UdpPort
  $env:INSPECTION_SERVICE_ORIGIN = "http://127.0.0.1:$OfflineServicePort"
  $env:TRIGGER_MODE = "manual"
  $env:TRIGGER_SOURCE_ALLOWLIST = "127.0.0.1"
  $env:TRIGGER_ALLOW_MODE_MUTATION = "0"
  $env:TRIGGER_OPERATOR_TOKEN = $OperatorToken
  Remove-Item Env:\TRIGGER_SHARED_SECRET -ErrorAction SilentlyContinue

  $MissingSecret = Start-Process -FilePath $GatewayExe -WindowStyle Hidden -RedirectStandardOutput (Join-Path $RunRoot "missing-secret.out.log") -RedirectStandardError (Join-Path $RunRoot "missing-secret.err.log") -PassThru
  Assert-Condition ($MissingSecret.WaitForExit(5000)) "Gateway did not fail closed when the production secret was missing."
  Assert-Condition ($MissingSecret.ExitCode -ne 0) "Gateway accepted a production start without TRIGGER_SHARED_SECRET."

  $env:TRIGGER_SHARED_SECRET = $Secret
  $TcpCollisionOwner = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $TcpPort)
  $TcpCollisionOwner.Start()
  $TcpCollisionProcess = Start-Process -FilePath $GatewayExe -WindowStyle Hidden -RedirectStandardOutput (Join-Path $RunRoot "tcp-collision.out.log") -RedirectStandardError (Join-Path $RunRoot "tcp-collision.err.log") -PassThru
  Assert-Condition ($TcpCollisionProcess.WaitForExit(5000)) "Gateway did not fail synchronously when its TCP trigger port was occupied."
  Assert-Condition ($TcpCollisionProcess.ExitCode -ne 0) "Gateway accepted an occupied TCP trigger port."
  $TcpCollisionOwner.Stop()
  $TcpCollisionOwner = $null

  $UdpCollisionOwner = [System.Net.Sockets.UdpClient]::new([System.Net.Sockets.AddressFamily]::InterNetwork)
  $UdpCollisionOwner.Client.ExclusiveAddressUse = $true
  $UdpCollisionOwner.Client.Bind([System.Net.IPEndPoint]::new([System.Net.IPAddress]::Loopback, $UdpPort))
  $UdpCollisionProcess = Start-Process -FilePath $GatewayExe -WindowStyle Hidden -RedirectStandardOutput (Join-Path $RunRoot "udp-collision.out.log") -RedirectStandardError (Join-Path $RunRoot "udp-collision.err.log") -PassThru
  Assert-Condition ($UdpCollisionProcess.WaitForExit(5000)) "Gateway did not fail synchronously when its UDP trigger port was occupied."
  Assert-Condition ($UdpCollisionProcess.ExitCode -ne 0) "Gateway accepted an occupied UDP trigger port."
  $UdpCollisionOwner.Dispose()
  $UdpCollisionOwner = $null

  $Gateway = Start-Process -FilePath $GatewayExe -WindowStyle Hidden -RedirectStandardOutput (Join-Path $RunRoot "gateway.out.log") -RedirectStandardError (Join-Path $RunRoot "gateway.err.log") -PassThru
  $Origin = "http://127.0.0.1:$HttpPort"
  Wait-HttpReady -Uri "$Origin/api/trigger/status" -Process $Gateway

  $Status = Invoke-HttpEvidence -Method GET -Uri "$Origin/api/trigger/status"
  Assert-Condition ($Status.json.gatewayReady -eq $true) "Gateway reported ready before every configured listener was bound."
  foreach ($Transport in @("http", "tcp", "udp")) {
    Assert-Condition ($Status.json.listeners.$Transport.enabled -eq $true) "Status did not report the configured $Transport listener."
    Assert-Condition ($Status.json.listeners.$Transport.bound -eq $true) "Status did not prove the $Transport listener was bound."
  }
  Assert-Condition ($Status.json.security.authenticationRequired -eq $true) "Status did not report required authentication."
  Assert-Condition ($Status.json.security.operatorAuthenticationRequired -eq $true) "Status did not report required operator authentication."
  Assert-Condition ($Status.json.security.modeMutationAllowed -eq $false) "Production mode mutation was not locked."
  Assert-Condition ($Status.body -notmatch [regex]::Escape("127.0.0.1")) "Status leaked an internal address."
  Assert-Condition ($Status.body -notmatch [regex]::Escape([string]$OfflineServicePort)) "Status leaked the inspection service port."
  Assert-Condition (-not $Status.headers["Access-Control-Allow-Origin"]) "Gateway emitted a CORS allow-origin header."

  $Body = ([ordered]@{ event = "steel-info"; materialId = "SECURITY-SMOKE"; requestId = "security-http-1" } | ConvertTo-Json -Compress)
  $Unsigned = Invoke-HttpEvidence -Method POST -Uri "$Origin/api/trigger/steel-info" -Body $Body
  Assert-Condition ($Unsigned.statusCode -eq 401 -and $Unsigned.json.error -eq "trigger_auth_required") "Unsigned HTTP trigger was not rejected: status=$($Unsigned.statusCode) body=$($Unsigned.body)"

  $Timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
  $Nonce = "security-http-nonce-0001"
  $Headers = @{
    "X-Trigger-Timestamp" = $Timestamp
    "X-Trigger-Nonce" = $Nonce
    "X-Trigger-Signature" = Get-TriggerSignature -Secret $Secret -Timestamp $Timestamp -Nonce $Nonce -Transport "http" -Body $Body
  }
  $Signed = Invoke-HttpEvidence -Method POST -Uri "$Origin/api/trigger/steel-info" -Body $Body -Headers $Headers
  Assert-Condition ($Signed.statusCode -eq 200 -and $Signed.json.code -eq 503) "Valid signed HTTP trigger did not reach the offline service boundary."
  $Replay = Invoke-HttpEvidence -Method POST -Uri "$Origin/api/trigger/steel-info" -Body $Body -Headers $Headers
  Assert-Condition ($Replay.statusCode -eq 409 -and $Replay.json.error -eq "trigger_replay_detected") "HTTP replay was not rejected."

  $Mode = Invoke-HttpEvidence -Method POST -Uri "$Origin/api/trigger/mode" -Body '{"mode":"manual"}'
  Assert-Condition ($Mode.statusCode -eq 423 -and $Mode.json.error -eq "trigger_mode_locked") "Production mode mutation was not locked."

  $ManualBody = ([ordered]@{ materialId = "SECURITY-SMOKE"; requestId = "security-operator-1" } | ConvertTo-Json -Compress)
  $ManualUnsigned = Invoke-HttpEvidence -Method POST -Uri "$Origin/api/trigger/manual/steel-info" -Body $ManualBody
  Assert-Condition ($ManualUnsigned.statusCode -eq 401 -and $ManualUnsigned.json.error -eq "trigger_operator_auth_required") "Manual operator route accepted a request without its separate credential."
  $ManualAuthorized = Invoke-HttpEvidence -Method POST -Uri "$Origin/api/trigger/manual/steel-info" -Body $ManualBody -Headers @{ "X-Trigger-Operator-Token" = $OperatorToken }
  Assert-Condition ($ManualAuthorized.statusCode -eq 200 -and $ManualAuthorized.json.code -eq 503) "Authorized manual operator route did not reach the offline service boundary."

  $TcpPayload = ([ordered]@{ event = "steel-in"; materialId = "SECURITY-SMOKE"; requestId = "security-tcp-1" } | ConvertTo-Json -Compress)
  $TcpTimestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
  $TcpNonce = "security-tcp-nonce-0001"
  $TcpEnvelope = [ordered]@{
    auth = [ordered]@{ timestamp = $TcpTimestamp; nonce = $TcpNonce; signature = Get-TriggerSignature -Secret $Secret -Timestamp $TcpTimestamp -Nonce $TcpNonce -Transport "tcp" -Body $TcpPayload }
    payload = $TcpPayload | ConvertFrom-Json
  } | ConvertTo-Json -Compress
  $TcpAccepted = Send-TcpJsonLine -Port $TcpPort -Line $TcpEnvelope
  Assert-Condition ($TcpAccepted.code -eq 503) "Valid signed TCP trigger did not reach the offline service boundary."
  $TcpReplay = Send-TcpJsonLine -Port $TcpPort -Line $TcpEnvelope
  Assert-Condition ($TcpReplay.code -eq 409 -and $TcpReplay.error -eq "trigger_replay_detected") "TCP replay was not rejected."

  $UdpPayload = ([ordered]@{ event = "steel-out"; materialId = "SECURITY-SMOKE"; requestId = "security-udp-1" } | ConvertTo-Json -Compress)
  $UdpTimestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
  $UdpNonce = "security-udp-nonce-0001"
  $UdpEnvelope = [ordered]@{
    auth = [ordered]@{ timestamp = $UdpTimestamp; nonce = $UdpNonce; signature = Get-TriggerSignature -Secret $Secret -Timestamp $UdpTimestamp -Nonce $UdpNonce -Transport "udp" -Body $UdpPayload }
    payload = $UdpPayload | ConvertFrom-Json
  } | ConvertTo-Json -Compress
  $UdpAccepted = Send-UdpJson -Port $UdpPort -Payload $UdpEnvelope
  Assert-Condition ($UdpAccepted.code -eq 503) "Valid signed UDP trigger did not reach the offline service boundary."
  $UdpReplay = Send-UdpJson -Port $UdpPort -Payload $UdpEnvelope
  Assert-Condition ($UdpReplay.code -eq 409 -and $UdpReplay.error -eq "trigger_replay_detected") "UDP replay was not rejected."

  $Report = [ordered]@{
    schema = "steel.trigger-gateway.security-smoke.v1"
    code = 0
    checkedAt = (Get-Date).ToString("o")
    missingSecretFailClosed = $true
    authentication = "HMAC-SHA256"
    canonicalVersion = "steel-trigger-v1"
    transports = @("http", "tcp", "udp")
    replayRejected = @{ http = $true; tcp = $true; udp = $true }
    sourceAllowlistConfigured = $true
    listenerBindingsVerified = @{ http = $true; tcp = $true; udp = $true }
    occupiedListenerPortsFailClosed = @{ tcp = $true; udp = $true }
    operatorCredentialSeparated = $true
    modeMutationLocked = $true
    wildcardCors = $false
    statusRedacted = $true
  }
  $ReportPath = Join-Path $RunRoot "trigger-security-report.json"
  $Report["reportPath"] = $ReportPath
  $Report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  $Report | ConvertTo-Json -Depth 8
} finally {
  if ($Gateway -and -not $Gateway.HasExited) { Stop-Process -Id $Gateway.Id -Force -ErrorAction SilentlyContinue }
  if ($MissingSecret -and -not $MissingSecret.HasExited) { Stop-Process -Id $MissingSecret.Id -Force -ErrorAction SilentlyContinue }
  if ($TcpCollisionProcess -and -not $TcpCollisionProcess.HasExited) { Stop-Process -Id $TcpCollisionProcess.Id -Force -ErrorAction SilentlyContinue }
  if ($UdpCollisionProcess -and -not $UdpCollisionProcess.HasExited) { Stop-Process -Id $UdpCollisionProcess.Id -Force -ErrorAction SilentlyContinue }
  if ($TcpCollisionOwner) { $TcpCollisionOwner.Stop() }
  if ($UdpCollisionOwner) { $UdpCollisionOwner.Dispose() }
  foreach ($Name in $Previous.Keys) {
    [Environment]::SetEnvironmentVariable($Name, $Previous[$Name], "Process")
  }
}
