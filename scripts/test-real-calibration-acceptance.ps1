param(
  [string]$ServiceOrigin = "http://127.0.0.1:4873",
  [Parameter(Mandatory = $true)]
  [string]$PlanPath,
  [string]$AdminToken = $env:STEEL_ADMIN_TOKEN,
  [int]$ExpectedCameras = 8,
  [string]$ReportDir = "",
  [switch]$RunApplyRollback,
  [switch]$SaveToDevice,
  [string]$SafetyConfirmation = "",
  [int]$Lines = 1000,
  [int]$Width = 0,
  [int]$TimeoutMs = 8000,
  [int]$DataMode = 3
)

$ErrorActionPreference = "Stop"
if ($ExpectedCameras -ne 8) {
  throw "Formal calibration acceptance requires exactly eight cameras."
}
$MutationConfirmation = "RUN REAL EIGHT CAMERA CALIBRATION APPLY AND ROLLBACK"
$StartedAt = Get-Date
$Failures = [System.Collections.Generic.List[string]]::new()

function Join-OriginPath {
  param([string]$Origin, [string]$Path)
  return $Origin.TrimEnd("/") + "/" + $Path.TrimStart("/")
}

function Test-JsonProperty {
  param([object]$Object, [string]$Name)
  return $null -ne $Object -and ($Object.PSObject.Properties.Name -contains $Name)
}

function Add-Failure {
  param([string]$Message)
  $Failures.Add($Message)
}

function Test-Condition {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) {
    Add-Failure $Message
  }
}

function Invoke-ServiceJson {
  param(
    [ValidateSet("GET", "POST")]
    [string]$Method,
    [string]$Path,
    [object]$Body = $null,
    [int[]]$AllowedStatusCodes = @(200),
    [int]$RequestTimeoutSec = 60
  )

  if ([string]::IsNullOrWhiteSpace($AdminToken)) {
    throw "AdminToken is required for the authenticated calibration acceptance routes."
  }
  $Headers = @{
    Authorization = "Bearer $AdminToken"
    Accept = "application/json"
  }
  $Uri = Join-OriginPath $ServiceOrigin $Path
  try {
    if ($Method -eq "GET") {
      $Response = Invoke-WebRequest -Method Get -Uri $Uri -Headers $Headers -UseBasicParsing -TimeoutSec $RequestTimeoutSec
    } else {
      $JsonBody = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Compress -Depth 30 }
      $Response = Invoke-WebRequest -Method Post -Uri $Uri -Headers $Headers -UseBasicParsing -ContentType "application/json; charset=utf-8" -Body $JsonBody -TimeoutSec $RequestTimeoutSec
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
  }

  $Json = if ([string]::IsNullOrWhiteSpace($Content)) { $null } else { $Content | ConvertFrom-Json }
  if ($AllowedStatusCodes -notcontains $StatusCode) {
    throw "Unexpected HTTP $StatusCode from $Uri`: $Content"
  }
  return [pscustomobject]@{
    statusCode = $StatusCode
    json = $Json
    content = $Content
  }
}

function Get-ReportRoot {
  if (-not [string]::IsNullOrWhiteSpace($ReportDir)) {
    return [System.IO.Path]::GetFullPath($ReportDir)
  }
  if (Test-Path (Join-Path $PSScriptRoot "manifest.json") -PathType Leaf) {
    return Join-Path $PSScriptRoot "logs\real-calibration-acceptance"
  }
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  return Join-Path $RepoRoot "target\logs\real-calibration-acceptance"
}

function Get-CanonicalFileEvidence {
  param([string]$Path, [string]$Label)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    Add-Failure "$Label path is empty."
    return [ordered]@{ path = $Path; exists = $false; bytes = 0; sha256 = "" }
  }
  try {
    $Resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $Item = Get-Item -LiteralPath $Resolved -Force
    if ($Item.PSIsContainer) {
      Add-Failure "$Label is a directory, not a file: $Resolved"
      return [ordered]@{ path = $Resolved; exists = $false; bytes = 0; sha256 = "" }
    }
    $Hash = Get-FileHash -LiteralPath $Resolved -Algorithm SHA256
    return [ordered]@{
      path = $Resolved
      exists = $true
      bytes = [long]$Item.Length
      sha256 = [string]$Hash.Hash.ToLowerInvariant()
    }
  } catch {
    Add-Failure "$Label is not an existing regular file: $Path"
    return [ordered]@{ path = $Path; exists = $false; bytes = 0; sha256 = "" }
  }
}

function New-OperationId {
  param([string]$Kind)
  return "hardware-$Kind-" + (Get-Date -Format "yyyyMMdd-HHmmss-fff")
}

$ReportRoot = Get-ReportRoot
New-Item -ItemType Directory -Force -Path $ReportRoot | Out-Null
$ReportPath = Join-Path $ReportRoot ("real-calibration-acceptance-{0}.json" -f (Get-Date -Format "yyyyMMdd-HHmmss-fff"))
$ResolvedPlanPath = ""
$Plan = $null
$MappingEvidence = @()
$ArrayCalibrationEvidence = $null
$DryRun = $null
$Apply = $null
$ApplyLedger = $null
$Rollback = $null
$RollbackLedger = $null
$Validation = $null
$HealthAfterRollback = $null

try {
  $ResolvedPlanPath = (Resolve-Path -LiteralPath $PlanPath -ErrorAction Stop).Path
  $Plan = [System.IO.File]::ReadAllText($ResolvedPlanPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
} catch {
  Add-Failure "Calibration plan is missing or invalid JSON: $PlanPath`: $($_.Exception.Message)"
}

if ($null -ne $Plan) {
  $Mappings = @($Plan.cameraCalibrations)
  $Ips = @($Plan.ips | ForEach-Object { [string]$_ })
  Test-Condition ($ExpectedCameras -eq 8) "Formal calibration acceptance requires ExpectedCameras=8."
  Test-Condition ($Mappings.Count -eq $ExpectedCameras) "Plan contains $($Mappings.Count) camera calibration mapping(s), expected $ExpectedCameras."
  Test-Condition ($Ips.Count -eq $ExpectedCameras) "Plan contains $($Ips.Count) IP(s), expected $ExpectedCameras."
  Test-Condition (@($Ips | Select-Object -Unique).Count -eq $ExpectedCameras) "Plan IPs are not eight unique values."
  Test-Condition (-not [string]::IsNullOrWhiteSpace([string]$Plan.name)) "Plan name is required."
  Test-Condition (-not [string]::IsNullOrWhiteSpace([string]$Plan.path)) "Plan array calibration path is required for active-profile correlation."
  $ArrayCalibrationEvidence = Get-CanonicalFileEvidence -Path ([string]$Plan.path) -Label "Array reconstruction calibration"

  $Serials = @()
  $TargetPaths = @()
  $RollbackPaths = @()
  $TargetHashes = @()
  foreach ($Mapping in $Mappings) {
    $Ip = [string]$Mapping.ip
    $Sn = [string]$Mapping.expectedSn
    $TargetPath = [string]$Mapping.path
    $RollbackPath = [string]$Mapping.rollbackPath
    $Serials += $Sn
    $TargetPaths += $TargetPath
    $RollbackPaths += $RollbackPath
    Test-Condition ($Ips -contains $Ip) "Mapping IP is absent from plan.ips: $Ip"
    Test-Condition (-not [string]::IsNullOrWhiteSpace($Sn)) "Mapping expectedSn is empty for $Ip."
    Test-Condition ([string]$Mapping.artifactType -eq "camera-sdk") "Mapping artifactType must be camera-sdk for $Ip."
    $TargetEvidence = Get-CanonicalFileEvidence -Path $TargetPath -Label "Target SDK calibration for $Ip"
    $RollbackEvidence = Get-CanonicalFileEvidence -Path $RollbackPath -Label "Known-good rollback calibration for $Ip"
    $TargetHashes += $TargetEvidence.sha256
    Test-Condition ($TargetEvidence.sha256 -ne $RollbackEvidence.sha256) "Target and known-good rollback files are byte-identical for $Ip; this would not prove restoration."
    $MappingEvidence += [ordered]@{
      ip = $Ip
      expectedSn = $Sn
      artifactType = [string]$Mapping.artifactType
      target = $TargetEvidence
      rollback = $RollbackEvidence
      targetDiffersFromRollback = $TargetEvidence.sha256 -ne $RollbackEvidence.sha256
    }
  }
  Test-Condition (@($Serials | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique).Count -eq $ExpectedCameras) "Plan expectedSn values are not eight non-empty unique values."
  Test-Condition (@($TargetPaths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique).Count -eq $ExpectedCameras) "Plan target SDK calibration paths are not eight non-empty unique values."
  Test-Condition (@($RollbackPaths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique).Count -eq $ExpectedCameras) "Plan rollback SDK calibration paths are not eight non-empty unique values."
  if ($null -ne $ArrayCalibrationEvidence -and $ArrayCalibrationEvidence.exists) {
    Test-Condition ($TargetHashes -notcontains $ArrayCalibrationEvidence.sha256) "Array reconstruction XML must not be reused as a per-camera SDK calibration artifact."
  }
}

if ($Failures.Count -eq 0) {
  try {
    $DryRunBody = [ordered]@{
      name = [string]$Plan.name
      version = [string]$Plan.version
      path = [string]$Plan.path
      ips = @($Plan.ips)
      expectedCameras = $ExpectedCameras
      cameraCalibrations = @($Plan.cameraCalibrations)
      dryRun = $true
      stopStreams = $true
      atomic = $true
      rollbackOnFailure = $true
      requireAllMapped = $true
      persistActive = $true
      saveCameraParams = $false
      saveToDevice = [bool]$SaveToDevice
      allowBestEffortDeviceRollback = $false
    }
    $DryRun = Invoke-ServiceJson -Method POST -Path "/api/calibration/apply-all" -Body $DryRunBody -RequestTimeoutSec 120
    Test-Condition ($DryRun.json.code -eq 0) "Calibration dry-run returned non-zero code: $($DryRun.content)"
    Test-Condition (@($DryRun.json.results).Count -eq $ExpectedCameras) "Calibration dry-run did not return exactly $ExpectedCameras per-camera results."
    foreach ($Row in @($DryRun.json.results)) {
      Test-Condition ([int]$Row.preflightCode -eq 0) "Calibration dry-run preflight failed for $($Row.ip): code=$($Row.preflightCode), message=$($Row.message)"
      Test-Condition (-not [bool]$Row.attempted) "Calibration dry-run unexpectedly attempted an SDK mutation for $($Row.ip)."
    }
  } catch {
    Add-Failure "Calibration dry-run failed: $($_.Exception.Message)"
  }
}

if ($RunApplyRollback) {
  if ($SafetyConfirmation -cne $MutationConfirmation) {
    Add-Failure "Real apply/rollback requires -SafetyConfirmation '$MutationConfirmation'."
  }
  if ($Failures.Count -eq 0) {
    $ApplyOperationId = New-OperationId "calibration-apply"
    $RollbackOperationId = ""
    try {
      $ApplyBody = [ordered]@{
        operationId = $ApplyOperationId
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
      if ($SaveToDevice) {
        $ApplyBody.deviceConfirmation = "PERSIST CAMERA PARAMETERS"
      }
      $Apply = Invoke-ServiceJson -Method POST -Path "/api/calibration/apply-all" -Body $ApplyBody -RequestTimeoutSec 300
      Test-Condition ($Apply.json.code -eq 0) "Real calibration apply returned non-zero code: $($Apply.content)"
      Test-Condition ([string]$Apply.json.operationId -eq $ApplyOperationId) "Apply response operationId did not match the caller ID."
      Test-Condition ([int]$Apply.json.applied -eq $ExpectedCameras -and [int]$Apply.json.failed -eq 0) "Apply did not succeed on exactly $ExpectedCameras cameras."
      Test-Condition (@($Apply.json.results).Count -eq $ExpectedCameras) "Apply did not return exactly $ExpectedCameras per-camera results."
      Test-Condition (-not [string]::IsNullOrWhiteSpace([string]$Apply.json.rollbackToken)) "Apply did not return a rollback token."
      foreach ($Row in @($Apply.json.results)) {
        Test-Condition ([string]$Row.operationId -eq $ApplyOperationId -and [bool]$Row.applied -and [int]$Row.applyCode -eq 0) "Apply evidence failed for $($Row.ip)."
      }

      $ApplyLedger = Invoke-ServiceJson -Method GET -Path ("/api/calibration/operations/detail?id=" + [uri]::EscapeDataString($ApplyOperationId))
      Test-Condition ([string]$ApplyLedger.json.operationId -eq $ApplyOperationId -and [string]$ApplyLedger.json.status -eq "succeeded") "Rust apply ledger did not persist a succeeded terminal row."

      if (-not [string]::IsNullOrWhiteSpace([string]$Apply.json.rollbackToken)) {
        $RollbackOperationId = New-OperationId "calibration-rollback"
        $RollbackBody = [ordered]@{
          operationId = $RollbackOperationId
          applyOperationId = $ApplyOperationId
          rollbackToken = [string]$Apply.json.rollbackToken
          stopStreams = $true
          confirmation = "ROLLBACK CAMERA CALIBRATION"
        }
        $Rollback = Invoke-ServiceJson -Method POST -Path "/api/calibration/rollback" -Body $RollbackBody -RequestTimeoutSec 300
        Test-Condition ($Rollback.json.code -eq 0 -and [bool]$Rollback.json.complete) "Explicit rollback was not complete: $($Rollback.content)"
        Test-Condition ([string]$Rollback.json.operationId -eq $RollbackOperationId) "Rollback response operationId did not match the caller ID."
        Test-Condition ([string]$Rollback.json.applyOperationId -eq $ApplyOperationId) "Rollback did not bind to the original apply operation."
        Test-Condition ([int]$Rollback.json.rolledBack -eq $ExpectedCameras -and [int]$Rollback.json.failed -eq 0) "Rollback did not restore exactly $ExpectedCameras cameras."
        Test-Condition (@($Rollback.json.results).Count -eq $ExpectedCameras) "Rollback did not return exactly $ExpectedCameras per-camera results."
        foreach ($Row in @($Rollback.json.results)) {
          Test-Condition ([bool]$Row.rolledBack -and [int]$Row.rollbackCode -eq 0) "Rollback evidence failed for $($Row.ip)."
        }
        $RollbackLedger = Invoke-ServiceJson -Method GET -Path ("/api/calibration/operations/detail?id=" + [uri]::EscapeDataString($RollbackOperationId))
        Test-Condition ([string]$RollbackLedger.json.operationId -eq $RollbackOperationId -and [string]$RollbackLedger.json.status -eq "succeeded") "Rust rollback ledger did not persist a succeeded terminal row."
      }

      if ($null -ne $Rollback -and [bool]$Rollback.json.complete) {
        $ValidationBody = [ordered]@{
          materialId = "CALIBRATION-VALIDATION-" + (Get-Date -Format "yyyyMMdd-HHmmss")
          ips = @($Plan.ips)
          expectedCameras = $ExpectedCameras
          rounds = 1
          lines = $Lines
          width = $Width
          timeoutMs = $TimeoutMs
          intervalMs = 0
          retries = 0
          dataMode = $DataMode
          stopStreams = $true
          productionLayout = $false
          saveSdkDerived = $false
          discardBlackFrames = $false
        }
        $Validation = Invoke-ServiceJson -Method POST -Path "/api/capture/continuous-test" -Body $ValidationBody -RequestTimeoutSec 180
        Test-Condition ($Validation.json.code -eq 0 -and [int]$Validation.json.failures -eq 0) "Post-rollback validation capture reported failures."
        Test-Condition ([int]$Validation.json.completeFrames -eq $ExpectedCameras) "Validation capture did not commit exactly $ExpectedCameras complete frames."
        Test-Condition ([int]$Validation.json.metadataFrames -eq $ExpectedCameras) "Validation capture did not commit exactly $ExpectedCameras metadata frames."
        Test-Condition (@($Validation.json.results | ForEach-Object { [string]$_.ip } | Select-Object -Unique).Count -eq $ExpectedCameras) "Validation capture did not return eight unique camera IPs."
      }

      $HealthAfterRollback = Invoke-ServiceJson -Method GET -Path "/api/health/details"
      Test-Condition ($HealthAfterRollback.json.checks.calibrationReconciliation.healthy -eq $true) "Rust calibration reconciliation readiness did not reopen after rollback."
      Test-Condition ($HealthAfterRollback.json.checks.capture.recoveryRequired -ne $true) "Capture provider still reports recoveryRequired after rollback."
    } catch {
      Add-Failure "Real calibration apply/rollback stage failed: $($_.Exception.Message)"
    }
  }
}

$Report = [ordered]@{
  schema = "steel.real-calibration.acceptance.v1"
  code = if ($Failures.Count -eq 0) { 0 } else { 1 }
  checkedAt = (Get-Date).ToString("o")
  elapsedSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 3)
  serviceOrigin = $ServiceOrigin
  planPath = $ResolvedPlanPath
  expectedCameras = $ExpectedCameras
  mode = if ($RunApplyRollback) { "apply-rollback" } else { "dry-run" }
  saveToDevice = [bool]$SaveToDevice
  localPreflight = [ordered]@{
    arrayCalibration = $ArrayCalibrationEvidence
    mappingCount = $MappingEvidence.Count
    mappings = $MappingEvidence
  }
  dryRun = if ($null -eq $DryRun) { $null } else { $DryRun.json }
  apply = if ($null -eq $Apply) { $null } else { $Apply.json }
  applyLedger = if ($null -eq $ApplyLedger) { $null } else { $ApplyLedger.json }
  rollback = if ($null -eq $Rollback) { $null } else { $Rollback.json }
  rollbackLedger = if ($null -eq $RollbackLedger) { $null } else { $RollbackLedger.json }
  validationCapture = if ($null -eq $Validation) { $null } else { $Validation.json }
  healthAfterRollback = if ($null -eq $HealthAfterRollback) { $null } else { $HealthAfterRollback.json }
  limitations = @(
    "This report does not prove a process crash during applying or rolling-back.",
    "Run test-real-calibration-crash-recovery.ps1 Prepare/Resume for both ApplyCrash and RollbackCrash; staged-file tamper and generation rejection remain separate controlled checks."
  )
  failures = @($Failures)
  reportPath = $ReportPath
}
$Report | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
$Report | ConvertTo-Json -Depth 30

if ($Failures.Count -gt 0) {
  exit 1
}
