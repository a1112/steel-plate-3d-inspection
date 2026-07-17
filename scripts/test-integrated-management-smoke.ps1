param(
  [int]$ServicePort = 4973,
  [int]$TriggerPort = 4981,
  [int]$ClientPort = 1494,
  [ValidateSet("debug", "release")]
  [string]$Profile = "debug",
  [string]$ConfigRoot = "",
  [string]$WorkRoot = "",
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
$RunId = Get-Date -Format "yyyyMMdd-HHmmss-fff"
if ([string]::IsNullOrWhiteSpace($WorkRoot)) {
  $WorkRoot = if ($SourceMode) {
    Join-Path $RepoRoot "target\logs\integrated-smoke"
  } else {
    Join-Path ([System.IO.Path]::GetTempPath()) "steel-runtime-package-smoke"
  }
}
$WorkRoot = [System.IO.Path]::GetFullPath($WorkRoot)
$LogDir = $WorkRoot
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$ReportDir = Join-Path $LogDir "reports"
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

$RunWorkDir = Join-Path $LogDir "runs\$RunId\work"
New-Item -ItemType Directory -Force -Path $RunWorkDir | Out-Null
if ([string]::IsNullOrWhiteSpace($ConfigRoot)) {
  $ConfigRoot = Join-Path $RunWorkDir "config\service"
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
  $WorkingDirectory = $RunWorkDir
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

function Wait-ProductionTask {
  param(
    [string]$TaskId,
    [string]$ExpectedKind
  )

  Assert-Condition (-not [string]::IsNullOrWhiteSpace($TaskId)) "Missing persisted task ID for $ExpectedKind."
  $Deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    $Response = Invoke-HttpJson -Method GET -Uri "$ServiceOrigin/api/production/tasks/detail?id=$([uri]::EscapeDataString($TaskId))"
    $Task = $Response.Json.task
    if ($Task.status -in @("succeeded", "failed", "cancelled", "interrupted", "blocked")) {
      Assert-Condition ($Task.kind -eq $ExpectedKind) "Task $TaskId kind mismatch: $($Task.kind)"
      Assert-Condition ($Task.status -eq "succeeded") "Task $TaskId ($ExpectedKind) ended as $($Task.status): $($Task.error)"
      return $Response
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $Deadline)

  throw "Production task $TaskId ($ExpectedKind) did not reach a terminal state within ${TimeoutSec}s."
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
$TriggerTcpPort = $TriggerPort + 1
$TriggerUdpPort = $TriggerPort + 2
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
        "-RuntimeProfile", "development",
        "-AlgorithmMode", "demo",
        "-TriggerOrigin", $TriggerOrigin,
        "-NoCaptureAutostart",
        "-ForceParameters"
      ) | Out-Null
    } else {
      Start-SmokeScript -Name "service" -ScriptPath (Join-Path $ScriptRoot "run-service-simulated.ps1") -Arguments @(
        "-Port", [string]$ServicePort,
        "-ConfigRoot", $ConfigRoot,
        "-TriggerOrigin", $TriggerOrigin,
        "-RuntimeProfile", "development",
        "-AlgorithmMode", "demo"
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
      "-TcpPort", [string]$TriggerTcpPort,
      "-UdpPort", [string]$TriggerUdpPort,
      "-InspectionServiceOrigin", $ServiceOrigin,
      "-Mode", "api",
      "-RuntimeProfile", "development",
      "-AllowModeMutation"
    )
    if ($SourceMode) {
      $TriggerArguments += @("-Profile", $Profile, "-ForceParameters")
    }
    Start-SmokeScript -Name "trigger-gateway" -ScriptPath (Join-Path $ScriptRoot "run-trigger-gateway.ps1") -Arguments $TriggerArguments | Out-Null
    $StartedPorts.Add($TriggerPort)
    $StartedPorts.Add($TriggerTcpPort)
    $StartedPorts.Add($TriggerUdpPort)
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
    expectedCameras = 8
    rounds = 1
    steelStateAware = $true
    requireSteelPresent = $true
    productionLayout = $true
    saveSdkDerived = $false
  } -AllowedStatusCodes @(409)
  Assert-Condition ($CaptureGuard.StatusCode -eq 409) "Production capture-once did not reject capture before steel-in."
  Assert-Condition ($CaptureGuard.Json.error -eq "steel_not_present" -or $CaptureGuard.Json.error -eq "steel_session_mismatch") "Production capture-once returned an unexpected guard error: $($CaptureGuard.Content)"

  $SteelInfoBody = $EventBody.Clone()
  $SteelInfoBody.requestId = "smoke-steel-info-$RunId"
  $SteelInfo = Invoke-HttpJson -Method POST -Uri "$TriggerOrigin/api/trigger/manual/steel-info" -Body $SteelInfoBody
  Assert-Condition ($SteelInfo.Json.code -eq 0) "Manual steel-info failed: $($SteelInfo.Content)"
  Assert-Condition ($SteelInfo.Json.target -eq "/api/production/tasks/steel-info") "Manual steel-info did not route to the durable production API."
  $SteelInfoTask = Wait-ProductionTask -TaskId ([string]$SteelInfo.Json.service.task.taskId) -ExpectedKind "steel-info"

  $SteelInBody = $EventBody.Clone()
  $SteelInBody.requestId = "smoke-steel-in-$RunId"
  $SteelIn = Invoke-HttpJson -Method POST -Uri "$TriggerOrigin/api/trigger/manual/steel-in" -Body $SteelInBody
  Assert-Condition ($SteelIn.Json.code -eq 0) "Manual steel-in failed: $($SteelIn.Content)"
  Assert-Condition ($SteelIn.Json.target -eq "/api/production/tasks/steel-in") "Manual steel-in did not route to the durable production API."
  $SteelInTask = Wait-ProductionTask -TaskId ([string]$SteelIn.Json.service.task.taskId) -ExpectedKind "steel-in"
  $SteelInResult = $SteelInTask.Json.task.result
  Assert-Condition ($SteelInResult.flow.recordWrittenBeforeCapture -eq $true) "Steel-in did not report record-before-capture."
  Assert-Condition ([string]::IsNullOrWhiteSpace([string]$SteelInTask.Json.task.sessionId) -eq $false) "Steel-in did not create a persisted session."

  $StatusDuring = Invoke-HttpJson -Method GET -Uri "$ServiceOrigin/api/production/status"
  Assert-Condition ($StatusDuring.Json.activeSession.materialId -eq $MaterialId) "Active production session mismatch after steel-in."

  $CaptureEnqueue = Invoke-HttpJson -Method POST -Uri "$ServiceOrigin/api/production/tasks" -Body @{
    kind = "capture-once"
    idempotencyKey = "smoke-capture-$RunId"
    maxAttempts = 1
    payload = @{
      requestId = "smoke-capture-$RunId"
      materialId = $MaterialId
      expectedCameras = 8
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
  } -AllowedStatusCodes @(202)
  $CaptureTask = Wait-ProductionTask -TaskId ([string]$CaptureEnqueue.Json.task.taskId) -ExpectedKind "capture-once"
  $CaptureOnce = $CaptureTask.Json.task.result
  Assert-Condition ($CaptureOnce.code -eq 0) "Persistent production capture-once failed."
  Assert-Condition ($CaptureOnce.provider.parallel -eq $true) "Production capture-once did not report parallel provider capture."
  Assert-Condition ($CaptureOnce.provider.workerCount -eq 8) "Production capture-once worker count was not exactly eight cameras."
  Assert-Condition ($CaptureOnce.provider.failures -eq 0) "Production capture-once provider reported failures."
  Assert-Condition ($CaptureOnce.provider.successes -eq 8) "Production capture-once did not report exactly eight successful cameras."
  Assert-Condition ($CaptureOnce.provider.completeFrames -eq 8) "Production capture-once did not produce exactly eight complete frames."
  Assert-Condition ($CaptureOnce.provider.metadataFrames -eq 8) "Production capture-once did not produce exactly eight metadata commits."
  Assert-Condition ($CaptureOnce.provider.saveSdkDerived -eq $false) "Production capture-once should keep sdk-derived disabled by default."
  Assert-Condition ($CaptureOnce.record.captureFileRows -eq 24) "Production capture summary did not record exactly three files for each of eight cameras."

  $SteelOutBody = $EventBody.Clone()
  $SteelOutBody.requestId = "smoke-steel-out-$RunId"
  $SteelOut = Invoke-HttpJson -Method POST -Uri "$TriggerOrigin/api/trigger/manual/steel-out" -Body $SteelOutBody
  Assert-Condition ($SteelOut.Json.code -eq 0) "Manual steel-out failed: $($SteelOut.Content)"
  Assert-Condition ($SteelOut.Json.target -eq "/api/production/tasks/steel-out") "Manual steel-out did not route to the durable production API."
  $SteelOutTask = Wait-ProductionTask -TaskId ([string]$SteelOut.Json.service.task.taskId) -ExpectedKind "steel-out"
  $PersistedSessionId = [string]$SteelInTask.Json.task.sessionId
  foreach ($PersistedTask in @($SteelInfoTask.Json.task, $SteelInTask.Json.task, $CaptureTask.Json.task, $SteelOutTask.Json.task)) {
    Assert-Condition ($PersistedTask.materialId -eq $MaterialId) "Durable task $($PersistedTask.kind) changed material identity."
    Assert-Condition ([string]$PersistedTask.sessionId -eq $PersistedSessionId) "Durable task $($PersistedTask.kind) changed session identity."
    Assert-Condition ([string]$PersistedTask.chainId -eq $PersistedSessionId) "Durable task $($PersistedTask.kind) changed production chain identity."
    Assert-Condition ([string]$PersistedTask.dependencyPolicy -eq "require-success") "Durable task $($PersistedTask.kind) did not use the fail-closed dependency policy."
  }
  Assert-Condition ([string]::IsNullOrWhiteSpace([string]$SteelInfoTask.Json.task.dependsOnTaskId)) "Steel-info should be the production chain root."
  Assert-Condition ([string]$SteelInTask.Json.task.dependsOnTaskId -eq [string]$SteelInfoTask.Json.task.taskId) "Steel-in did not depend on steel-info."
  Assert-Condition ([string]$CaptureTask.Json.task.dependsOnTaskId -eq [string]$SteelInTask.Json.task.taskId) "Capture-once did not depend on steel-in."
  Assert-Condition ([string]$SteelOutTask.Json.task.dependsOnTaskId -eq [string]$CaptureTask.Json.task.taskId) "Steel-out did not depend on capture-once."

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
      workRoot = $RunWorkDir
      database = $StatusAfter.Json.database
      network = $NetworkSummary
    }
    triggerGateway = @{
      origin = $TriggerOrigin
      manualGuard = $Guard.StatusCode
      mode = $ModeSet.Json.mode
      httpPort = $TriggerPort
      tcpPort = $TriggerTcpPort
      udpPort = $TriggerUdpPort
    }
    client = @{
      origin = if ($SkipClient) { $null } else { "$ClientOrigin/?app=terminal" }
      checked = -not $SkipClient
    }
    production = @{
      sessionId = $SteelInTask.Json.task.sessionId
      inspectionId = $SteelInResult.inspectionId
      latestStatus = $StatusAfter.Json.latestSession.status
      recordWrittenBeforeCapture = $SteelInResult.flow.recordWrittenBeforeCapture
      durableTasks = @{
        chainId = $PersistedSessionId
        steelInfo = $SteelInfoTask.Json.task.taskId
        steelIn = $SteelInTask.Json.task.taskId
        captureOnce = $CaptureTask.Json.task.taskId
        steelOut = $SteelOutTask.Json.task.taskId
        dependencyPolicy = "require-success"
        dependencyOrder = @("steel-info", "steel-in", "capture-once", "steel-out")
      }
      captureGuard = @{
        statusCode = $CaptureGuard.StatusCode
        error = $CaptureGuard.Json.error
      }
      captureOnce = @{
        code = $CaptureOnce.code
        provider = $CaptureOnce.provider.provider
        parallel = $CaptureOnce.provider.parallel
        workerCount = $CaptureOnce.provider.workerCount
        completeFrames = $CaptureOnce.provider.completeFrames
        metadataFrames = $CaptureOnce.provider.metadataFrames
        captureFileRows = $CaptureOnce.record.captureFileRows
        saveSdkDerived = $CaptureOnce.provider.saveSdkDerived
      }
    }
    logs = $LogDir
    keptRunning = [bool]$KeepRunning
    startedProcesses = @($StartedProcesses | ForEach-Object {
      [ordered]@{
        id = $_.Id
        processName = $_.ProcessName
        hasExited = $_.HasExited
      }
    })
    startedListeners = @($StartedPorts | Sort-Object -Unique)
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
      workRoot = $RunWorkDir
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

exit 0
