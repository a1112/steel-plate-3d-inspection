param(
  [ValidateSet("Prepare", "Resume")]
  [string]$Mode,
  [ValidateSet("ApplyCrash", "RollbackCrash")]
  [string]$Scenario = "ApplyCrash",
  [string]$ServiceOrigin = "http://127.0.0.1:4873",
  [string]$CaptureOrigin = "http://127.0.0.1:4317",
  [string]$PlanPath = "",
  [string]$StatePath = "",
  [string]$AdminToken = $env:STEEL_ADMIN_TOKEN,
  [string]$SafetyConfirmation = "",
  [switch]$SaveToDevice,
  [int]$ExpectedCameras = 8,
  [int]$Lines = 1000,
  [int]$TimeoutMs = 8000,
  [string]$ReportDir = ""
)

$ErrorActionPreference = "Stop"
if ($ExpectedCameras -ne 8) {
  throw "Formal calibration crash-recovery acceptance requires exactly eight cameras."
}
$DrillConfirmation = "RUN CONTROLLED CALIBRATION PROCESS CRASH RECOVERY"
$CrashArmConfirmation = "ALLOW CONTROLLED CAMERA CALIBRATION PROCESS CRASH"
$StartedAt = Get-Date
$Failures = [System.Collections.Generic.List[string]]::new()

function Join-OriginPath {
  param([string]$Origin, [string]$Path)
  return $Origin.TrimEnd("/") + "/" + $Path.TrimStart("/")
}

function Add-Failure {
  param([string]$Message)
  $Failures.Add($Message)
}

function Test-Condition {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { Add-Failure $Message }
}

function Invoke-JsonRequest {
  param(
    [ValidateSet("GET", "POST")]
    [string]$Method,
    [string]$Uri,
    [object]$Body = $null,
    [switch]$Authenticated,
    [int[]]$AllowedStatusCodes = @(200),
    [int]$RequestTimeoutSec = 120
  )

  $Headers = @{ Accept = "application/json" }
  if ($Authenticated) {
    if ([string]::IsNullOrWhiteSpace($AdminToken)) {
      throw "AdminToken or STEEL_ADMIN_TOKEN is required."
    }
    $Headers.Authorization = "Bearer $AdminToken"
  }
  try {
    if ($Method -eq "GET") {
      $Response = Invoke-WebRequest -Method Get -Uri $Uri -Headers $Headers -UseBasicParsing -TimeoutSec $RequestTimeoutSec
    } else {
      $Text = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Compress -Depth 30 }
      $Response = Invoke-WebRequest -Method Post -Uri $Uri -Headers $Headers -UseBasicParsing -ContentType "application/json; charset=utf-8" -Body $Text -TimeoutSec $RequestTimeoutSec
    }
    $StatusCode = [int]$Response.StatusCode
    $Content = [string]$Response.Content
  } catch {
    $WebResponse = $_.Exception.Response
    if ($null -eq $WebResponse) { throw }
    $StatusCode = [int]$WebResponse.StatusCode
    $Reader = [IO.StreamReader]::new($WebResponse.GetResponseStream())
    try { $Content = $Reader.ReadToEnd() } finally { $Reader.Dispose() }
  }
  $Json = if ([string]::IsNullOrWhiteSpace($Content)) { $null } else { $Content | ConvertFrom-Json }
  if ($AllowedStatusCodes -notcontains $StatusCode) {
    throw "Unexpected HTTP $StatusCode from $Uri`: $Content"
  }
  return [pscustomobject]@{ statusCode = $StatusCode; json = $Json; content = $Content }
}

function Invoke-ServiceJson {
  param(
    [ValidateSet("GET", "POST")][string]$Method,
    [string]$Path,
    [object]$Body = $null,
    [int[]]$AllowedStatusCodes = @(200),
    [int]$RequestTimeoutSec = 120
  )
  return Invoke-JsonRequest -Method $Method -Uri (Join-OriginPath $ServiceOrigin $Path) -Body $Body -Authenticated -AllowedStatusCodes $AllowedStatusCodes -RequestTimeoutSec $RequestTimeoutSec
}

function Get-ReportRoot {
  if (-not [string]::IsNullOrWhiteSpace($ReportDir)) { return [IO.Path]::GetFullPath($ReportDir) }
  if (Test-Path (Join-Path $PSScriptRoot "manifest.json") -PathType Leaf) {
    return Join-Path $PSScriptRoot "logs\real-calibration-crash-recovery"
  }
  return Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "target\logs\real-calibration-crash-recovery"
}

function Write-JsonFileDurable {
  param([string]$Path, [object]$Value)
  $Directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  $Temporary = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
  try {
    $Value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $Temporary -Encoding UTF8
    Move-Item -LiteralPath $Temporary -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $Temporary) { Remove-Item -LiteralPath $Temporary -Force }
  }
}

function Read-JsonFileUtf8 {
  param([string]$Path)
  return [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Path).Path, [Text.Encoding]::UTF8) | ConvertFrom-Json
}

function New-OperationId {
  param([string]$Kind)
  return "hardware-crash-$Kind-" + (Get-Date -Format "yyyyMMdd-HHmmss-fff")
}

function Get-OperationDetail {
  param([string]$OperationId)
  return Invoke-ServiceJson -Method GET -Path ("/api/calibration/operations/detail?id=" + [uri]::EscapeDataString($OperationId))
}

function Wait-OperationStatus {
  param([string]$OperationId, [string[]]$Statuses, [int]$TimeoutSec = 20)
  $Deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    try {
      $Detail = Get-OperationDetail $OperationId
      if ($Statuses -contains [string]$Detail.json.status) { return $Detail }
    } catch {
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $Deadline)
  throw "Operation $OperationId did not reach status $($Statuses -join ',') within $TimeoutSec seconds."
}

function New-ApplyBody {
  param([object]$Plan, [string]$OperationId)
  $Body = [ordered]@{
    operationId = $OperationId
    name = [string]$Plan.name
    version = [string]$Plan.version
    path = [string]$Plan.path
    ips = @($Plan.ips)
    expectedCameras = $ExpectedCameras
    cameraCalibrations = @($Plan.cameraCalibrations)
    dryRun = $false
    stopStreams = $true
    atomic = $true
    rollbackOnFailure = $true
    requireAllMapped = $true
    persistActive = $true
    saveCameraParams = $false
    saveToDevice = [bool]$SaveToDevice
    allowBestEffortDeviceRollback = $false
    confirmation = "APPLY CAMERA CALIBRATION SET"
  }
  if ($SaveToDevice) { $Body.deviceConfirmation = "PERSIST CAMERA PARAMETERS" }
  return $Body
}

function Assert-CrashArm {
  param([object]$Health, [string]$ScenarioName)
  Test-Condition ($Health.calibrationCrashFailpointArmed -eq $true) "Capture crash failpoint is not armed."
  Test-Condition (-not [string]::IsNullOrWhiteSpace([string]$Health.calibrationCrashOperationId)) "Crash failpoint operationId is empty."
  Test-Condition ([int]$Health.calibrationCrashCameraIndex -ge 1 -and [int]$Health.calibrationCrashCameraIndex -le $ExpectedCameras) "Crash camera index is outside the eight-camera range."
  $AllowedPhases = if ($ScenarioName -eq "ApplyCrash") {
    @("apply-before-sdk", "apply-after-sdk")
  } else {
    @("rollback-before-camera", "rollback-after-camera")
  }
  Test-Condition ($AllowedPhases -contains [string]$Health.calibrationCrashPhase) "Crash phase '$($Health.calibrationCrashPhase)' does not match scenario $ScenarioName."
}

$ReportRoot = Get-ReportRoot
New-Item -ItemType Directory -Force -Path $ReportRoot | Out-Null
if ([string]::IsNullOrWhiteSpace($StatePath)) {
  $StatePath = Join-Path $ReportRoot "active-calibration-crash-drill.json"
} else {
  $StatePath = [IO.Path]::GetFullPath($StatePath)
}
$ReportPath = Join-Path $ReportRoot ("real-calibration-crash-recovery-{0}-{1}.json" -f $Mode.ToLowerInvariant(), (Get-Date -Format "yyyyMMdd-HHmmss-fff"))
$Evidence = [ordered]@{}

if ($SafetyConfirmation -cne $DrillConfirmation) {
  Add-Failure "Controlled crash drill requires -SafetyConfirmation '$DrillConfirmation'."
}

try {
  if ($Mode -eq "Prepare" -and $Failures.Count -eq 0) {
    if ([string]::IsNullOrWhiteSpace($PlanPath)) { throw "PlanPath is required in Prepare mode." }
    $ResolvedPlanPath = (Resolve-Path -LiteralPath $PlanPath).Path
    $Plan = Read-JsonFileUtf8 $ResolvedPlanPath
    Test-Condition (@($Plan.ips).Count -eq $ExpectedCameras) "Crash drill plan must contain exactly eight IPs."

    $Health = (Invoke-JsonRequest -Method GET -Uri (Join-OriginPath $CaptureOrigin "/health")).json
    Assert-CrashArm -Health $Health -ScenarioName $Scenario
    $ApplyOperationId = [string]$Health.calibrationCrashOperationId
    $CrashPhase = [string]$Health.calibrationCrashPhase
    $CrashCameraIndex = [int]$Health.calibrationCrashCameraIndex
    $Evidence.arm = $Health

    if ($Failures.Count -eq 0) {
      $DryRunScript = Join-Path $PSScriptRoot "test-real-calibration-acceptance.ps1"
      $DryRunOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $DryRunScript -ServiceOrigin $ServiceOrigin -PlanPath $ResolvedPlanPath -AdminToken $AdminToken -ExpectedCameras $ExpectedCameras 2>&1
      if ($LASTEXITCODE -ne 0) { throw "Calibration dry-run precondition failed: $($DryRunOutput -join [Environment]::NewLine)" }
      $DryRunText = ($DryRunOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
      $Evidence.dryRun = $DryRunText.Substring($DryRunText.IndexOf("{")) | ConvertFrom-Json

      if ($Scenario -eq "ApplyCrash") {
        $Apply = Invoke-ServiceJson -Method POST -Path "/api/calibration/apply-all" -Body (New-ApplyBody -Plan $Plan -OperationId $ApplyOperationId) -AllowedStatusCodes @(409, 500, 502, 503, 504) -RequestTimeoutSec 180
        $Evidence.crashDispatch = $Apply.json
        $UnresolvedOperationId = $ApplyOperationId
        $RollbackToken = ""
      } else {
        $Apply = Invoke-ServiceJson -Method POST -Path "/api/calibration/apply-all" -Body (New-ApplyBody -Plan $Plan -OperationId $ApplyOperationId) -AllowedStatusCodes @(200) -RequestTimeoutSec 300
        Test-Condition ($Apply.json.code -eq 0 -and [int]$Apply.json.applied -eq $ExpectedCameras) "Pre-rollback apply did not succeed on all cameras."
        $RollbackToken = [string]$Apply.json.rollbackToken
        Test-Condition (-not [string]::IsNullOrWhiteSpace($RollbackToken)) "Pre-rollback apply did not return a token."
        $CrashRollbackOperationId = New-OperationId "rollback"
        $CrashRollback = Invoke-ServiceJson -Method POST -Path "/api/calibration/rollback" -Body ([ordered]@{
          operationId = $CrashRollbackOperationId
          applyOperationId = $ApplyOperationId
          rollbackToken = $RollbackToken
          stopStreams = $true
          confirmation = "ROLLBACK CAMERA CALIBRATION"
        }) -AllowedStatusCodes @(409, 500, 502, 503, 504) -RequestTimeoutSec 180
        $Evidence.apply = $Apply.json
        $Evidence.crashDispatch = $CrashRollback.json
        $UnresolvedOperationId = $CrashRollbackOperationId
      }

      $Unresolved = Wait-OperationStatus -OperationId $UnresolvedOperationId -Statuses @("needs-reconciliation")
      $Evidence.unresolvedLedger = $Unresolved.json
      Test-Condition ([string]$Unresolved.json.status -eq "needs-reconciliation") "Crash operation was not persisted as needs-reconciliation."

      $State = [ordered]@{
        schema = "steel.real-calibration.crash-recovery-state.v1"
        preparedAt = (Get-Date).ToString("o")
        scenario = $Scenario
        planPath = $ResolvedPlanPath
        serviceOrigin = $ServiceOrigin
        captureOrigin = $CaptureOrigin
        expectedCameras = $ExpectedCameras
        saveToDevice = [bool]$SaveToDevice
        applyOperationId = $ApplyOperationId
        unresolvedOperationId = $UnresolvedOperationId
        rollbackToken = $RollbackToken
        crashPhase = $CrashPhase
        crashCameraIndex = $CrashCameraIndex
      }
      Write-JsonFileDurable -Path $StatePath -Value $State
      $Evidence.state = $State
    }
  }

  if ($Mode -eq "Resume" -and $Failures.Count -eq 0) {
    $State = Read-JsonFileUtf8 $StatePath
    if ([string]$State.schema -ne "steel.real-calibration.crash-recovery-state.v1") { throw "Unexpected crash drill state schema." }
    $Plan = Read-JsonFileUtf8 ([string]$State.planPath)
    $ApplyOperationId = [string]$State.applyOperationId
    $UnresolvedOperationId = [string]$State.unresolvedOperationId
    $ExpectedCameras = [int]$State.expectedCameras
    $HealthBefore = (Invoke-JsonRequest -Method GET -Uri (Join-OriginPath $CaptureOrigin "/health") -AllowedStatusCodes @(200)).json
    $Evidence.healthBeforeRecovery = $HealthBefore
    Test-Condition ($HealthBefore.calibrationCrashFailpointArmed -ne $true) "Restart provider with all CAPTURE_CALIBRATION_CRASH_* variables cleared before Resume."
    Test-Condition ($HealthBefore.recoveryRequired -eq $true) "Restarted provider did not close readiness with recoveryRequired."
    Test-Condition ($HealthBefore.invalidManifest -ne $true) "Rollback manifest is invalid; automated recovery is prohibited."
    Test-Condition ([int]$HealthBefore.pendingRecoveryCount -ge 1) "Restarted provider did not report a pending recovery manifest."

    if ($Failures.Count -eq 0) {
      $Connect = Invoke-ServiceJson -Method POST -Path "/api/cameras/connect-all" -Body @{ expectedCameras = $ExpectedCameras; devType = -1 } -RequestTimeoutSec 120
      $Evidence.connect = $Connect.json
      Test-Condition ($Connect.json.code -eq 0) "Camera reconnect failed during recovery."

      $Statuses = @()
      foreach ($Ip in @($Plan.ips)) {
        $Status = Invoke-ServiceJson -Method GET -Path ("/api/calibration/status?ip=" + [uri]::EscapeDataString([string]$Ip))
        $Statuses += $Status.json
      }
      $Evidence.calibrationStatuses = $Statuses
      $Tokens = @($Statuses | ForEach-Object { [string]$_.rollbackToken } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
      $RollbackToken = if (-not [string]::IsNullOrWhiteSpace([string]$State.rollbackToken)) { [string]$State.rollbackToken } elseif ($Tokens.Count -eq 1) { $Tokens[0] } else { "" }
      Test-Condition (-not [string]::IsNullOrWhiteSpace($RollbackToken)) "Could not recover one rollback token from restarted camera status."
      Test-Condition (@($Statuses | Where-Object { [string]$_.operationId -eq $ApplyOperationId }).Count -eq $ExpectedCameras) "Restarted camera status did not bind all cameras to the original apply operation."

      $FenceProbe = Invoke-ServiceJson -Method POST -Path "/api/calibration/active" -Body @{} -AllowedStatusCodes @(423)
      $Evidence.fenceProbe = $FenceProbe.json
      Test-Condition ($FenceProbe.json.error -eq "calibration_reconciliation_required") "Rust did not return the persistent calibration reconciliation fence."
      Test-Condition ([string]$FenceProbe.json.unresolvedOperations[0].operationId -eq $UnresolvedOperationId) "Rust fence does not identify the interrupted operation."
      Test-Condition ([string]$FenceProbe.json.unresolvedOperations[0].expectedApplyOperationId -eq $ApplyOperationId) "Rust fence lost the original apply correlation."

      $RecoveryOperationId = New-OperationId "recovery"
      $Recovery = Invoke-ServiceJson -Method POST -Path "/api/calibration/rollback" -Body ([ordered]@{
        operationId = $RecoveryOperationId
        parentOperationId = $UnresolvedOperationId
        applyOperationId = $ApplyOperationId
        rollbackToken = $RollbackToken
        stopStreams = $true
        confirmation = "ROLLBACK CAMERA CALIBRATION"
      }) -RequestTimeoutSec 300
      $Evidence.recovery = $Recovery.json
      Test-Condition ($Recovery.json.code -eq 0 -and $Recovery.json.complete -eq $true) "Parent-bound staged rollback did not complete."
      Test-Condition ([string]$Recovery.json.applyOperationId -eq $ApplyOperationId) "Provider recovery returned a different applyOperationId."

      $Parent = Wait-OperationStatus -OperationId $UnresolvedOperationId -Statuses @("reconciled")
      $Evidence.reconciledParent = $Parent.json
      Test-Condition ([string]$Parent.json.reconciliationId -eq $RecoveryOperationId) "Unresolved row was not reconciled by the recovery operation."

      $HealthAfter = Invoke-ServiceJson -Method GET -Path "/api/health/details"
      $Evidence.healthAfterRecovery = $HealthAfter.json
      Test-Condition ($HealthAfter.json.checks.calibrationReconciliation.healthy -eq $true) "Rust reconciliation readiness did not reopen."
      Test-Condition ($HealthAfter.json.checks.capture.recoveryRequired -ne $true) "Capture provider still reports recoveryRequired."

      $Validation = Invoke-ServiceJson -Method POST -Path "/api/capture/continuous-test" -Body ([ordered]@{
        materialId = "CALIBRATION-CRASH-RECOVERY-" + (Get-Date -Format "yyyyMMdd-HHmmss")
        ips = @($Plan.ips)
        expectedCameras = $ExpectedCameras
        rounds = 1
        lines = $Lines
        timeoutMs = $TimeoutMs
        intervalMs = 0
        retries = 0
        dataMode = 3
        stopStreams = $true
        productionLayout = $false
        saveSdkDerived = $false
        discardBlackFrames = $false
      }) -RequestTimeoutSec 180
      $Evidence.validationCapture = $Validation.json
      Test-Condition ($Validation.json.code -eq 0 -and [int]$Validation.json.completeFrames -eq $ExpectedCameras -and [int]$Validation.json.metadataFrames -eq $ExpectedCameras) "Post-recovery eight-camera validation capture was incomplete."
    }
  }
} catch {
  Add-Failure $_.Exception.Message
}

$Report = [ordered]@{
  schema = "steel.real-calibration.crash-recovery.v1"
  code = if ($Failures.Count -eq 0) { 0 } else { 1 }
  checkedAt = (Get-Date).ToString("o")
  elapsedSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 3)
  mode = $Mode
  scenario = $Scenario
  statePath = $StatePath
  crashArmConfirmation = $CrashArmConfirmation
  evidence = $Evidence
  failures = @($Failures)
  reportPath = $ReportPath
}
$Report | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
$Report | ConvertTo-Json -Depth 30
if ($Failures.Count -gt 0) { exit 1 }
