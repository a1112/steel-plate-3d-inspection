param(
  [int]$ServicePort = 4973,
  [int]$TriggerPort = 4981,
  [int]$ClientPort = 1494,
  [ValidateSet("debug", "release")]
  [string]$Profile = "debug",
  [string]$ConfigRoot = "",
  [switch]$SkipClient,
  [switch]$KeepRunning,
  [int]$TimeoutSec = 30
)

$ErrorActionPreference = "Stop"
$ScriptRoot = (Resolve-Path $PSScriptRoot).Path
$SourceMode = Test-Path (Join-Path $ScriptRoot "run-service.ps1") -PathType Leaf
$RepoRoot = if ($SourceMode) {
  (Resolve-Path (Join-Path $ScriptRoot "..")).Path
} else {
  $ScriptRoot
}
$LogDir = if ($SourceMode) {
  Join-Path $RepoRoot "target\logs\integrated-smoke"
} else {
  Join-Path $RepoRoot "logs\integrated-smoke"
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$ReportDir = Join-Path $LogDir "reports"
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

$RunId = Get-Date -Format "yyyyMMdd-HHmmss-fff"
if ([string]::IsNullOrWhiteSpace($ConfigRoot)) {
  $ConfigRoot = Join-Path $LogDir "runs\$RunId\config\service"
}
New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null

$StartedProcesses = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$StartedPorts = New-Object System.Collections.Generic.List[int]

function Write-SmokeReport {
  param(
    [System.Collections.IDictionary]$Report,
    [string]$Name = "integrated-smoke"
  )

  New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
  $ReportPath = Join-Path $ReportDir ("{0}-{1}.json" -f $Name, $RunId)
  $Report["reportPath"] = $ReportPath
  $Report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  return $ReportPath
}

function Assert-Condition {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Test-JsonProperty {
  param(
    [object]$Object,
    [string]$Name
  )
  return $null -ne $Object -and ($Object.PSObject.Properties.Name -contains $Name)
}

function Get-NetworkRateSummary {
  param([object]$NetworkJson)

  Assert-Condition ($NetworkJson.code -eq 0) "Rust service network monitor failed."
  $Interfaces = @($NetworkJson.interfaces)
  Assert-Condition ($Interfaces.Count -gt 0) "Rust service network monitor did not report any interfaces."
  foreach ($RequiredProperty in @("totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps")) {
    Assert-Condition (Test-JsonProperty $NetworkJson $RequiredProperty) "Rust service network monitor missing $RequiredProperty."
  }
  $FirstInterface = $Interfaces[0]
  foreach ($RequiredProperty in @("uploadMbps", "downloadMbps", "bandwidthMbps", "online")) {
    Assert-Condition (Test-JsonProperty $FirstInterface $RequiredProperty) "Rust service network monitor interface missing $RequiredProperty."
  }

  return [ordered]@{
    code = $NetworkJson.code
    source = $NetworkJson.source
    interfaces = $Interfaces.Count
    sampledAtMs = $NetworkJson.sampledAtMs
    totalUploadMbps = [double]$NetworkJson.totalUploadMbps
    totalDownloadMbps = [double]$NetworkJson.totalDownloadMbps
    totalBandwidthMbps = [double]$NetworkJson.totalBandwidthMbps
    rateFields = $true
  }
}

function Test-LocalTcpPort {
  param([int]$Port)

  try {
    $Client = [System.Net.Sockets.TcpClient]::new()
    try {
      $Async = $Client.BeginConnect("127.0.0.1", $Port, $null, $null)
      if (-not $Async.AsyncWaitHandle.WaitOne(500)) {
        return $false
      }
      $Client.EndConnect($Async)
      return $true
    } finally {
      $Client.Dispose()
    }
  } catch {
    return $false
  }
}

function Normalize-ProcessPathEnvironment {
  $PathValue = [Environment]::GetEnvironmentVariable("Path", "Process")
  if ([string]::IsNullOrEmpty($PathValue)) {
    $PathValue = [Environment]::GetEnvironmentVariable("PATH", "Process")
  }
  [Environment]::SetEnvironmentVariable("PATH", $null, "Process")
  if (-not [string]::IsNullOrEmpty($PathValue)) {
    [Environment]::SetEnvironmentVariable("Path", $PathValue, "Process")
  }
}

function Start-SmokeScript {
  param(
    [string]$Name,
    [string]$ScriptPath,
    [string[]]$Arguments
  )

  Assert-Condition (Test-Path $ScriptPath -PathType Leaf) "Missing script: $ScriptPath"
  $OutLog = Join-Path $LogDir "$Name.out.log"
  $ErrLog = Join-Path $LogDir "$Name.err.log"
  Remove-Item $OutLog, $ErrLog -ErrorAction SilentlyContinue
  $ArgList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath) + $Arguments
  Normalize-ProcessPathEnvironment
  $WorkingDirectory = if ($SourceMode) { $RepoRoot } else { $ScriptRoot }
  $Process = Start-Process -FilePath "powershell.exe" `
    -ArgumentList $ArgList `
    -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -PassThru
  $StartedProcesses.Add($Process)
  Write-Host "$Name started: PID $($Process.Id), logs $OutLog"
  return $Process
}

function Stop-SmokeListenerOnPort {
  param([int]$Port)

  $OwningPids = @()
  try {
    $OwningPids = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  } catch {
    $OwningPids = @()
  }

  if (-not $OwningPids -or $OwningPids.Count -eq 0) {
    $Lines = netstat -ano | Select-String ":$Port\s"
    foreach ($Line in $Lines) {
      if ([string]$Line -match "LISTENING\s+(\d+)") {
        $OwningPids += [int]$Matches[1]
      }
    }
  }

  foreach ($OwningPid in ($OwningPids | Sort-Object -Unique)) {
    if ($OwningPid -gt 0) {
      Stop-Process -Id $OwningPid -Force -ErrorAction SilentlyContinue
    }
  }
}

function Convert-JsonBody {
  param([string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return $null
  }
  return $Text | ConvertFrom-Json
}

function Invoke-HttpJson {
  param(
    [ValidateSet("GET", "POST")]
    [string]$Method,
    [string]$Uri,
    [object]$Body = $null,
    [int[]]$AllowedStatusCodes = @(200)
  )

  $JsonBody = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Compress -Depth 20 }
  try {
    if ($Method -eq "GET") {
      $Response = Invoke-WebRequest -Method Get -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSec
    } else {
      $Response = Invoke-WebRequest -Method Post -Uri $Uri -UseBasicParsing -ContentType "application/json" -Body $JsonBody -TimeoutSec $TimeoutSec
    }
    $StatusCode = [int]$Response.StatusCode
    $Content = [string]$Response.Content
  } catch {
    $WebResponse = $_.Exception.Response
    if ($null -eq $WebResponse) {
      throw
    }
    $StatusCode = [int]$WebResponse.StatusCode
    $Reader = [System.IO.StreamReader]::new($WebResponse.GetResponseStream())
    try {
      $Content = $Reader.ReadToEnd()
    } finally {
      $Reader.Dispose()
    }
    if ([string]::IsNullOrWhiteSpace($Content) -and $null -ne $_.ErrorDetails -and -not [string]::IsNullOrWhiteSpace([string]$_.ErrorDetails.Message)) {
      $Content = [string]$_.ErrorDetails.Message
    }
  }

  if ($AllowedStatusCodes -notcontains $StatusCode) {
    throw "Unexpected HTTP $StatusCode from $Uri`: $Content"
  }

  [pscustomobject]@{
    StatusCode = $StatusCode
    Json = Convert-JsonBody $Content
    Content = $Content
  }
}

function Wait-HttpJson {
  param([string]$Name, [string]$Uri)

  $Deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    try {
      return Invoke-HttpJson -Method GET -Uri $Uri
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $Deadline)

  throw "$Name did not become ready at $Uri within ${TimeoutSec}s."
}

function Test-StaticClient {
  param([string]$Uri)

  $Deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    try {
      $Response = Invoke-WebRequest -Method Get -Uri $Uri -UseBasicParsing -TimeoutSec 3
      if ($Response.StatusCode -eq 200 -and [string]$Response.Content -match "<html") {
        return
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $Deadline)

  throw "Static client did not serve index.html at $Uri"
}

$ServiceOrigin = "http://127.0.0.1:$ServicePort"
$TriggerOrigin = "http://127.0.0.1:$TriggerPort"
$ClientOrigin = "http://127.0.0.1:$ClientPort"
$MaterialId = "BAR-SMOKE-" + (Get-Date -Format "yyyyMMdd-HHmmss")
$StartedAt = Get-Date

try {
  if (-not (Test-LocalTcpPort -Port $ServicePort)) {
    if ($SourceMode) {
      Start-SmokeScript -Name "service" -ScriptPath (Join-Path $ScriptRoot "run-service.ps1") -Arguments @(
        "-Provider", "simulated",
        "-Port", [string]$ServicePort,
        "-Profile", $Profile,
        "-ConfigRoot", $ConfigRoot,
        "-NoCaptureAutostart",
        "-ForceParameters"
      ) | Out-Null
    } else {
      Start-SmokeScript -Name "service" -ScriptPath (Join-Path $ScriptRoot "run-service-simulated.ps1") -Arguments @(
        "-Port", [string]$ServicePort,
        "-ConfigRoot", $ConfigRoot
      ) | Out-Null
    }
    $StartedPorts.Add($ServicePort)
  } else {
    Write-Host "Rust service already listening on port $ServicePort."
  }

  $ServiceStatus = Wait-HttpJson -Name "Rust service" -Uri "$ServiceOrigin/api/production/status"
  Assert-Condition ($ServiceStatus.Json.code -eq 0) "Rust service production status failed."

  $NetworkStatus = Invoke-HttpJson -Method GET -Uri "$ServiceOrigin/api/system/network"
  $NetworkSummary = Get-NetworkRateSummary -NetworkJson $NetworkStatus.Json

  if (-not (Test-LocalTcpPort -Port $TriggerPort)) {
    $TriggerArguments = @(
      "-Port", [string]$TriggerPort,
      "-InspectionServiceOrigin", $ServiceOrigin,
      "-Mode", "api"
    )
    if ($SourceMode) {
      $TriggerArguments += @("-Profile", $Profile, "-ForceParameters")
    }
    Start-SmokeScript -Name "trigger-gateway" -ScriptPath (Join-Path $ScriptRoot "run-trigger-gateway.ps1") -Arguments $TriggerArguments | Out-Null
    $StartedPorts.Add($TriggerPort)
  } else {
    Write-Host "Trigger gateway already listening on port $TriggerPort."
  }

  $TriggerStatus = Wait-HttpJson -Name "Trigger gateway" -Uri "$TriggerOrigin/api/trigger/status"
  Assert-Condition ($TriggerStatus.Json.code -eq 0) "Trigger gateway status failed."
  if ($TriggerStatus.Json.mode -ne "api") {
    $TriggerStatus = Invoke-HttpJson -Method POST -Uri "$TriggerOrigin/api/trigger/mode" -Body @{ mode = "api" }
  }
  Assert-Condition ($TriggerStatus.Json.manualAllowed -eq $false) "Trigger gateway should be in API mode for guard verification."

  if (-not $SkipClient) {
    if (-not (Test-LocalTcpPort -Port $ClientPort)) {
      $ClientRoot = if ($SourceMode) {
        Join-Path $RepoRoot "target\client\frontend-dist"
      } else {
        Join-Path $RepoRoot "client"
      }
      Assert-Condition (Test-Path (Join-Path $ClientRoot "index.html") -PathType Leaf) "Missing built client. Run npm.cmd run build in app/client first."
      Start-SmokeScript -Name "client-static" -ScriptPath (Join-Path $ScriptRoot "run-client-static.ps1") -Arguments @(
        "-Port", [string]$ClientPort,
        "-ClientRoot", $ClientRoot
      ) | Out-Null
      $StartedPorts.Add($ClientPort)
    } else {
      Write-Host "Client static server already listening on port $ClientPort."
    }
    Test-StaticClient -Uri "$ClientOrigin/?app=terminal"
  }

  $EventBody = @{
    materialId = $MaterialId
    steelId = $MaterialId
    source = "integrated-smoke"
    mode = "manual"
    triggerMode = "manual"
    acquisitionMode = "manual"
    autoCapture = $false
    discardBlackFrames = $true
    saveSdkDerived = $false
    steelType = "round-bar"
    lengthMm = 12000
    widthMm = 3500
    thicknessMm = 12
  }

  $Guard = Invoke-HttpJson -Method POST -Uri "$TriggerOrigin/api/trigger/manual/steel-in" -Body $EventBody -AllowedStatusCodes @(409)
  Assert-Condition ($Guard.StatusCode -eq 409) "Manual guard did not reject steel-in outside manual mode."

  $ModeSet = Invoke-HttpJson -Method POST -Uri "$TriggerOrigin/api/trigger/mode" -Body @{ mode = "manual" }
  Assert-Condition ($ModeSet.Json.manualAllowed -eq $true) "Trigger gateway did not switch to manual mode."

  $CaptureGuard = Invoke-HttpJson -Method POST -Uri "$ServiceOrigin/api/production/capture-once" -Body @{
    materialId = $MaterialId
    expectedCameras = 6
    rounds = 1
    steelStateAware = $true
    requireSteelPresent = $true
    productionLayout = $true
    saveSdkDerived = $false
  } -AllowedStatusCodes @(409)
  Assert-Condition ($CaptureGuard.StatusCode -eq 409) "Production capture-once did not reject capture before steel-in."
  Assert-Condition ($CaptureGuard.Json.error -eq "steel_not_present" -or $CaptureGuard.Json.error -eq "steel_session_mismatch") "Production capture-once returned an unexpected guard error: $($CaptureGuard.Content)"

  $SteelInfo = Invoke-HttpJson -Method POST -Uri "$TriggerOrigin/api/trigger/manual/steel-info" -Body $EventBody
  Assert-Condition ($SteelInfo.Json.code -eq 0) "Manual steel-info failed: $($SteelInfo.Content)"
  Assert-Condition ($SteelInfo.Json.target -eq "/api/production/steel-info") "Manual steel-info did not route to production API."

  $SteelIn = Invoke-HttpJson -Method POST -Uri "$TriggerOrigin/api/trigger/manual/steel-in" -Body $EventBody
  Assert-Condition ($SteelIn.Json.code -eq 0) "Manual steel-in failed: $($SteelIn.Content)"
  Assert-Condition ($SteelIn.Json.target -eq "/api/production/steel-in") "Manual steel-in did not route to production API."
  Assert-Condition ($SteelIn.Json.service.flow.recordWrittenBeforeCapture -eq $true) "Steel-in did not report record-before-capture."
  Assert-Condition ([string]::IsNullOrWhiteSpace([string]$SteelIn.Json.service.sessionId) -eq $false) "Steel-in did not create a session."

  $StatusDuring = Invoke-HttpJson -Method GET -Uri "$ServiceOrigin/api/production/status"
  Assert-Condition ($StatusDuring.Json.activeSession.materialId -eq $MaterialId) "Active production session mismatch after steel-in."

  $CaptureOnce = Invoke-HttpJson -Method POST -Uri "$ServiceOrigin/api/production/capture-once" -Body @{
    materialId = $MaterialId
    expectedCameras = 6
    rounds = 1
    lines = 1000
    width = 0
    timeoutMs = 8000
    intervalMs = 0
    retries = 0
    controlMode = 0
    dataMode = 3
    connectFirst = $false
    stopStreams = $true
    steelStateAware = $true
    requireSteelPresent = $true
    productionLayout = $true
    saveSdkDerived = $false
    discardBlackFrames = $true
  }
  Assert-Condition ($CaptureOnce.Json.code -eq 0) "Production capture-once failed: $($CaptureOnce.Content)"
  Assert-Condition ($CaptureOnce.Json.provider.parallel -eq $true) "Production capture-once did not report parallel provider capture."
  Assert-Condition ($CaptureOnce.Json.provider.workerCount -ge 6) "Production capture-once worker count was below six cameras."
  Assert-Condition ($CaptureOnce.Json.provider.failures -eq 0) "Production capture-once provider reported failures."
  Assert-Condition ($CaptureOnce.Json.provider.completeFrames -ge 6) "Production capture-once did not produce six complete frames."
  Assert-Condition ($CaptureOnce.Json.provider.metadataFrames -ge 6) "Production capture-once did not produce six metadata frames."
  Assert-Condition ($CaptureOnce.Json.provider.saveSdkDerived -eq $false) "Production capture-once should keep sdk-derived disabled by default."
  Assert-Condition ($CaptureOnce.Json.record.captureFileRows -ge 18) "Production capture summary did not record depth/intensity/metadata files for six cameras."

  $SteelOut = Invoke-HttpJson -Method POST -Uri "$TriggerOrigin/api/trigger/manual/steel-out" -Body $EventBody
  Assert-Condition ($SteelOut.Json.code -eq 0) "Manual steel-out failed: $($SteelOut.Content)"
  Assert-Condition ($SteelOut.Json.target -eq "/api/production/steel-out") "Manual steel-out did not route to production API."

  $StatusAfter = Invoke-HttpJson -Method GET -Uri "$ServiceOrigin/api/production/status"
  Assert-Condition ($StatusAfter.Json.latestSession.materialId -eq $MaterialId) "Latest production session mismatch after steel-out."
  Assert-Condition ($StatusAfter.Json.latestSession.status -eq "finished") "Latest production session was not finished after steel-out."

  $Summary = [ordered]@{
    code = 0
    runId = $RunId
    checkedAt = (Get-Date).ToString("o")
    elapsedSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 3)
    materialId = $MaterialId
    service = @{
      origin = $ServiceOrigin
      configRoot = $ConfigRoot
      database = $StatusAfter.Json.database
      network = $NetworkSummary
    }
    triggerGateway = @{
      origin = $TriggerOrigin
      manualGuard = $Guard.StatusCode
      mode = $ModeSet.Json.mode
    }
    client = @{
      origin = if ($SkipClient) { $null } else { "$ClientOrigin/?app=terminal" }
      checked = -not $SkipClient
    }
    production = @{
      sessionId = $SteelIn.Json.service.sessionId
      inspectionId = $SteelIn.Json.service.inspectionId
      latestStatus = $StatusAfter.Json.latestSession.status
      recordWrittenBeforeCapture = $SteelIn.Json.service.flow.recordWrittenBeforeCapture
      captureGuard = @{
        statusCode = $CaptureGuard.StatusCode
        error = $CaptureGuard.Json.error
      }
      captureOnce = @{
        code = $CaptureOnce.Json.code
        provider = $CaptureOnce.Json.provider.provider
        parallel = $CaptureOnce.Json.provider.parallel
        workerCount = $CaptureOnce.Json.provider.workerCount
        completeFrames = $CaptureOnce.Json.provider.completeFrames
        metadataFrames = $CaptureOnce.Json.provider.metadataFrames
        captureFileRows = $CaptureOnce.Json.record.captureFileRows
        saveSdkDerived = $CaptureOnce.Json.provider.saveSdkDerived
      }
    }
    logs = $LogDir
    keptRunning = [bool]$KeepRunning
  }

  $null = Write-SmokeReport -Report $Summary
  $Summary | ConvertTo-Json -Depth 8
} catch {
  $Failure = [ordered]@{
    code = 1
    runId = $RunId
    checkedAt = (Get-Date).ToString("o")
    elapsedSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 3)
    materialId = $MaterialId
    error = $_.Exception.Message
    service = @{
      origin = $ServiceOrigin
      configRoot = $ConfigRoot
    }
    triggerGateway = @{
      origin = $TriggerOrigin
    }
    client = @{
      origin = if ($SkipClient) { $null } else { "$ClientOrigin/?app=terminal" }
      checked = -not $SkipClient
    }
    logs = $LogDir
    startedProcesses = @($StartedProcesses | ForEach-Object {
      [ordered]@{
        id = $_.Id
        processName = $_.ProcessName
        hasExited = $_.HasExited
      }
    })
  }
  $null = Write-SmokeReport -Report $Failure -Name "integrated-smoke-failed"
  $Failure | ConvertTo-Json -Depth 8
  exit 1
} finally {
  if (-not $KeepRunning) {
    foreach ($Process in $StartedProcesses) {
      if ($Process -and -not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
      }
    }
    Start-Sleep -Milliseconds 250
    foreach ($Port in $StartedPorts) {
      Stop-SmokeListenerOnPort -Port $Port
    }
  }
}
