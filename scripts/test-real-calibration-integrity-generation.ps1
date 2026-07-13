param(
  [string]$ServiceOrigin = "http://127.0.0.1:4873",
  [string]$CaptureOrigin = "http://127.0.0.1:4317",
  [Parameter(Mandatory = $true)]
  [string]$PlanPath,
  [string]$AdminToken = $env:STEEL_ADMIN_TOKEN,
  [string]$SafetyConfirmation = "",
  [int]$ExpectedCameras = 6,
  [int]$Lines = 1000,
  [int]$TimeoutMs = 8000,
  [string]$ReportDir = ""
)

$ErrorActionPreference = "Stop"
$DrillConfirmation = "RUN REAL CALIBRATION INTEGRITY AND GENERATION DRILL"
$StartedAt = Get-Date
$Failures = [Collections.Generic.List[string]]::new()
$Evidence = [ordered]@{}

function Join-OriginPath {
  param([string]$Origin, [string]$Path)
  return $Origin.TrimEnd("/") + "/" + $Path.TrimStart("/")
}

function Add-Failure { param([string]$Message) $Failures.Add($Message) }
function Test-Condition { param([bool]$Condition, [string]$Message) if (-not $Condition) { Add-Failure $Message } }

function Invoke-JsonRequest {
  param(
    [ValidateSet("GET", "POST")][string]$Method,
    [string]$Uri,
    [object]$Body = $null,
    [switch]$Authenticated,
    [int[]]$AllowedStatusCodes = @(200),
    [int]$RequestTimeoutSec = 180
  )
  $Headers = @{ Accept = "application/json" }
  if ($Authenticated) {
    if ([string]::IsNullOrWhiteSpace($AdminToken)) { throw "AdminToken or STEEL_ADMIN_TOKEN is required." }
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
  if ($AllowedStatusCodes -notcontains $StatusCode) { throw "Unexpected HTTP $StatusCode from $Uri`: $Content" }
  return [pscustomobject]@{ statusCode = $StatusCode; json = $Json; content = $Content }
}

function Invoke-ServiceJson {
  param(
    [ValidateSet("GET", "POST")][string]$Method,
    [string]$Path,
    [object]$Body = $null,
    [int[]]$AllowedStatusCodes = @(200),
    [int]$RequestTimeoutSec = 180
  )
  return Invoke-JsonRequest -Method $Method -Uri (Join-OriginPath $ServiceOrigin $Path) -Body $Body -Authenticated -AllowedStatusCodes $AllowedStatusCodes -RequestTimeoutSec $RequestTimeoutSec
}

function New-OperationId { param([string]$Kind) return "hardware-integrity-$Kind-" + (Get-Date -Format "yyyyMMdd-HHmmss-fff") }

function Get-ReportRoot {
  if (-not [string]::IsNullOrWhiteSpace($ReportDir)) { return [IO.Path]::GetFullPath($ReportDir) }
  if (Test-Path (Join-Path $PSScriptRoot "manifest.json") -PathType Leaf) { return Join-Path $PSScriptRoot "logs\real-calibration-integrity-generation" }
  return Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "target\logs\real-calibration-integrity-generation"
}

function Read-JsonFileUtf8 { param([string]$Path) return [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Path).Path, [Text.Encoding]::UTF8) | ConvertFrom-Json }

function New-ApplyBody {
  param([object]$Plan, [string]$OperationId)
  return [ordered]@{
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
    persistActive = $false
    saveCameraParams = $false
    saveToDevice = $false
    allowBestEffortDeviceRollback = $false
    confirmation = "APPLY CAMERA CALIBRATION SET"
  }
}

function Get-CalibrationStatuses {
  param([object[]]$Ips)
  return @($Ips | ForEach-Object {
    (Invoke-ServiceJson -Method GET -Path ("/api/calibration/status?ip=" + [uri]::EscapeDataString([string]$_))).json
  })
}

function Get-StatusFingerprint {
  param([object[]]$Statuses)
  return @($Statuses | ForEach-Object {
    [ordered]@{
      ip = [string]$_.ip
      calibrationPath = [string]$_.calibrationPath
      calibrationCode = $_.calibrationCode
      calibrationTime = [string]$_.calibrationTime
      operationId = [string]$_.operationId
      rollbackToken = [string]$_.rollbackToken
    }
  }) | ConvertTo-Json -Compress -Depth 5
}

function Get-OptionalFileHash {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$ReportRoot = Get-ReportRoot
New-Item -ItemType Directory -Force -Path $ReportRoot | Out-Null
$ReportPath = Join-Path $ReportRoot ("real-calibration-integrity-generation-{0}.json" -f (Get-Date -Format "yyyyMMdd-HHmmss-fff"))
$StagedPath = ""
$StagedBytes = $null
$StagedAttributes = $null

if ($SafetyConfirmation -cne $DrillConfirmation) { Add-Failure "Integrity/generation drill requires -SafetyConfirmation '$DrillConfirmation'." }

try {
  if ($Failures.Count -eq 0) {
    $ResolvedPlanPath = (Resolve-Path -LiteralPath $PlanPath).Path
    $Plan = Read-JsonFileUtf8 $ResolvedPlanPath
    Test-Condition (@($Plan.ips).Count -eq $ExpectedCameras -and @($Plan.cameraCalibrations).Count -eq $ExpectedCameras) "Plan must contain exactly six cameras."

    $DryRunScript = Join-Path $PSScriptRoot "test-real-calibration-acceptance.ps1"
    $DryRunOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $DryRunScript -ServiceOrigin $ServiceOrigin -PlanPath $ResolvedPlanPath -AdminToken $AdminToken -ExpectedCameras $ExpectedCameras 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Calibration dry-run precondition failed: $($DryRunOutput -join [Environment]::NewLine)" }
    $DryRunText = ($DryRunOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
    $Evidence.dryRun = $DryRunText.Substring($DryRunText.IndexOf("{")) | ConvertFrom-Json

    $ApplyAId = New-OperationId "generation-a"
    $ApplyA = Invoke-ServiceJson -Method POST -Path "/api/calibration/apply-all" -Body (New-ApplyBody -Plan $Plan -OperationId $ApplyAId) -RequestTimeoutSec 300
    Test-Condition ($ApplyA.json.code -eq 0 -and [int]$ApplyA.json.applied -eq $ExpectedCameras) "Generation A apply did not succeed on all cameras."
    $TokenA = [string]$ApplyA.json.rollbackToken
    Test-Condition (-not [string]::IsNullOrWhiteSpace($TokenA)) "Generation A did not return a token."

    Start-Sleep -Milliseconds 5
    $ApplyBId = New-OperationId "generation-b"
    $ApplyB = Invoke-ServiceJson -Method POST -Path "/api/calibration/apply-all" -Body (New-ApplyBody -Plan $Plan -OperationId $ApplyBId) -RequestTimeoutSec 300
    Test-Condition ($ApplyB.json.code -eq 0 -and [int]$ApplyB.json.applied -eq $ExpectedCameras) "Generation B apply did not succeed on all cameras."
    $TokenB = [string]$ApplyB.json.rollbackToken
    Test-Condition (-not [string]::IsNullOrWhiteSpace($TokenB) -and $TokenB -ne $TokenA) "Generation B token is missing or reused."
    $Evidence.applyA = $ApplyA.json
    $Evidence.applyB = $ApplyB.json

    $BeforeStale = Get-CalibrationStatuses @($Plan.ips)
    $MaintenancePath = [string]$BeforeStale[0].maintenanceRecordPath
    $MaintenanceHashBeforeStale = Get-OptionalFileHash $MaintenancePath
    $StatusBeforeStale = Get-StatusFingerprint $BeforeStale
    $StaleRollbackId = New-OperationId "stale-rollback"
    $Stale = Invoke-ServiceJson -Method POST -Path "/api/calibration/rollback" -Body ([ordered]@{
      operationId = $StaleRollbackId
      applyOperationId = $ApplyAId
      rollbackToken = $TokenA
      stopStreams = $true
      confirmation = "ROLLBACK CAMERA CALIBRATION"
    })
    $AfterStale = Get-CalibrationStatuses @($Plan.ips)
    Test-Condition ([int]$Stale.json.code -ne 0) "Stale generation rollback was accepted."
    Test-Condition ($Stale.json.attempted -eq $false -and $Stale.json.sideEffects -eq $false) "Stale generation rejection did not provide decisive zero-write evidence."
    Test-Condition ((Get-StatusFingerprint $AfterStale) -eq $StatusBeforeStale) "Stale generation rejection changed camera calibration status."
    Test-Condition ((Get-OptionalFileHash $MaintenancePath) -eq $MaintenanceHashBeforeStale) "Stale generation rejection appended a maintenance mutation record."
    $Evidence.staleGeneration = [ordered]@{ response = $Stale.json; before = $BeforeStale; after = $AfterStale; zeroWriteEvidence = $true }

    $CaptureHealth = (Invoke-JsonRequest -Method GET -Uri (Join-OriginPath $CaptureOrigin "/health")).json
    $ManifestRoot = Join-Path (Join-Path ([string]$CaptureHealth.configRoot) "calibration-rollbacks") $TokenB
    $ManifestFiles = @(Get-ChildItem -LiteralPath $ManifestRoot -Filter "manifest.json" -File -Recurse -ErrorAction Stop)
    Test-Condition ($ManifestFiles.Count -eq 1) "Generation B did not have exactly one rollback manifest."
    if ($Failures.Count -eq 0) {
      $Manifest = Read-JsonFileUtf8 $ManifestFiles[0].FullName
      Test-Condition ([string]$Manifest.operationId -eq $ApplyBId -and [string]$Manifest.phase -eq "applied") "Generation B manifest is not an applied operation head."
      $StagedPath = [string]$Manifest.cameras[0].stagedPreviousPath
      $StagedBytes = [IO.File]::ReadAllBytes($StagedPath)
      $StagedAttributes = [IO.File]::GetAttributes($StagedPath)
      $ExpectedHash = [string]$Manifest.cameras[0].sha256
      Test-Condition (([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($StagedBytes)).Replace("-", "").ToLowerInvariant()) -eq $ExpectedHash) "Selected staged file did not match its manifest before the drill."

      $BeforeTamper = Get-CalibrationStatuses @($Plan.ips)
      $StatusBeforeTamper = Get-StatusFingerprint $BeforeTamper
      $MaintenanceHashBeforeTamper = Get-OptionalFileHash $MaintenancePath
      [IO.File]::SetAttributes($StagedPath, [IO.FileAttributes]::Normal)
      $Tampered = [byte[]]::new($StagedBytes.Length + 1)
      [Array]::Copy($StagedBytes, $Tampered, $StagedBytes.Length)
      $Tampered[$Tampered.Length - 1] = 0x0A
      [IO.File]::WriteAllBytes($StagedPath, $Tampered)

      $TamperRollbackId = New-OperationId "tamper-rollback"
      $Tamper = Invoke-ServiceJson -Method POST -Path "/api/calibration/rollback" -Body ([ordered]@{
        operationId = $TamperRollbackId
        applyOperationId = $ApplyBId
        rollbackToken = $TokenB
        stopStreams = $true
        confirmation = "ROLLBACK CAMERA CALIBRATION"
      }) -AllowedStatusCodes @(200, 409)
      $AfterTamper = Get-CalibrationStatuses @($Plan.ips)
      Test-Condition ([int]$Tamper.json.code -ne 0) "Tampered staged rollback file was accepted."
      Test-Condition ($Tamper.json.attempted -eq $false -and $Tamper.json.sideEffects -eq $false) "Staged hash rejection did not provide decisive zero-write evidence."
      Test-Condition ((Get-StatusFingerprint $AfterTamper) -eq $StatusBeforeTamper) "Staged hash rejection changed camera calibration status."
      Test-Condition ((Get-OptionalFileHash $MaintenancePath) -eq $MaintenanceHashBeforeTamper) "Staged hash rejection appended a maintenance mutation record."
      $TamperDetail = Invoke-ServiceJson -Method GET -Path ("/api/calibration/operations/detail?id=" + [uri]::EscapeDataString($TamperRollbackId))
      $Evidence.stagedTamper = [ordered]@{ response = $Tamper.json; ledger = $TamperDetail.json; before = $BeforeTamper; after = $AfterTamper; zeroWriteEvidence = $true }

      [IO.File]::WriteAllBytes($StagedPath, $StagedBytes)
      [IO.File]::SetAttributes($StagedPath, $StagedAttributes)
      $StagedBytes = $null

      $RecoveryId = New-OperationId "integrity-recovery"
      $RecoveryBody = [ordered]@{
        operationId = $RecoveryId
        applyOperationId = $ApplyBId
        rollbackToken = $TokenB
        stopStreams = $true
        confirmation = "ROLLBACK CAMERA CALIBRATION"
      }
      if ([string]$TamperDetail.json.status -eq "needs-reconciliation") { $RecoveryBody.parentOperationId = $TamperRollbackId }
      $Recovery = Invoke-ServiceJson -Method POST -Path "/api/calibration/rollback" -Body $RecoveryBody -RequestTimeoutSec 300
      Test-Condition ($Recovery.json.code -eq 0 -and $Recovery.json.complete -eq $true -and [string]$Recovery.json.applyOperationId -eq $ApplyBId) "Restored staged bytes did not complete rollback."
      if ($RecoveryBody.parentOperationId) {
        $Parent = Invoke-ServiceJson -Method GET -Path ("/api/calibration/operations/detail?id=" + [uri]::EscapeDataString($TamperRollbackId))
        Test-Condition ([string]$Parent.json.status -eq "reconciled" -and [string]$Parent.json.reconciliationId -eq $RecoveryId) "Tamper rejection row was not reconciled by the restored rollback."
        $Evidence.reconciledTamperParent = $Parent.json
      }
      $Evidence.recovery = $Recovery.json

      $HealthAfter = Invoke-ServiceJson -Method GET -Path "/api/health/details"
      Test-Condition ($HealthAfter.json.checks.calibrationReconciliation.healthy -eq $true -and $HealthAfter.json.checks.capture.recoveryRequired -ne $true) "Readiness did not reopen after integrity recovery."
      $Evidence.healthAfterRecovery = $HealthAfter.json

      $Validation = Invoke-ServiceJson -Method POST -Path "/api/capture/continuous-test" -Body ([ordered]@{
        materialId = "CALIBRATION-INTEGRITY-" + (Get-Date -Format "yyyyMMdd-HHmmss")
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
      Test-Condition ($Validation.json.code -eq 0 -and [int]$Validation.json.completeFrames -eq $ExpectedCameras -and [int]$Validation.json.metadataFrames -eq $ExpectedCameras) "Post-integrity recovery validation capture was incomplete."
      $Evidence.validationCapture = $Validation.json
    }
  }
} catch {
  Add-Failure $_.Exception.Message
} finally {
  if ($null -ne $StagedBytes -and -not [string]::IsNullOrWhiteSpace($StagedPath)) {
    try {
      [IO.File]::SetAttributes($StagedPath, [IO.FileAttributes]::Normal)
      [IO.File]::WriteAllBytes($StagedPath, $StagedBytes)
      if ($null -ne $StagedAttributes) { [IO.File]::SetAttributes($StagedPath, $StagedAttributes) }
    } catch {
      Add-Failure "CRITICAL: failed to restore staged rollback bytes: $($_.Exception.Message)"
    }
  }
}

$Report = [ordered]@{
  schema = "steel.real-calibration.integrity-generation.v1"
  code = if ($Failures.Count -eq 0) { 0 } else { 1 }
  checkedAt = (Get-Date).ToString("o")
  elapsedSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 3)
  serviceOrigin = $ServiceOrigin
  captureOrigin = $CaptureOrigin
  expectedCameras = $ExpectedCameras
  evidence = $Evidence
  failures = @($Failures)
  reportPath = $ReportPath
}
$Report | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
$Report | ConvertTo-Json -Depth 30
if ($Failures.Count -gt 0) { exit 1 }
