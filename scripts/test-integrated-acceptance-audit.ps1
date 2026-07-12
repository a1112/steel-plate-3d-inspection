param(
  [string]$IntegratedReportPath = "",
  [string]$TenMinuteReportPath = "",
  [string]$RepoRoot = "",
  [string]$RuntimeRoot = "",
  [string]$ReportDir = "",
  [int]$ExpectedCameras = 6,
  [int]$MinEnduranceCycles = 100,
  [switch]$RunArchitectureCheck,
  [string]$QtPrefixPath = "C:\Qt"
)

$ErrorActionPreference = "Stop"

$ScriptRoot = (Resolve-Path $PSScriptRoot).Path
$SourceMode = Test-Path (Join-Path $ScriptRoot "package-runtime.ps1") -PathType Leaf

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = if ($SourceMode) {
    (Resolve-Path (Join-Path $ScriptRoot "..")).Path
  } else {
    $ScriptRoot
  }
} else {
  $RepoRoot = (Resolve-Path $RepoRoot).Path
}

if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  $RuntimeRoot = if ($SourceMode) {
    Join-Path $RepoRoot "target\packages\steel-inspection-runtime"
  } else {
    $ScriptRoot
  }
}
$RuntimeRoot = (Resolve-Path $RuntimeRoot).Path

if ([string]::IsNullOrWhiteSpace($ReportDir)) {
  $ReportDir = if ($SourceMode) {
    Join-Path $RepoRoot "target\logs\integrated-capture-management"
  } else {
    Join-Path $RuntimeRoot "logs\integrated-capture-management"
  }
}

$LogsRoot = $ReportDir
New-Item -ItemType Directory -Force -Path $LogsRoot | Out-Null
$RunId = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$ReportPath = Join-Path $LogsRoot "acceptance-audit-$RunId.json"

function Resolve-LatestJson {
  param(
    [string]$Directory,
    [string]$Pattern,
    [scriptblock]$Predicate = $null
  )
  $Files = @(Get-ChildItem -LiteralPath $Directory -Filter $Pattern -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
  foreach ($File in $Files) {
    if ($null -eq $Predicate) {
      return $File.FullName
    }
    try {
      $Json = Get-Content -Raw -LiteralPath $File.FullName | ConvertFrom-Json
      if (& $Predicate $Json) {
        return $File.FullName
      }
    } catch {
    }
  }
  return $null
}

function Read-JsonFile {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path $Path -PathType Leaf)) {
    throw "Missing JSON report: $Path"
  }
  return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function Get-Check {
  param(
    [object]$Integrated,
    [string]$Id
  )
  return @($Integrated.checks | Where-Object { $_.id -eq $Id } | Select-Object -First 1)[0]
}

function Get-CoverageItem {
  param(
    [object]$Integrated,
    [string]$Id
  )
  return @($Integrated.coverage.items | Where-Object { $_.id -eq $Id } | Select-Object -First 1)[0]
}

function Add-AuditItem {
  param(
    [System.Collections.Generic.List[object]]$Items,
    [string]$Id,
    [string]$Requirement,
    [bool]$Passed,
    [string[]]$Evidence,
    [hashtable]$Details = @{}
  )
  $Items.Add([ordered]@{
    id = $Id
    requirement = $Requirement
    passed = $Passed
    evidence = $Evidence
    details = $Details
  }) | Out-Null
}

function Test-All {
  param(
    [object[]]$Values,
    [scriptblock]$Predicate
  )
  if (-not $Values -or $Values.Count -eq 0) {
    return $false
  }
  foreach ($Value in $Values) {
    if (-not (& $Predicate $Value)) {
      return $false
    }
  }
  return $true
}

function Test-ExactStringSet {
  param(
    [object[]]$Actual,
    [string[]]$Expected
  )

  $ActualValues = @($Actual | ForEach-Object { [string]$_ } | Sort-Object -Unique)
  $ExpectedValues = @($Expected | Sort-Object -Unique)
  if ($ActualValues.Count -ne $ExpectedValues.Count) {
    return $false
  }
  return (Compare-Object -ReferenceObject $ExpectedValues -DifferenceObject $ActualValues).Count -eq 0
}

function TextFromCodePoints {
  param([int[]]$CodePoints)
  return [string]::Concat([char[]]$CodePoints)
}

if ([string]::IsNullOrWhiteSpace($IntegratedReportPath)) {
  $IntegratedReportPath = Resolve-LatestJson -Directory $LogsRoot -Pattern "integrated-capture-management-*.json"
}
if ([string]::IsNullOrWhiteSpace($TenMinuteReportPath)) {
  $ProductionLogRoot = if ($SourceMode) {
    Join-Path $RepoRoot "target\logs\production-stability"
  } else {
    Join-Path $RuntimeRoot "logs\production-stability"
  }
  $TenMinuteReportPath = Resolve-LatestJson -Directory $ProductionLogRoot -Pattern "production-stability-*.json" -Predicate {
    param($Json)
    return [int]$Json.totals.cycles -ge $MinEnduranceCycles
  }
}

$Integrated = Read-JsonFile $IntegratedReportPath
$Endurance = if ($TenMinuteReportPath) { Read-JsonFile $TenMinuteReportPath } else { $null }

$TargetRuntimeRoot = if ($SourceMode) { Join-Path $RepoRoot "target\runtime" } else { $RuntimeRoot }
$PackageRoot = if ($SourceMode) { Join-Path $RepoRoot "target\packages\steel-inspection-runtime" } else { $RuntimeRoot }
$MatrixPath = if ($SourceMode) { Join-Path $RepoRoot "docs\integrated-capture-management-acceptance.md" } else { Join-Path $RuntimeRoot "docs\integrated-capture-management-acceptance.md" }
$MatrixText = if (Test-Path $MatrixPath -PathType Leaf) { Get-Content -Raw -LiteralPath $MatrixPath } else { "" }

$RuntimeLayout = Get-Check $Integrated "runtime-layout"
$LiveReady = Get-Check $Integrated "live-ready"
$RealHardware = Get-Check $Integrated "real-hardware"
$RealCalibration = Get-Check $Integrated "real-calibration"
$RealCalibrationCrashRecovery = Get-Check $Integrated "real-calibration-crash-recovery"
$RealCalibrationIntegrityGeneration = Get-Check $Integrated "real-calibration-integrity-generation"
$UiSmoke = Get-Check $Integrated "ui-smoke"
$ShortStability = Get-Check $Integrated "short-stability"
$BarSurface = Get-Check $Integrated "bar-surface-e2e"

$ShortCycles = @($ShortStability.summary.cycles)
$LastShortCycle = if ($ShortCycles.Count -gt 0) { $ShortCycles[-1] } else { $null }
$ShortTotals = $ShortStability.summary.totals
$BarSummary = $BarSurface.summary
$BarManifestPath = [string]$BarSummary.algorithm.manifestPath
$BarManifest = if ($BarManifestPath -and (Test-Path $BarManifestPath -PathType Leaf)) { Read-JsonFile $BarManifestPath } else { $null }

$Architecture = [ordered]@{
  requested = [bool]$RunArchitectureCheck
  ok = $null
  outputTail = @()
  note = "Run scripts/verify-independent-architecture.ps1 for the formal headless boundary check; add -CheckQt only when validating the optional diagnostic viewer."
}

$Items = [System.Collections.Generic.List[object]]::new()

$CoverageOk = $Integrated.code -eq 0 -and $Integrated.coverage.full -eq $true -and [int]$Integrated.coverage.covered -eq [int]$Integrated.coverage.required -and @($Integrated.coverage.uncovered).Count -eq 0
$PackageManifestPath = Join-Path $PackageRoot "manifest.json"
$PackageFilesOk = (Test-Path (Join-Path $TargetRuntimeRoot "manifest.json") -PathType Leaf) -and (Test-Path $PackageManifestPath -PathType Leaf)
$PackageManifest = if (Test-Path $PackageManifestPath -PathType Leaf) { Read-JsonFile $PackageManifestPath } else { $null }
Add-AuditItem $Items "ICM-01" "Runtime package contains the headless C++ capture provider, Rust service, trigger gateway, frontend client, config, launch scripts, and acceptance scripts." ($RuntimeLayout.ok -eq $true -and $PackageFilesOk) @($IntegratedReportPath, (Join-Path $TargetRuntimeRoot "manifest.json"), $PackageManifestPath) @{
  runtimeLayoutOk = $RuntimeLayout.ok
  runtimeRootExists = (Test-Path $TargetRuntimeRoot -PathType Container)
  packageRootExists = (Test-Path $PackageRoot -PathType Container)
}

$ArchitectureEvidencePath = if ($SourceMode) { Join-Path $RepoRoot "scripts\verify-independent-architecture.ps1" } else { Join-Path $RuntimeRoot "docs\independent-architecture.md" }
$ArchitectureEvidenceOk = (Test-Path $ArchitectureEvidencePath -PathType Leaf) -and $MatrixText.Contains("verify-independent-architecture.ps1")
Add-AuditItem $Items "ICM-02" "Runtime boundaries remain independent: client calls Rust only, trigger gateway forwards to Rust only, Rust does not link camera SDK, and exactly one capture provider owns SDK handles." $ArchitectureEvidenceOk @($ArchitectureEvidencePath, $MatrixPath) @{
  architectureCheckRun = [bool]$RunArchitectureCheck
  architectureCheckOk = $Architecture.ok
}

$LiveChecks = $LiveReady.summary.checks
$LiveOk = $LiveReady.ok -eq $true -and $LiveChecks.capture.sdkReady -eq $true -and [int]$LiveChecks.capture.cameraCount -eq $ExpectedCameras -and $LiveChecks.service.code -eq 0 -and $LiveChecks.network.rateFields -eq $true -and $LiveChecks.triggerGateway.code -eq 0 -and $LiveChecks.client.ok -eq $true
Add-AuditItem $Items "ICM-03" "Live stack is reachable: capture provider, Rust production API, trigger gateway, network monitor, and terminal client." $LiveOk @($IntegratedReportPath) @{
  serviceOrigin = $Integrated.origins.service
  networkInterfaces = $LiveChecks.network.interfaces
  totalUploadMbps = $LiveChecks.network.totalUploadMbps
  totalDownloadMbps = $LiveChecks.network.totalDownloadMbps
}

$Hw = $RealHardware.summary.checks
$StorageRoots = @($Hw.storage.cameraRoots)
$Readback = @($Hw.cameras.readback)
$HardwareOk = $RealHardware.ok -eq $true -and [int]$Hw.cameras.discovered -eq $ExpectedCameras -and [int]$Hw.cameras.connected -eq $ExpectedCameras -and (Test-All $StorageRoots { param($r) $r.mapped -eq $true -and $r.exists -eq $true -and $r.writable -eq $true })
Add-AuditItem $Items "ICM-04" "Six real cameras are discovered/connected through the LVM/NVT provider and H-drive camera roots are mapped and writable." $HardwareOk @($IntegratedReportPath) @{
  discovered = $Hw.cameras.discovered
  connected = $Hw.cameras.connected
  storageRoot = $Hw.storage.root
}

$ReadbackOk = [int]$Hw.config.cameraRootCount -eq $ExpectedCameras -and (Test-All $Readback { param($r) $r.connected -eq $true -and [int]$r.controlMode -eq 0 -and [int]$r.triggerInputType -eq 4 -and [int]$r.triggerLines -eq 1000 })
Add-AuditItem $Items "ICM-05" "Current camera configuration is read back from hardware without silently overwriting the operator's device configuration." $ReadbackOk @($IntegratedReportPath) @{
  activeProfile = $Hw.config.activeProfile
  readbackCount = $Readback.Count
  triggerInputType = @($Readback | Select-Object -ExpandProperty triggerInputType -Unique)
  triggerLines = @($Readback | Select-Object -ExpandProperty triggerLines -Unique)
}

$TriggerCoverage = Get-CoverageItem $Integrated "trigger-gateway-route"
$TriggerRouteOk = $TriggerCoverage.covered -eq $true -and (Test-All $ShortCycles { param($c) $c.triggerRoute.enabled -eq $true -and $c.triggerRoute.mode -eq "manual" })
Add-AuditItem $Items "ICM-06" "Trigger flow can enter through the standalone trigger gateway in manual mode and reach Rust production APIs." $TriggerRouteOk @($IntegratedReportPath) @{
  coverage = $TriggerCoverage.covered
  triggerMode = $LastShortCycle.triggerRoute.mode
}

$RecordBeforeCaptureOk = Test-All $ShortCycles { param($c) -not [string]::IsNullOrWhiteSpace([string]$c.sessionId) -and -not [string]::IsNullOrWhiteSpace([string]$c.inspectionId) -and $c.capture.code -eq 0 }
Add-AuditItem $Items "ICM-07" "Production steel-in writes the inspection/session record before capture starts." $RecordBeforeCaptureOk @($IntegratedReportPath) @{
  cycles = $ShortTotals.cycles
  lastSessionId = $LastShortCycle.sessionId
  lastInspectionId = $LastShortCycle.inspectionId
}

$ParallelOk = Test-All $ShortCycles { param($c) $c.capture.parallel -eq $true -and [int]$c.capture.workerCount -eq $ExpectedCameras -and [int]$c.capture.successes -eq $ExpectedCameras -and [int]$c.capture.completeFrames -eq $ExpectedCameras -and [int]$c.capture.metadataFrames -eq $ExpectedCameras }
Add-AuditItem $Items "ICM-08" "Capture uses parallel six-camera execution and produces complete frames for all cameras." $ParallelOk @($IntegratedReportPath) @{
  cycles = $ShortTotals.cycles
  captureFrames = $ShortTotals.captureFrames
  metadataFrames = $ShortTotals.metadataFrames
}

$LayoutOk = Test-All $ShortCycles {
  param($c)
  $Rows = @($c.layout)
  return $Rows.Count -eq $ExpectedCameras -and (Test-All $Rows { param($r) [string]$r.root -like "H:\camera*" -and [int]$r.depth -ge 1 -and [int]$r.intensity -ge 1 -and [int]$r.metadata -ge 1 -and $r.sdkDerivedExists -eq $false })
}
Add-AuditItem $Items "ICM-09" "Production storage writes depth, intensity, and metadata under H:\camera1..camera6\<material> and keeps sdk-derived disabled by default." $LayoutOk @($IntegratedReportPath) @{
  latestMaterial = $LastShortCycle.materialId
  latestRoots = @($LastShortCycle.layout | Select-Object -ExpandProperty root)
}

$SummaryOk = Test-All $ShortCycles { param($c) $c.summary.schema -eq "steel.production.summary.v1" -and [int]$c.summary.files -eq 18 -and [int]$c.summary.depth -eq $ExpectedCameras -and [int]$c.summary.intensity -eq $ExpectedCameras -and [int]$c.summary.metadata -eq $ExpectedCameras -and [int]$c.summary.sdkDerived -eq 0 -and (Test-Path ([string]$c.summary.path) -PathType Leaf) }
Add-AuditItem $Items "ICM-10" "Production summary is written under H:\production\<material>\<session>\summary.json and references all six-camera files." $SummaryOk @($IntegratedReportPath, [string]$LastShortCycle.summary.path) @{
  latestSummary = $LastShortCycle.summary.path
  latestFiles = $LastShortCycle.summary.files
}

$SteelOutOk = Test-All $ShortCycles { param($c) $null -eq $c.postStatus.activeSession -and [int]$c.postStatus.captureCount -eq $ExpectedCameras }
Add-AuditItem $Items "ICM-11" "Steel-out ends the session and clears active capture/save state." $SteelOutOk @($IntegratedReportPath) @{
  latestPostStatus = $LastShortCycle.postStatus
}

$UiPages = @($UiSmoke.summary.pages)
$UiOk = $UiSmoke.ok -eq $true -and $UiPages.Count -ge 3 -and (Test-All $UiPages { param($p) $p.ok -eq $true })
Add-AuditItem $Items "ICM-12" "Terminal UI, capture management UI, and 3D reconstruction UI render and expose key controls." $UiOk @($IntegratedReportPath) @{
  pages = @($UiPages | Select-Object -ExpandProperty id)
}

$TerminalPage = @($UiPages | Where-Object { $_.id -eq "terminal" } | Select-Object -First 1)[0]
$TerminalText = [string]$TerminalPage.textSample
$UiSmokeScriptPath = if ($SourceMode) { Join-Path $RepoRoot "scripts\test-runtime-ui-smoke.ps1" } else { Join-Path $RuntimeRoot "test-runtime-ui-smoke.ps1" }
$UiSmokeScript = Get-Content -Raw -LiteralPath $UiSmokeScriptPath
$RealtimeUploadText = TextFromCodePoints @(0x5b9e, 0x65f6, 0x4e0a, 0x4f20)
$RealtimeDownloadText = TextFromCodePoints @(0x5b9e, 0x65f6, 0x4e0b, 0x8f7d)
$BandwidthMonitorText = TextFromCodePoints @(0x5e26, 0x5bbd, 0x76d1, 0x63a7)
$WindowsNetworkRateText = "Windows " + (TextFromCodePoints @(0x7f51, 0x5361, 0x5b9e, 0x65f6, 0x6536, 0x53d1, 0x901f, 0x7387))
$EstimatedSpeedText = TextFromCodePoints @(0x4f30, 0x7b97, 0x7f51, 0x901f)
$NetworkUiOk = $UiOk -and $TerminalText.Contains($RealtimeUploadText) -and $TerminalText.Contains($RealtimeDownloadText) -and $TerminalText.Contains($BandwidthMonitorText) -and $TerminalText.Contains($WindowsNetworkRateText) -and -not $TerminalText.Contains($EstimatedSpeedText) -and $UiSmokeScript.Contains("\u4f30\u7b97\u7f51\u901f")
Add-AuditItem $Items "ICM-13" "Receiver network popover shows monitoring-only realtime upload, realtime download, and bandwidth fields, with no limiting controls or estimated-speed fallback." $NetworkUiOk @($IntegratedReportPath, $UiSmokeScriptPath) @{
  textSampleHasRealtimeUpload = $TerminalText.Contains($RealtimeUploadText)
  textSampleHasRealtimeDownload = $TerminalText.Contains($RealtimeDownloadText)
  textSampleHasEstimatedSpeedFallback = $TerminalText.Contains($EstimatedSpeedText)
}

$BarLatestOk = $BarSurface.ok -eq $true -and $BarSummary.materialId -eq $LastShortCycle.materialId -and [int]$BarSummary.capture.successes -eq $ExpectedCameras -and [int]$BarSummary.capture.completeFrames -eq $ExpectedCameras
Add-AuditItem $Items "ICM-14" "Latest six-camera production capture can be consumed by the bar-surface reconstruction API." $BarLatestOk @($IntegratedReportPath, $BarManifestPath) @{
  materialId = $BarSummary.materialId
  captureSuccesses = $BarSummary.capture.successes
}

$ArtifactsOk = $BarSummary.algorithm.acceptanceStatus -eq "pass" -and [int64]$BarSummary.algorithm.coreBytes -gt 0 -and (Test-Path ([string]$BarSummary.algorithm.acceptanceReport) -PathType Leaf) -and (Test-Path ([string]$BarSummary.algorithm.artifactIndex) -PathType Leaf) -and $BarManifest -ne $null -and [int]$BarManifest.mesh.vertexCount -gt 0 -and [int]$BarManifest.mesh.triangleCount -gt 0 -and (Test-Path ([string]$BarManifest.mesh.texture) -PathType Leaf)
Add-AuditItem $Items "ICM-15" "3D reconstruction outputs mesh, texture, artifact index, acceptance report, and C++ core binary output." $ArtifactsOk @($IntegratedReportPath, $BarManifestPath, [string]$BarSummary.algorithm.artifactIndex, [string]$BarSummary.algorithm.acceptanceReport) @{
  vertices = $BarManifest.mesh.vertexCount
  triangles = $BarManifest.mesh.triangleCount
  coreBytes = $BarSummary.algorithm.coreBytes
}

$ContourOk = $BarSummary.algorithm.contourCrop.applied -eq $true -and $BarSummary.algorithm.contourCrop.source -eq "calibrated-3d" -and $BarManifest.inputCrop.source -eq "calibrated-3d-contour" -and [int]$BarManifest.calibration.matchedCameras -eq $ExpectedCameras
Add-AuditItem $Items "ICM-16" "3D contour crop is applied from calibrated 3D data, not a static image-only preview." $ContourOk @($IntegratedReportPath, $BarManifestPath) @{
  contourSource = $BarSummary.algorithm.contourCrop.source
  inputCropSource = $BarManifest.inputCrop.source
  matchedCameras = $BarManifest.calibration.matchedCameras
}

$HeadlessCaptureExe = Join-Path $PackageRoot "capture-headless\steel_capture_service.exe"
$HeadlessCaptureSdk = Join-Path $PackageRoot "capture-headless\nvt_lvm_sdk.dll"
$IsTargetRuntimeManifest = $PackageManifest -ne $null -and -not [string]::IsNullOrWhiteSpace([string]$PackageManifest.captureHeadless)
$CaptureRole = if ($IsTargetRuntimeManifest) { [string]$PackageManifest.captureRole } else { [string]$PackageManifest.capture.role }
$FormalCaptureOk = $PackageManifest -ne $null -and [string]$PackageManifest.formalCapture -eq "headless-cpp" -and $CaptureRole -eq "formal-sdk-owner" -and (Test-Path $HeadlessCaptureExe -PathType Leaf) -and (Test-Path $HeadlessCaptureSdk -PathType Leaf)
$QtPackageDir = Join-Path $PackageRoot "capture-qt"
$QtDeclared = if ($IsTargetRuntimeManifest) {
  -not [string]::IsNullOrWhiteSpace([string]$PackageManifest.captureQt)
} else {
  $PackageManifest -ne $null -and $null -ne $PackageManifest.captureQt
}
$QtRole = if ($IsTargetRuntimeManifest) { [string]$PackageManifest.captureQtRole } else { [string]$PackageManifest.captureQt.role }
$QtOwnsApi = if ($IsTargetRuntimeManifest) { $PackageManifest.captureQtOwnsApi } else { $PackageManifest.captureQt.ownsApi }
$QtFormalRuntime = if ($IsTargetRuntimeManifest) { $PackageManifest.captureQtFormalRuntime } else { $PackageManifest.captureQt.formalRuntime }
$QtDiagnosticOk = -not $QtDeclared -or (
  $QtRole -eq "diagnostic-only" -and
  $QtOwnsApi -eq $false -and
  $QtFormalRuntime -eq $false -and
  (Test-Path (Join-Path $QtPackageDir "steel_capture_qt_terminal.exe") -PathType Leaf) -and
  (Test-Path (Join-Path $QtPackageDir "Qt6Core.dll") -PathType Leaf) -and
  (Test-Path (Join-Path $QtPackageDir "Qt6Widgets.dll") -PathType Leaf)
)
Add-AuditItem $Items "ICM-17" "The headless C++ provider is the formal SDK owner; Qt is absent by default or packaged only as a non-owning diagnostic viewer." ($FormalCaptureOk -and $QtDiagnosticOk) @($IntegratedReportPath, $PackageManifestPath, $HeadlessCaptureExe, $HeadlessCaptureSdk) @{
  formalCapture = if ($PackageManifest) { $PackageManifest.formalCapture } else { $null }
  captureRole = $CaptureRole
  qtDeclared = $QtDeclared
  qtRole = if ($QtDeclared) { $QtRole } else { $null }
  qtPackageDir = if ($QtDeclared) { $QtPackageDir } else { $null }
}

$FullScriptPath = if ($SourceMode) { Join-Path $RepoRoot "scripts\test-integrated-capture-management-full.ps1" } else { Join-Path $RuntimeRoot "test-integrated-capture-management-full.ps1" }
$LayoutScriptPath = if ($SourceMode) { Join-Path $RepoRoot "scripts\test-runtime-layout.ps1" } else { Join-Path $RuntimeRoot "test-runtime-layout.ps1" }
$FullScript = Get-Content -Raw -LiteralPath $FullScriptPath
$LayoutScript = Get-Content -Raw -LiteralPath $LayoutScriptPath
$GateOk = $CoverageOk -and $FullScript.Contains("RequireFullCoverage") -and $FullScript.Contains("trigger-gateway-route") -and $LayoutScript.Contains("RequireFullCoverage") -and $LayoutScript.Contains("coverage.required")
Add-AuditItem $Items "ICM-18" "The full coverage acceptance command is shipped in the package and cannot silently lose coverage checks." $GateOk @($IntegratedReportPath, $FullScriptPath, $LayoutScriptPath) @{
  coverageFull = $Integrated.coverage.full
  covered = $Integrated.coverage.covered
  required = $Integrated.coverage.required
}

$MigrationArchitecture = if ($PackageManifest) { $PackageManifest.migrationArchitecture } else { $null }
$MigrationArchitectureTestRelative = if ($IsTargetRuntimeManifest) {
  [string]$PackageManifest.migrationArchitectureTest
} else {
  [string]$PackageManifest.scripts.migrationArchitectureTest
}
if ($MigrationArchitectureTestRelative -and
    [System.IO.Path]::GetFileName($MigrationArchitectureTestRelative) -ne "test-architecture-migration-contract.ps1") {
  throw "Runtime manifest points to an unexpected architecture migration contract script: $MigrationArchitectureTestRelative"
}
$MigrationArchitectureTestPath = if ([string]::IsNullOrWhiteSpace($MigrationArchitectureTestRelative)) {
  ""
} else {
  Join-Path $PackageRoot ($MigrationArchitectureTestRelative -replace "/", "\")
}
$MigrationContractVerified = $false
$MigrationContractError = $null
if ($MigrationArchitectureTestPath -and (Test-Path $MigrationArchitectureTestPath -PathType Leaf)) {
  try {
    $MigrationContractReportText = (& $MigrationArchitectureTestPath -ManifestPath $PackageManifestPath | Out-String)
    $MigrationContractReport = $MigrationContractReportText | ConvertFrom-Json
    $MigrationContractVerified = $MigrationContractReport.code -eq 0
  } catch {
    $MigrationContractError = $_.Exception.Message
  }
}

$ExpectedTaskKinds = @("capture-once", "algorithm-run", "steel-info", "steel-in", "steel-out", "trigger-event")
$ExpectedTaskRoutes = @("/api/production/tasks", "/api/production/tasks/steel-info", "/api/production/tasks/steel-in", "/api/production/tasks/steel-out", "/api/production/tasks/trigger-event")
$DurableTasksOk = $MigrationContractVerified -and $MigrationArchitecture.durableTasks.persistent -eq $true -and (Test-ExactStringSet @($MigrationArchitecture.durableTasks.kinds) $ExpectedTaskKinds) -and (Test-ExactStringSet @($MigrationArchitecture.durableTasks.routes) $ExpectedTaskRoutes) -and $MigrationArchitecture.durableTasks.fifo -eq $true -and $MigrationArchitecture.durableTasks.restartRecovery -eq $true
Add-AuditItem $Items "ICM-19" "Rust exposes a persistent FIFO production task worker for capture-once, algorithm-run, steel-info, steel-in, steel-out, and trigger-event." $DurableTasksOk @($PackageManifestPath, $MigrationArchitectureTestPath) @{
  kinds = @($MigrationArchitecture.durableTasks.kinds)
  routes = @($MigrationArchitecture.durableTasks.routes)
  contractVerified = $MigrationContractVerified
  contractError = $MigrationContractError
}

$ExpectedTriggerMappings = @("steel-info=>/api/production/tasks/steel-info", "steel-in=>/api/production/tasks/steel-in", "steel-out=>/api/production/tasks/steel-out", "trigger-event=>/api/production/tasks/trigger-event")
$ExpectedFrontendTaskRoutes = @("/api/production/tasks", "/api/production/tasks/steel-info", "/api/production/tasks/steel-in", "/api/production/tasks/steel-out")
$DurableDispatchOk = $MigrationContractVerified -and (Test-ExactStringSet @($MigrationArchitecture.dispatch.triggerMappings) $ExpectedTriggerMappings) -and (Test-ExactStringSet @($MigrationArchitecture.dispatch.frontendTaskRoutes) $ExpectedFrontendTaskRoutes) -and $MigrationArchitecture.dispatch.preservesCallerRequestId -eq $true -and $MigrationArchitecture.dispatch.serviceUsesRequestIdForIdempotency -eq $true
Add-AuditItem $Items "ICM-20" "Trigger gateway and Tauri dispatch production commands to durable Rust task routes while preserving a stable caller requestId for idempotency." $DurableDispatchOk @($PackageManifestPath, $MigrationArchitectureTestPath) @{
  triggerMappings = @($MigrationArchitecture.dispatch.triggerMappings)
  frontendTaskRoutes = @($MigrationArchitecture.dispatch.frontendTaskRoutes)
  preservesCallerRequestId = $MigrationArchitecture.dispatch.preservesCallerRequestId
}

$ReadyScriptPath = if ($SourceMode) { Join-Path $RepoRoot "scripts\test-integrated-runtime-ready.ps1" } else { Join-Path $RuntimeRoot "test-integrated-runtime-ready.ps1" }
$ReadyScriptText = if (Test-Path $ReadyScriptPath -PathType Leaf) { Get-Content -LiteralPath $ReadyScriptPath -Raw } else { "" }
$ExpectedReadinessComponents = @("database", "taskWorker", "capture", "calibrationReconciliation", "storage", "trigger")
$ReadyScriptWired = $ReadyScriptText.Contains("/api/health/details") -and (Test-All $ExpectedReadinessComponents { param($Component) $ReadyScriptText.Contains($Component) }) -and $ReadyScriptText.Contains("trigger.required")
$LayeredReadinessOk = $MigrationContractVerified -and [string]$MigrationArchitecture.readiness.route -eq "/api/health/details" -and (Test-ExactStringSet @($MigrationArchitecture.readiness.components) $ExpectedReadinessComponents) -and [string]$MigrationArchitecture.readiness.storageEndpoint -eq "/api/storage/status" -and [string]$MigrationArchitecture.readiness.triggerEndpoint -eq "/api/trigger/status" -and $MigrationArchitecture.readiness.triggerRequiredByDefault -eq $true -and $ReadyScriptWired
Add-AuditItem $Items "ICM-21" "Layered Rust readiness gates on database, task worker, capture, calibration reconciliation, storage, and required-by-default trigger health, and the live-ready test verifies every layer." $LayeredReadinessOk @($PackageManifestPath, $MigrationArchitectureTestPath, $ReadyScriptPath) @{
  route = $MigrationArchitecture.readiness.route
  components = @($MigrationArchitecture.readiness.components)
  triggerRequiredByDefault = $MigrationArchitecture.readiness.triggerRequiredByDefault
  liveReportContainsLayeredReadiness = $null -ne $LiveChecks.readiness
}

$ExpectedAlarmRoutes = @("GET /api/alarms", "POST /api/alarms/acknowledge", "POST /api/alarms/resolve")
$ExpectedAlarmLifecycle = @("active", "acknowledged", "resolved")
$ExpectedAlarmStatuses = @("open", "active", "acknowledged", "resolved", "history", "all")
$PersistentAlarmOk = $MigrationContractVerified -and $MigrationArchitecture.alarms.persistent -eq $true -and (Test-ExactStringSet @($MigrationArchitecture.alarms.apiRoutes) $ExpectedAlarmRoutes) -and (Test-ExactStringSet @($MigrationArchitecture.alarms.lifecycle) $ExpectedAlarmLifecycle) -and (Test-ExactStringSet @($MigrationArchitecture.alarms.listStatuses) $ExpectedAlarmStatuses) -and $MigrationArchitecture.alarms.defectIngestTransactional -eq $true -and [string]$MigrationArchitecture.alarms.frontendEntry -eq "AlarmCenter" -and $MigrationArchitecture.alarms.serverOwnedActor -eq $true
Add-AuditItem $Items "ICM-22" "Persistent alarms have open/history APIs and an audited active-to-acknowledged-to-resolved state machine exposed through the Tauri alarm center." $PersistentAlarmOk @($PackageManifestPath, $MigrationArchitectureTestPath) @{
  apiRoutes = @($MigrationArchitecture.alarms.apiRoutes)
  lifecycle = @($MigrationArchitecture.alarms.lifecycle)
  listStatuses = @($MigrationArchitecture.alarms.listStatuses)
  frontendEntry = $MigrationArchitecture.alarms.frontendEntry
  serverOwnedActor = $MigrationArchitecture.alarms.serverOwnedActor
}

$ExpectedCalibrationMutationRoutes = @(
  "POST /api/calibration/apply-all",
  "POST /api/calibration/rollback"
)
$CalibrationOperations = $MigrationArchitecture.calibrationOperations
$CalibrationSoftwareContractOk =
  $null -ne $CalibrationOperations -and
  $CalibrationOperations.persistent -eq $true -and
  (Test-ExactStringSet @($CalibrationOperations.mutationRoutes) $ExpectedCalibrationMutationRoutes) -and
  [string]$CalibrationOperations.detailRoute -eq "GET /api/calibration/operations/detail" -and
  [string]$CalibrationOperations.idempotencyKey -eq "operationId" -and
  [string]$CalibrationOperations.interruptedStatus -eq "needs-reconciliation" -and
  [string]$CalibrationOperations.reconciledStatus -eq "reconciled" -and
  $CalibrationOperations.automaticReplay -eq $false -and
  $CalibrationOperations.dryRunPersisted -eq $false -and
  $CalibrationOperations.persistentMutationFence -eq $true -and
  [string]$CalibrationOperations.recoveryParentField -eq "parentOperationId" -and
  [string]$CalibrationOperations.recoveryOutcome -eq "restored-to-staged-baseline" -and
  (Test-ExactStringSet @($CalibrationOperations.rollbackEvidence) @("complete", "applyOperationId")) -and
  [string]$CalibrationOperations.providerRollbackTokenDurability -eq "cross-restart-file-only" -and
  [string]$CalibrationOperations.providerRollbackFileFingerprint -eq "sha256+size" -and
  [string]$CalibrationOperations.providerRollbackManifest -eq "atomic-write-ahead-v1" -and
  $CalibrationOperations.providerStagedPreviousFiles -eq $true -and
  $CalibrationOperations.providerRecoveryFence -eq $true -and
  [string]$CalibrationOperations.realHardwareAcceptanceScript -eq "test-real-calibration-acceptance.ps1" -and
  $CalibrationOperations.realHardwareApplyRollbackRequiredForFullCoverage -eq $true -and
  [string]$CalibrationOperations.realHardwareCrashRecoveryScript -eq "test-real-calibration-crash-recovery.ps1" -and
  $CalibrationOperations.realHardwareCrashRecoveryRequiredForFullCoverage -eq $true -and
  [string]$CalibrationOperations.providerCrashFailpoint -eq "explicit-env-operation-phase-camera-bound-v1" -and
  [string]$CalibrationOperations.realHardwareIntegrityGenerationScript -eq "test-real-calibration-integrity-generation.ps1" -and
  $CalibrationOperations.realHardwareIntegrityGenerationRequiredForFullCoverage -eq $true -and
  (Test-ExactStringSet @($CalibrationOperations.decisiveRollbackPreflightEvidence) @("attempted", "sideEffects")) -and
  $CalibrationOperations.processCrashFaultInjectionSeparate -eq $true -and
  [int]$CalibrationOperations.requiredCameraCount -eq 6 -and
  $CalibrationOperations.uniqueCameraIps -eq $true -and
  $CalibrationOperations.uniqueExpectedSerials -eq $true -and
  $CalibrationOperations.uniqueSdkCalibrationPaths -eq $true -and
  $CalibrationOperations.arrayArtifactAsSdkCalibrationAllowed -eq $false
$RealCalibrationSummary = $RealCalibration.summary
$RealCalibrationOk =
  $RealCalibration.ok -eq $true -and
  $RealCalibration.skipped -eq $false -and
  [string]$RealCalibrationSummary.schema -eq "steel.real-calibration.acceptance.v1" -and
  [string]$RealCalibrationSummary.mode -eq "apply-rollback" -and
  [int]$RealCalibrationSummary.code -eq 0 -and
  [int]$RealCalibrationSummary.apply.applied -eq $ExpectedCameras -and
  $RealCalibrationSummary.rollback.complete -eq $true -and
  [int]$RealCalibrationSummary.rollback.rolledBack -eq $ExpectedCameras -and
  [int]$RealCalibrationSummary.validationCapture.completeFrames -eq $ExpectedCameras -and
  [int]$RealCalibrationSummary.validationCapture.metadataFrames -eq $ExpectedCameras -and
  $RealCalibrationSummary.healthAfterRollback.checks.calibrationReconciliation.healthy -eq $true
$ApplyCrashSummary = $RealCalibrationCrashRecovery.summary.applyCrash
$RollbackCrashSummary = $RealCalibrationCrashRecovery.summary.rollbackCrash
$RealCalibrationCrashRecoveryOk =
  $RealCalibrationCrashRecovery.ok -eq $true -and
  $RealCalibrationCrashRecovery.skipped -eq $false -and
  [string]$ApplyCrashSummary.schema -eq "steel.real-calibration.crash-recovery.v1" -and
  [string]$ApplyCrashSummary.scenario -eq "ApplyCrash" -and
  [string]$ApplyCrashSummary.mode -eq "Resume" -and
  [int]$ApplyCrashSummary.code -eq 0 -and
  [string]$RollbackCrashSummary.schema -eq "steel.real-calibration.crash-recovery.v1" -and
  [string]$RollbackCrashSummary.scenario -eq "RollbackCrash" -and
  [string]$RollbackCrashSummary.mode -eq "Resume" -and
  [int]$RollbackCrashSummary.code -eq 0
$IntegrityGenerationSummary = $RealCalibrationIntegrityGeneration.summary
$RealCalibrationIntegrityGenerationOk =
  $RealCalibrationIntegrityGeneration.ok -eq $true -and
  $RealCalibrationIntegrityGeneration.skipped -eq $false -and
  [string]$IntegrityGenerationSummary.schema -eq "steel.real-calibration.integrity-generation.v1" -and
  [int]$IntegrityGenerationSummary.code -eq 0 -and
  $IntegrityGenerationSummary.evidence.staleGeneration.zeroWriteEvidence -eq $true -and
  $IntegrityGenerationSummary.evidence.stagedTamper.zeroWriteEvidence -eq $true -and
  $IntegrityGenerationSummary.evidence.recovery.complete -eq $true
$CalibrationOperationsOk = $CalibrationSoftwareContractOk -and $RealCalibrationOk -and $RealCalibrationCrashRecoveryOk -and $RealCalibrationIntegrityGenerationOk
Add-AuditItem $Items "ICM-23" "Calibration apply and rollback use a persistent operationId ledger, a readiness/device-write fence, parent-bound recovery, staged cross-restart rollback material, and six distinct camera SDK mappings without automatic replay; real hardware apply/rollback must also finish with six validation frames." $CalibrationOperationsOk @($PackageManifestPath, $MigrationArchitectureTestPath, $IntegratedReportPath) @{
  softwareContract = $CalibrationSoftwareContractOk
  realHardwareApplyRollback = $RealCalibrationOk
  realHardwareCrashRecovery = $RealCalibrationCrashRecoveryOk
  realHardwareIntegrityGeneration = $RealCalibrationIntegrityGenerationOk
  realHardwareReportMode = $RealCalibrationSummary.mode
  persistent = $CalibrationOperations.persistent
  mutationRoutes = @($CalibrationOperations.mutationRoutes)
  detailRoute = $CalibrationOperations.detailRoute
  idempotencyKey = $CalibrationOperations.idempotencyKey
  interruptedStatus = $CalibrationOperations.interruptedStatus
  reconciledStatus = $CalibrationOperations.reconciledStatus
  automaticReplay = $CalibrationOperations.automaticReplay
  dryRunPersisted = $CalibrationOperations.dryRunPersisted
  persistentMutationFence = $CalibrationOperations.persistentMutationFence
  recoveryParentField = $CalibrationOperations.recoveryParentField
  recoveryOutcome = $CalibrationOperations.recoveryOutcome
  rollbackEvidence = @($CalibrationOperations.rollbackEvidence)
  providerRollbackTokenDurability = $CalibrationOperations.providerRollbackTokenDurability
  providerRollbackFileFingerprint = $CalibrationOperations.providerRollbackFileFingerprint
  providerRollbackManifest = $CalibrationOperations.providerRollbackManifest
  providerStagedPreviousFiles = $CalibrationOperations.providerStagedPreviousFiles
  providerRecoveryFence = $CalibrationOperations.providerRecoveryFence
  realHardwareAcceptanceScript = $CalibrationOperations.realHardwareAcceptanceScript
  realHardwareApplyRollbackRequiredForFullCoverage = $CalibrationOperations.realHardwareApplyRollbackRequiredForFullCoverage
  realHardwareCrashRecoveryScript = $CalibrationOperations.realHardwareCrashRecoveryScript
  realHardwareCrashRecoveryRequiredForFullCoverage = $CalibrationOperations.realHardwareCrashRecoveryRequiredForFullCoverage
  providerCrashFailpoint = $CalibrationOperations.providerCrashFailpoint
  realHardwareIntegrityGenerationScript = $CalibrationOperations.realHardwareIntegrityGenerationScript
  realHardwareIntegrityGenerationRequiredForFullCoverage = $CalibrationOperations.realHardwareIntegrityGenerationRequiredForFullCoverage
  decisiveRollbackPreflightEvidence = @($CalibrationOperations.decisiveRollbackPreflightEvidence)
  processCrashFaultInjectionSeparate = $CalibrationOperations.processCrashFaultInjectionSeparate
  requiredCameraCount = $CalibrationOperations.requiredCameraCount
  uniqueCameraIps = $CalibrationOperations.uniqueCameraIps
  uniqueExpectedSerials = $CalibrationOperations.uniqueExpectedSerials
  uniqueSdkCalibrationPaths = $CalibrationOperations.uniqueSdkCalibrationPaths
  arrayArtifactAsSdkCalibrationAllowed = $CalibrationOperations.arrayArtifactAsSdkCalibrationAllowed
  contractVerified = $MigrationContractVerified
  contractError = $MigrationContractError
}

$EnduranceSummary = $null
if ($Endurance) {
  $EnduranceSummary = [ordered]@{
    reportPath = (Resolve-Path $TenMinuteReportPath).Path
    code = $Endurance.code
    cycles = $Endurance.totals.cycles
    okCycles = $Endurance.totals.okCycles
    failedCycles = $Endurance.totals.failedCycles
    captureFrames = $Endurance.totals.captureFrames
    metadataFrames = $Endurance.totals.metadataFrames
    firstMaterial = $Endurance.cycles[0].materialId
    latestMaterial = $Endurance.cycles[-1].materialId
    latestSummary = $Endurance.cycles[-1].summary.path
    sdkDerived = $Endurance.cycles[-1].summary.sdkDerived
  }
}

$PassedCount = @($Items | Where-Object { $_.passed }).Count
$RequiredCount = 23
$Report = [ordered]@{
  schema = "steel.integrated-capture-management.acceptance-audit.v1"
  code = if ($PassedCount -eq $RequiredCount) { 0 } else { 1 }
  checkedAt = (Get-Date).ToString("o")
  expectedCameras = $ExpectedCameras
  integratedReportPath = (Resolve-Path $IntegratedReportPath).Path
  tenMinuteReportPath = if ($TenMinuteReportPath) { (Resolve-Path $TenMinuteReportPath).Path } else { $null }
  architecture = $Architecture
  summary = [ordered]@{
    passed = $PassedCount
    required = $RequiredCount
    failed = $RequiredCount - $PassedCount
    latestMaterial = $LastShortCycle.materialId
    latestBarSurfaceRun = $BarSummary.algorithm.runId
    endurance = $EnduranceSummary
  }
  items = $Items
  reportPath = $ReportPath
}

$Report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
$Report | ConvertTo-Json -Depth 20

if ($Report.code -ne 0) {
  exit 1
}
