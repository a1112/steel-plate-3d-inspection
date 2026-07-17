param(
  [Parameter(Mandatory = $true)]
  [string]$PlanPath,
  [string]$ReportDir = "",
  [switch]$AllowNoGo
)

$ErrorActionPreference = "Stop"
$PlanPath = (Resolve-Path -LiteralPath $PlanPath).Path
$PlanRoot = Split-Path -Parent $PlanPath
$Plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
$Failures = [System.Collections.Generic.List[string]]::new()
$Gates = [System.Collections.Generic.List[object]]::new()
$PlanErrors = [System.Collections.Generic.List[string]]::new()

function Resolve-EvidencePath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  if (-not [System.IO.Path]::IsPathRooted($Path)) {
    $Path = Join-Path $PlanRoot $Path
  }
  return [System.IO.Path]::GetFullPath($Path)
}

function Read-Evidence {
  param([string]$Path, [System.Collections.Generic.List[string]]$Errors)
  $Resolved = Resolve-EvidencePath $Path
  if ([string]::IsNullOrWhiteSpace($Resolved) -or -not (Test-Path -LiteralPath $Resolved -PathType Leaf)) {
    $Errors.Add("evidence file is missing: $Resolved") | Out-Null
    return $null
  }
  try {
    return Get-Content -LiteralPath $Resolved -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    $Errors.Add("evidence JSON is invalid: $Resolved`: $($_.Exception.Message)") | Out-Null
    return $null
  }
}

function Add-Gate {
  param(
    [string]$Id,
    [string]$Name,
    [string]$Path,
    [System.Collections.Generic.List[string]]$Errors,
    [hashtable]$Details
  )
  $Resolved = Resolve-EvidencePath $Path
  $Passed = $Errors.Count -eq 0
  $Gates.Add([ordered]@{
    id = $Id
    name = $Name
    passed = $Passed
    evidencePath = $Resolved
    evidenceSha256 = if ($Resolved -and (Test-Path -LiteralPath $Resolved -PathType Leaf)) {
      (Get-FileHash -LiteralPath $Resolved -Algorithm SHA256).Hash.ToLowerInvariant()
    } else { $null }
    failures = @($Errors)
    details = $Details
  }) | Out-Null
  foreach ($ErrorText in $Errors) {
    $Failures.Add("$Id`: $ErrorText") | Out-Null
  }
}

function Test-RequiredScenarios {
  param(
    [object]$Report,
    [string]$ReportPath,
    [string]$ExpectedReleaseVersion,
    [string]$ExpectedReleaseCommit,
    [string]$ExpectedManifestSha256,
    [string[]]$Required,
    [System.Collections.Generic.List[string]]$Errors
  )
  if ($null -eq $Report) { return }
  $EvidenceRoot = Split-Path -Parent (Resolve-EvidencePath $ReportPath)
  $ExecutionStarted = [DateTimeOffset]::MinValue
  $ExecutionFinished = [DateTimeOffset]::MinValue
  $ExecutionWindowValid =
    [DateTimeOffset]::TryParse([string]$Report.startedAt, [ref]$ExecutionStarted) -and
    [DateTimeOffset]::TryParse([string]$Report.finishedAt, [ref]$ExecutionFinished) -and
    $ExecutionFinished -gt $ExecutionStarted
  $Rows = @($Report.scenarios)
  foreach ($Id in $Required) {
    $Matches = @($Rows | Where-Object { [string]$_.id -ceq $Id })
    if ($Matches.Count -ne 1) {
      $Errors.Add("scenario '$Id' must appear exactly once") | Out-Null
      continue
    }
    if ($Matches[0].passed -ne $true) {
      $Errors.Add("scenario '$Id' did not pass") | Out-Null
    }
    $EvidenceItems = @($Matches[0].evidence)
    if ($EvidenceItems.Count -lt 1) {
      $Errors.Add("scenario '$Id' has no evidence reference") | Out-Null
      continue
    }
    foreach ($Evidence in $EvidenceItems) {
      $EvidencePath = [string]$Evidence.path
      $ExpectedSha = [string]$Evidence.sha256
      if ([string]::IsNullOrWhiteSpace($EvidencePath) -or $ExpectedSha -notmatch "^[0-9a-f]{64}$") {
        $Errors.Add("scenario '$Id' has an invalid evidence path or SHA-256") | Out-Null
        continue
      }
      if (-not [System.IO.Path]::IsPathRooted($EvidencePath)) {
        $EvidencePath = Join-Path $EvidenceRoot $EvidencePath
      }
      $EvidencePath = [System.IO.Path]::GetFullPath($EvidencePath)
      if (-not (Test-Path -LiteralPath $EvidencePath -PathType Leaf)) {
        $Errors.Add("scenario '$Id' evidence file is missing: $EvidencePath") | Out-Null
        continue
      }
      $ActualSha = (Get-FileHash -LiteralPath $EvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($ActualSha -cne $ExpectedSha) {
        $Errors.Add("scenario '$Id' evidence SHA-256 mismatch: $EvidencePath") | Out-Null
        continue
      }
      try {
        $EvidenceJson = Get-Content -LiteralPath $EvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json
      } catch {
        $Errors.Add("scenario '$Id' evidence is not valid JSON: $EvidencePath") | Out-Null
        continue
      }
      if ([string]$EvidenceJson.schema -ne "steel.functional-scenario-evidence.v1") {
        $Errors.Add("scenario '$Id' evidence schema mismatch: $EvidencePath") | Out-Null
      }
      if ([string]$EvidenceJson.releaseVersion -cne $ExpectedReleaseVersion -or
          [string]$EvidenceJson.releaseCommit -cne $ExpectedReleaseCommit) {
        $Errors.Add("scenario '$Id' evidence release identity mismatch: $EvidencePath") | Out-Null
      }
      if ([string]$EvidenceJson.releaseManifestSha256 -cne $ExpectedManifestSha256) {
        $Errors.Add("scenario '$Id' evidence manifest SHA-256 mismatch: $EvidencePath") | Out-Null
      }
      if ([string]$EvidenceJson.scenarioId -cne $Id) {
        $Errors.Add("scenario '$Id' evidence declared a different scenarioId: $EvidencePath") | Out-Null
      }
      if ([string]$EvidenceJson.result -cne "pass") {
        $Errors.Add("scenario '$Id' evidence result was not pass: $EvidencePath") | Out-Null
      }
      $ObservedAt = [DateTimeOffset]::MinValue
      if (-not [DateTimeOffset]::TryParse([string]$EvidenceJson.observedAt, [ref]$ObservedAt) -or
          -not $ExecutionWindowValid -or $ObservedAt -lt $ExecutionStarted -or $ObservedAt -gt $ExecutionFinished) {
        $Errors.Add("scenario '$Id' evidence observedAt was outside the execution window: $EvidencePath") | Out-Null
      }
      if ([string]::IsNullOrWhiteSpace([string]$EvidenceJson.source.system) -or
          [string]::IsNullOrWhiteSpace([string]$EvidenceJson.source.command) -or
          [string]::IsNullOrWhiteSpace([string]$EvidenceJson.source.rawLogPath)) {
        $Errors.Add("scenario '$Id' evidence source metadata is incomplete: $EvidencePath") | Out-Null
        continue
      }
      $RawLogPath = [string]$EvidenceJson.source.rawLogPath
      $RawLogSha256 = [string]$EvidenceJson.source.rawLogSha256
      if ($RawLogSha256 -notmatch "^[0-9a-f]{64}$") {
        $Errors.Add("scenario '$Id' raw log SHA-256 is invalid: $EvidencePath") | Out-Null
        continue
      }
      if (-not [System.IO.Path]::IsPathRooted($RawLogPath)) {
        $RawLogPath = Join-Path (Split-Path -Parent $EvidencePath) $RawLogPath
      }
      $RawLogPath = [System.IO.Path]::GetFullPath($RawLogPath)
      if (-not (Test-Path -LiteralPath $RawLogPath -PathType Leaf)) {
        $Errors.Add("scenario '$Id' raw log file is missing: $RawLogPath") | Out-Null
        continue
      }
      $ActualRawLogSha = (Get-FileHash -LiteralPath $RawLogPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($ActualRawLogSha -cne $RawLogSha256) {
        $Errors.Add("scenario '$Id' raw log SHA-256 mismatch: $RawLogPath") | Out-Null
      }
    }
  }
}

function Test-ExecutionWindow {
  param(
    [object]$Report,
    [System.Collections.Generic.List[string]]$Errors
  )
  $Started = [DateTimeOffset]::MinValue
  $Finished = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$Report.startedAt, [ref]$Started) -or
      -not [DateTimeOffset]::TryParse([string]$Report.finishedAt, [ref]$Finished) -or
      $Finished -le $Started) {
    $Errors.Add("startedAt/finishedAt must be a valid increasing execution window") | Out-Null
  }
}

if ([string]$Plan.schema -ne "steel.functional-go-live-plan.v1") {
  throw "Plan schema must be steel.functional-go-live-plan.v1."
}
$ReleaseVersion = [string]$Plan.releaseVersion
$ReleaseCommit = [string]$Plan.releaseCommit
if ([string]::IsNullOrWhiteSpace($ReleaseVersion) -or $ReleaseVersion -like "REPLACE-*") {
  $PlanErrors.Add("approved releaseVersion is missing") | Out-Null
}
if ($ReleaseCommit -notmatch "^[0-9a-f]{40,64}$") {
  $PlanErrors.Add("releaseCommit must be exact lowercase 40-64 hex") | Out-Null
}

$ExpectedCameras = [int]$Plan.thresholds.expectedCameras
$RequiredCoverage = [int]$Plan.thresholds.requiredIntegratedCoverage
$MinimumSoakSeconds = [int]$Plan.thresholds.minimumSoakSeconds
$MinimumSoakCycles = [int]$Plan.thresholds.minimumSoakCycles
if ($ExpectedCameras -ne 8) { $PlanErrors.Add("functional production release requires exactly eight cameras") | Out-Null }
if ($RequiredCoverage -lt 24) { $PlanErrors.Add("integrated coverage threshold cannot be below 24") | Out-Null }
if ($MinimumSoakSeconds -lt 28800) { $PlanErrors.Add("production soak threshold cannot be below one 8-hour shift") | Out-Null }
if ($MinimumSoakCycles -lt 1) { $PlanErrors.Add("minimumSoakCycles must be positive") | Out-Null }

$ManifestErrors = [System.Collections.Generic.List[string]]::new()
foreach ($PlanError in $PlanErrors) { $ManifestErrors.Add("plan: $PlanError") | Out-Null }
$ManifestPath = Resolve-EvidencePath ([string]$Plan.packageManifestPath)
$Manifest = Read-Evidence -Path ([string]$Plan.packageManifestPath) -Errors $ManifestErrors
$ManifestSha256 = if ($ManifestPath -and (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  (Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
} else { $null }
if ($Manifest) {
  if ([string]$Manifest.schema -ne "steel.runtime-package.v1") { $ManifestErrors.Add("package manifest schema mismatch") | Out-Null }
  if ([string]$Manifest.source.gitCommit -cne $ReleaseCommit) { $ManifestErrors.Add("package manifest commit does not match the plan") | Out-Null }
  if ([string]$Manifest.releaseVersion -cne $ReleaseVersion) { $ManifestErrors.Add("package manifest releaseVersion does not match the plan") | Out-Null }
}
Add-Gate "FUNC-00" "Release identity" ([string]$Plan.packageManifestPath) $ManifestErrors @{
  releaseVersion = $ReleaseVersion
  releaseCommit = $ReleaseCommit
}

$AlgorithmErrors = [System.Collections.Generic.List[string]]::new()
$Algorithm = Read-Evidence -Path ([string]$Plan.evidence.algorithmAuditPath) -Errors $AlgorithmErrors
if ($Algorithm) {
  if ([string]$Algorithm.schema -ne "steel.algorithm-acceptance.audit.v1") { $AlgorithmErrors.Add("algorithm audit schema mismatch") | Out-Null }
  if ([int]$Algorithm.code -ne 0) { $AlgorithmErrors.Add("algorithm audit did not pass") | Out-Null }
  if ([string]$Algorithm.releaseCommit -cne $ReleaseCommit) { $AlgorithmErrors.Add("algorithm audit releaseCommit does not match the plan") | Out-Null }
  if ([string]::IsNullOrWhiteSpace([string]$Algorithm.approvals.algorithmOwner) -or
      [string]::IsNullOrWhiteSpace([string]$Algorithm.approvals.qualityOwner)) {
    $AlgorithmErrors.Add("algorithm and quality approvals are required") | Out-Null
  }
}
Add-Gate "FUNC-01" "Real labeled algorithm qualification" ([string]$Plan.evidence.algorithmAuditPath) $AlgorithmErrors @{
  datasetRevision = if ($Algorithm) { $Algorithm.datasetRevision } else { $null }
  metrics = if ($Algorithm) { $Algorithm.metrics } else { $null }
}

$IntegratedErrors = [System.Collections.Generic.List[string]]::new()
$Integrated = Read-Evidence -Path ([string]$Plan.evidence.integrated24Path) -Errors $IntegratedErrors
if ($Integrated) {
  if ([string]$Integrated.schema -ne "steel.integrated-capture-management.acceptance.v1") { $IntegratedErrors.Add("integrated report schema mismatch") | Out-Null }
  if ([int]$Integrated.code -ne 0) { $IntegratedErrors.Add("integrated report did not pass") | Out-Null }
  if ([string]$Integrated.release.version -cne $ReleaseVersion -or
      [string]$Integrated.release.commit -cne $ReleaseCommit -or
      [string]$Integrated.release.manifestSha256 -cne $ManifestSha256) {
    $IntegratedErrors.Add("integrated report release identity does not match the package manifest") | Out-Null
  }
  if ($Integrated.requested.requireFullCoverage -ne $true) { $IntegratedErrors.Add("integrated report was not run with RequireFullCoverage") | Out-Null }
  if ($Integrated.coverage.full -ne $true -or [int]$Integrated.coverage.covered -lt $RequiredCoverage -or
      [int]$Integrated.coverage.required -lt $RequiredCoverage -or @($Integrated.coverage.uncovered).Count -ne 0) {
    $IntegratedErrors.Add("integrated report did not prove unskipped 24/24 coverage") | Out-Null
  }
  $RealHardware = @($Integrated.checks | Where-Object { [string]$_.id -ceq "real-hardware" })
  if ($RealHardware.Count -ne 1 -or $RealHardware[0].ok -ne $true) { $IntegratedErrors.Add("real eight-camera hardware check did not pass") | Out-Null }
}
Add-Gate "FUNC-02" "Unskipped real eight-camera 24/24 matrix" ([string]$Plan.evidence.integrated24Path) $IntegratedErrors @{
  covered = if ($Integrated) { $Integrated.coverage.covered } else { 0 }
  required = if ($Integrated) { $Integrated.coverage.required } else { $RequiredCoverage }
}

$PlcErrors = [System.Collections.Generic.List[string]]::new()
$Plc = Read-Evidence -Path ([string]$Plan.evidence.plcL2Path) -Errors $PlcErrors
if ($Plc) {
  if ([string]$Plc.schema -ne "steel.plc-l2-functional-acceptance.v1") { $PlcErrors.Add("PLC/L2 report schema mismatch") | Out-Null }
  if ([string]$Plc.releaseVersion -cne $ReleaseVersion -or [string]$Plc.releaseCommit -cne $ReleaseCommit) { $PlcErrors.Add("PLC/L2 report release identity mismatch") | Out-Null }
  Test-ExecutionWindow $Plc $PlcErrors
  Test-RequiredScenarios $Plc ([string]$Plan.evidence.plcL2Path) $ReleaseVersion $ReleaseCommit $ManifestSha256 @("steel-info","steel-in","capture","algorithm","result-report","steel-out","duplicate-retry","wrong-order","disconnect-reconnect","service-restart","back-to-back-materials") $PlcErrors
  if ([string]::IsNullOrWhiteSpace([string]$Plc.target.line) -or
      [string]::IsNullOrWhiteSpace([string]$Plc.target.plc) -or
      [string]::IsNullOrWhiteSpace([string]$Plc.target.l2)) {
    $PlcErrors.Add("PLC/L2 target line, plc, and l2 identifiers are required") | Out-Null
  }
  if ([string]::IsNullOrWhiteSpace([string]$Plc.approvals.automationOwner) -or [string]::IsNullOrWhiteSpace([string]$Plc.approvals.productionOwner)) {
    $PlcErrors.Add("automation and production approvals are required") | Out-Null
  }
  $PlcApprovedAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$Plc.approvals.approvedAt, [ref]$PlcApprovedAt)) {
    $PlcErrors.Add("PLC/L2 approval time is required") | Out-Null
  } else {
    $PlcFinishedAt = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse([string]$Plc.finishedAt, [ref]$PlcFinishedAt) -and $PlcApprovedAt -lt $PlcFinishedAt) {
      $PlcErrors.Add("PLC/L2 approval time cannot precede execution completion") | Out-Null
    }
  }
}
Add-Gate "FUNC-03" "Real PLC/L2 production-chain acceptance" ([string]$Plan.evidence.plcL2Path) $PlcErrors @{
  scenarios = if ($Plc) { @($Plc.scenarios).Count } else { 0 }
}

$SoakErrors = [System.Collections.Generic.List[string]]::new()
$Soak = Read-Evidence -Path ([string]$Plan.evidence.productionSoakPath) -Errors $SoakErrors
if ($Soak) {
  if ([string]$Soak.schema -ne "steel.production.stability.v1") { $SoakErrors.Add("production soak schema mismatch") | Out-Null }
  if ([int]$Soak.code -ne 0 -or [int]$Soak.totals.failedCycles -ne 0) { $SoakErrors.Add("production soak contains failed cycles") | Out-Null }
  if ([string]$Soak.release.version -cne $ReleaseVersion -or
      [string]$Soak.release.commit -cne $ReleaseCommit -or
      [string]$Soak.release.manifestSha256 -cne $ManifestSha256) {
    $SoakErrors.Add("production soak release identity does not match the package manifest") | Out-Null
  }
  if ([string]$Soak.preflight.captureProvider -eq "simulated") { $SoakErrors.Add("simulated provider cannot satisfy the production-shift soak") | Out-Null }
  if ([double]$Soak.elapsedSeconds -lt $MinimumSoakSeconds) { $SoakErrors.Add("production soak duration is below $MinimumSoakSeconds seconds") | Out-Null }
  if ([int]$Soak.totals.cycles -lt $MinimumSoakCycles) { $SoakErrors.Add("production soak cycles are below $MinimumSoakCycles") | Out-Null }
  if ($Soak.finalConvergence.converged -ne $true -or [int]$Soak.finalConvergence.status.tasks.queueDepth -ne 0 -or
      -not [string]::IsNullOrWhiteSpace([string]$Soak.finalConvergence.status.tasks.worker.activeTaskId) -or
      [int]$Soak.finalConvergence.status.admission.inFlight -ne 0 -or $null -ne $Soak.finalConvergence.status.activeSession) {
    $SoakErrors.Add("production soak did not reach final queue/task/session convergence") | Out-Null
  }
  if ([int]$Soak.identityIsolation.uniqueMaterialIds -ne [int]$Soak.totals.cycles -or
      [int]$Soak.identityIsolation.uniqueSessionIds -ne [int]$Soak.totals.cycles -or
      [int]$Soak.identityIsolation.uniqueInspectionIds -ne [int]$Soak.totals.cycles) {
    $SoakErrors.Add("production soak identities are not unique per cycle") | Out-Null
  }
  $BadBindings = @($Soak.cycles | Where-Object {
    $_.identityBinding.sessionMatchesMaterial -ne $true -or
    $_.identityBinding.inspectionMatchesSession -ne $true -or
    $_.identityBinding.summaryMatchesCycle -ne $true
  })
  if ($BadBindings.Count -ne 0) { $SoakErrors.Add("production soak contains cross-cycle identity binding failures") | Out-Null }
}
Add-Gate "FUNC-04" "One complete real production-shift soak" ([string]$Plan.evidence.productionSoakPath) $SoakErrors @{
  provider = if ($Soak) { $Soak.preflight.captureProvider } else { $null }
  elapsedSeconds = if ($Soak) { $Soak.elapsedSeconds } else { 0 }
  cycles = if ($Soak) { $Soak.totals.cycles } else { 0 }
}

$TargetErrors = [System.Collections.Generic.List[string]]::new()
$Target = Read-Evidence -Path ([string]$Plan.evidence.targetMachinePath) -Errors $TargetErrors
if ($Target) {
  if ([string]$Target.schema -ne "steel.target-machine-functional-acceptance.v1") { $TargetErrors.Add("target-machine report schema mismatch") | Out-Null }
  if ([string]$Target.releaseVersion -cne $ReleaseVersion -or [string]$Target.releaseCommit -cne $ReleaseCommit) { $TargetErrors.Add("target-machine report release identity mismatch") | Out-Null }
  Test-ExecutionWindow $Target $TargetErrors
  Test-RequiredScenarios $Target ([string]$Plan.evidence.targetMachinePath) $ReleaseVersion $ReleaseCommit $ManifestSha256 @("clean-install","configuration-readback","service-start","reboot-auto-start","complete-production-cycle","upgrade","rollback","uninstall-preserves-production-data") $TargetErrors
  if ([string]::IsNullOrWhiteSpace([string]$Target.machine.name) -or [string]::IsNullOrWhiteSpace([string]$Target.machine.line)) {
    $TargetErrors.Add("target machine name and line are required") | Out-Null
  }
  if ([string]::IsNullOrWhiteSpace([string]$Target.approvals.implementationOwner) -or [string]::IsNullOrWhiteSpace([string]$Target.approvals.operationsOwner)) {
    $TargetErrors.Add("implementation and operations approvals are required") | Out-Null
  }
  $TargetApprovedAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$Target.approvals.approvedAt, [ref]$TargetApprovedAt)) {
    $TargetErrors.Add("target-machine approval time is required") | Out-Null
  } else {
    $TargetFinishedAt = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse([string]$Target.finishedAt, [ref]$TargetFinishedAt) -and $TargetApprovedAt -lt $TargetFinishedAt) {
      $TargetErrors.Add("target-machine approval time cannot precede execution completion") | Out-Null
    }
  }
}
Add-Gate "FUNC-05" "Clean target-machine functional lifecycle" ([string]$Plan.evidence.targetMachinePath) $TargetErrors @{
  machine = if ($Target) { $Target.machine.name } else { $null }
  scenarios = if ($Target) { @($Target.scenarios).Count } else { 0 }
}

if ([string]::IsNullOrWhiteSpace($ReportDir)) {
  $ReportDir = Join-Path $PlanRoot "reports"
}
$ReportDir = [System.IO.Path]::GetFullPath($ReportDir)
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$ReportPath = Join-Path $ReportDir ("functional-go-live-{0}.json" -f (Get-Date -Format "yyyyMMdd-HHmmss-fff"))
$PassedGates = @($Gates | Where-Object { $_.passed }).Count
$Result = [ordered]@{
  schema = "steel.functional-go-live-readiness.v1"
  decision = if ($Failures.Count -eq 0) { "go" } else { "no-go" }
  code = if ($Failures.Count -eq 0) { 0 } else { 1 }
  checkedAt = (Get-Date).ToString("o")
  scope = "functional-only"
  excludedFromDecision = @("security", "signing", "supply-chain")
  releaseVersion = $ReleaseVersion
  releaseCommit = $ReleaseCommit
  planPath = $PlanPath
  gates = @($Gates)
  summary = [ordered]@{
    passed = $PassedGates
    required = $Gates.Count
    remaining = $Gates.Count - $PassedGates
  }
  remaining = @($Gates | Where-Object { -not $_.passed } | ForEach-Object {
    [ordered]@{ id = $_.id; name = $_.name; failures = $_.failures }
  })
  failures = @($Failures)
  reportPath = $ReportPath
}
$Result | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
$Result | ConvertTo-Json -Depth 20
if ($Result.code -ne 0 -and -not $AllowNoGo) {
  exit 1
}
