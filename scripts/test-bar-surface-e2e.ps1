param(
  [string]$ServiceOrigin = "http://127.0.0.1:4873",
  [string]$MaterialId = "",
  [switch]$SkipCapture,
  [int]$ExpectedCameras = 8,
  [int]$Rounds = 1,
  [int]$Lines = 1000,
  [int]$TimeoutMs = 8000,
  [int]$IntervalMs = 500,
  [ValidateRange(0, 3)]
  [int]$Retries = 1,
  [int]$MaxFrames = 1,
  [int]$MeshRows = 72,
  [int]$MeshColsPerCamera = 48,
  [double]$MaxFaceEdgeMm = 8.0,
  [switch]$AllowDevelopmentThresholdOverrides,
  [switch]$AllowDevelopmentQualificationGaps,
  [string]$CaptureRoot = "",
  [string]$AlgorithmRoot = "",
  [string]$CalibrationPath = "",
  [string]$AdminToken = ""
)

$ErrorActionPreference = "Stop"

function New-MaterialId {
  return "BAR-E2E-" + (Get-Date -Format "yyyyMMdd-HHmmss")
}

function Invoke-Json {
  param(
    [ValidateSet("GET", "POST")]
    [string]$Method,
    [string]$Path,
    [object]$Body = $null,
    [int]$TimeoutSec = 30
  )

  $Uri = "$ServiceOrigin$Path"
  $Headers = @{}
  if (-not [string]::IsNullOrWhiteSpace($AdminToken)) {
    $Headers.Authorization = "Bearer $AdminToken"
  }
  if ($Method -eq "GET") {
    return Invoke-RestMethod -Method Get -Uri $Uri -Headers $Headers -TimeoutSec $TimeoutSec
  }

  $JsonBody = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Compress -Depth 20 }
  return Invoke-RestMethod -Method Post -Uri $Uri -Headers $Headers -ContentType "application/json" -Body $JsonBody -TimeoutSec $TimeoutSec
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

function Get-CaptureMaterial {
  param([string]$TargetMaterialId)
  $Captures = Invoke-Json -Method GET -Path "/api/algorithm/bar-surface/captures" -TimeoutSec 30
  return @($Captures.materials | Where-Object { $_.materialId -eq $TargetMaterialId } | Select-Object -First 1)[0]
}

function Test-CameraFolders {
  param(
    [string]$TargetMaterialId,
    [int]$CameraCount
  )
  $Rows = @()
  for ($Index = 1; $Index -le $CameraCount; $Index++) {
    $Root = Join-Path (Join-Path $CaptureRoot "camera$Index") $TargetMaterialId
    $Rows += [pscustomobject]@{
      camera = "camera$Index"
      root = $Root
      exists = Test-Path $Root -PathType Container
      depth = @(Get-ChildItem (Join-Path $Root "depth") -Filter *.png -ErrorAction SilentlyContinue).Count
      intensity = @(Get-ChildItem (Join-Path $Root "intensity") -Filter *.png -ErrorAction SilentlyContinue).Count
      metadata = @(Get-ChildItem (Join-Path $Root "metadata") -Filter *.json -ErrorAction SilentlyContinue).Count
      sdkDerived = Test-Path (Join-Path $Root "sdk-derived") -PathType Container
    }
  }
  return $Rows
}

if ($MaterialId.Trim().Length -eq 0) {
  $MaterialId = New-MaterialId
}

$Health = Invoke-Json -Method GET -Path "/api/services" -TimeoutSec 10
Assert-Condition ($Health.api.running -eq $true) "Rust service is not running at $ServiceOrigin."
Assert-Condition ($Health.capture.running -eq $true) "Capture provider is not running through $ServiceOrigin."
$RuntimeCaptures = Invoke-Json -Method GET -Path "/api/algorithm/bar-surface/captures" -TimeoutSec 30
$RuntimeRuns = Invoke-Json -Method GET -Path "/api/algorithm/bar-surface/runs" -TimeoutSec 30
$RuntimeConfiguration = if ($null -ne $RuntimeRuns.configuration) { $RuntimeRuns.configuration } else { $RuntimeCaptures.configuration }
if ([string]::IsNullOrWhiteSpace($CaptureRoot)) {
  $CaptureRoot = if ($null -ne $RuntimeConfiguration) { [string]$RuntimeConfiguration.active.captureRoot } else { [string]$RuntimeCaptures.captureRoot }
}
if ([string]::IsNullOrWhiteSpace($AlgorithmRoot)) {
  $AlgorithmRoot = if ($null -ne $RuntimeConfiguration) { [string]$RuntimeConfiguration.active.algorithmRoot } else { [string]$RuntimeRuns.root }
}
if ([string]::IsNullOrWhiteSpace($CalibrationPath) -and $null -ne $RuntimeConfiguration) {
  $CalibrationPath = [string]$RuntimeConfiguration.active.algorithmCalibration
}
Assert-Condition (-not [string]::IsNullOrWhiteSpace($CaptureRoot)) "service did not expose an active capture root."
Assert-Condition (-not [string]::IsNullOrWhiteSpace($AlgorithmRoot)) "service did not expose an active algorithm root."
if ($null -ne $RuntimeConfiguration) {
  Assert-Condition ($RuntimeConfiguration.readback.ready -eq $true) "algorithm runtime configuration readback is not ready."
  Assert-Condition ($RuntimeConfiguration.active.captureRoot -eq $CaptureRoot) "capture root does not match active service configuration."
  Assert-Condition ($RuntimeConfiguration.active.algorithmRoot -eq $AlgorithmRoot) "algorithm root does not match active service configuration."
}

$SteelIn = $null
$Capture = $null
$SteelOut = $null

try {
if (-not $SkipCapture) {
  $EventBody = @{
    materialId = $MaterialId
    source = "script-e2e"
    mode = "manual"
    triggerMode = "manual"
    acquisitionMode = "manual"
    autoCapture = $false
    discardBlackFrames = $true
    saveSdkDerived = $false
    steelType = "round-bar"
  }

  $SteelIn = Invoke-Json -Method POST -Path "/api/production/steel-in" -Body $EventBody -TimeoutSec 15
  Assert-Condition ($SteelIn.code -eq 0) "steel-in failed: code=$($SteelIn.code)"
  Assert-Condition ($SteelIn.flow.recordWrittenBeforeCapture -eq $true) "steel-in did not report record-before-capture."

  $CaptureBody = @{
    materialId = $MaterialId
    sessionId = $SteelIn.sessionId
    expectedCameras = $ExpectedCameras
    rounds = $Rounds
    lines = $Lines
    width = 0
    timeoutMs = $TimeoutMs
    intervalMs = $IntervalMs
    retries = $Retries
    controlMode = 0
    dataMode = 3
    connectFirst = $false
    stopStreams = $true
    productionLayout = $true
    steelStateAware = $true
    requireSteelPresent = $true
    discardBlackFrames = $true
    saveSdkDerived = $false
  }

  $Capture = Invoke-Json -Method POST -Path "/api/production/capture-once" -Body $CaptureBody -TimeoutSec ([Math]::Max(30, [int]($TimeoutMs / 1000 + 60)))
  $CaptureFailureDetail = @($Capture.provider.results | Where-Object { $_.code -ne 0 } | ForEach-Object {
    [ordered]@{
      ip = $_.ip
      code = $_.code
      errorName = $_.errorName
      attemptsUsed = $_.attemptsUsed
      operatorHint = $_.operatorHint
    }
  }) | ConvertTo-Json -Compress -Depth 4
  Assert-Condition ($Capture.code -eq 0) "capture-once failed: code=$($Capture.code); provider=$CaptureFailureDetail"
  Assert-Condition ($Capture.provider.code -eq 0) "capture provider failed: code=$($Capture.provider.code); provider=$CaptureFailureDetail"
  Assert-Condition ($Capture.provider.successes -eq $ExpectedCameras) "capture successes mismatch: $($Capture.provider.successes)/$ExpectedCameras"
  Assert-Condition ($Capture.provider.failures -eq 0) "capture failures detected: $($Capture.provider.failures)"
  Assert-Condition ($Capture.provider.completeFrames -ge $ExpectedCameras) "complete frame count too low: $($Capture.provider.completeFrames)"
  Assert-Condition ($Capture.provider.saveSdkDerived -eq $false) "saveSdkDerived must remain false."

}

$CaptureMaterial = Get-CaptureMaterial -TargetMaterialId $MaterialId
Assert-Condition ($null -ne $CaptureMaterial) "capture material not listed: $MaterialId"
Assert-Condition ($CaptureMaterial.cameraCount -eq $ExpectedCameras) "capture material camera count mismatch: $($CaptureMaterial.cameraCount)/$ExpectedCameras"
Assert-Condition ($CaptureMaterial.minDepthFrames -ge 1) "capture material has no depth frames."

$CameraRows = Test-CameraFolders -TargetMaterialId $MaterialId -CameraCount $ExpectedCameras
foreach ($Row in $CameraRows) {
  Assert-Condition ($Row.exists) "missing folder for $($Row.camera): $($Row.root)"
  Assert-Condition ($Row.depth -ge 1) "missing depth image for $($Row.camera)"
  Assert-Condition ($Row.intensity -ge 1) "missing intensity image for $($Row.camera)"
  Assert-Condition ($Row.metadata -ge 1) "missing metadata for $($Row.camera)"
  Assert-Condition ($Row.sdkDerived -eq $false) "unexpected sdk-derived folder for $($Row.camera)"
}

$AlgorithmBody = @{
  materialId = $MaterialId
  runCore = $true
}
if (-not [string]::IsNullOrWhiteSpace($CalibrationPath)) {
  Assert-Condition (Test-Path -LiteralPath $CalibrationPath -PathType Leaf) "configured algorithm calibration is missing: $CalibrationPath"
  $AlgorithmBody.calibrationPath = $CalibrationPath
}
if ($AllowDevelopmentThresholdOverrides) {
  $AlgorithmBody.maxFrames = $MaxFrames
  $AlgorithmBody.meshRows = $MeshRows
  $AlgorithmBody.meshColsPerCamera = $MeshColsPerCamera
  $AlgorithmBody.maxFaceEdgeMm = $MaxFaceEdgeMm
}
if ($SteelIn -and $SteelIn.sessionId) {
  $AlgorithmBody.sessionId = $SteelIn.sessionId
  $AlgorithmBody.inspectionId = $SteelIn.inspectionId
}

$Algorithm = Invoke-Json -Method POST -Path "/api/production/algorithm/run" -Body $AlgorithmBody -TimeoutSec 240
Assert-Condition ($Algorithm.code -eq 0) "algorithm API failed: code=$($Algorithm.code)"
Assert-Condition ($Algorithm.record.status -eq "algorithm-complete") "algorithm record status mismatch: $($Algorithm.record.status)"
if (-not $SkipCapture) {
  Assert-Condition ($Algorithm.record.captureCount -ge $ExpectedCameras) "algorithm record capture count too low: $($Algorithm.record.captureCount)"
}
Assert-Condition ($Algorithm.algorithm.result.manifest.cameraCount -eq $ExpectedCameras) "algorithm camera count mismatch."
Assert-Condition ($Algorithm.algorithm.result.manifest.core.available -eq $true) "C++ core bsmesh is not available."
Assert-Condition ($Algorithm.algorithm.result.manifest.core.summary.outputBytes -gt 0) "C++ core output is empty."
if (-not $SkipCapture) {
  Assert-Condition ($Algorithm.captureSummary.ok -eq $true) "algorithm did not update the production capture summary: $($Algorithm.captureSummary.error)"
  Assert-Condition ($Algorithm.captureSummary.status -eq "algorithm-complete") "capture summary algorithm status mismatch: $($Algorithm.captureSummary.status)"
  Assert-Condition (Test-Path ([string]$Algorithm.captureSummary.path) -PathType Leaf) "capture summary file missing after algorithm update: $($Algorithm.captureSummary.path)"
}

$Manifest = $Algorithm.algorithm.result.manifest
$RequiredManifestHashes = if ($AllowDevelopmentQualificationGaps) {
  @('configSha256', 'scriptSha256', 'inputSummarySha256')
} else {
  @(
    'configSha256', 'scriptSha256', 'coreSha256', 'acceptanceReportSha256',
    'datasetSha256', 'evaluatorSha256', 'calibrationSha256', 'inputSummarySha256'
  )
}
foreach ($HashField in $RequiredManifestHashes) {
  Assert-Condition ([string]$Manifest.$HashField -match '^[0-9a-f]{64}$') "manifest trace hash is invalid: $HashField"
}
if (-not $AllowDevelopmentQualificationGaps) {
  Assert-Condition ([string]$Manifest.releaseCommit -match '^[0-9a-f]{40,64}$') "manifest release commit is invalid."
}
Assert-Condition (-not [string]::IsNullOrWhiteSpace([string]$Manifest.algorithmVersion)) "manifest algorithm version missing."
Assert-Condition (-not [string]::IsNullOrWhiteSpace([string]$Manifest.configRevision)) "manifest config revision missing."
Assert-Condition ($Manifest.inputArtifactCount -eq @($Manifest.inputArtifacts).Count) "manifest input artifact count mismatch."
Assert-Condition ($Manifest.inputArtifactCount -gt 0) "manifest input artifact trace is empty."
if ($AllowDevelopmentQualificationGaps) {
  $AllowedQualificationReasons = @(
    'coreSha256_missing', 'acceptanceReportSha256_missing', 'datasetSha256_missing',
    'evaluatorSha256_missing', 'release_commit_missing', 'datasetRevision_missing',
    'evaluatorRevision_missing'
  )
  $UnexpectedQualityReasons = @($Manifest.qualityGate.reasons | Where-Object { $_ -notin $AllowedQualificationReasons })
  Assert-Condition ($UnexpectedQualityReasons.Count -eq 0) "development quality gate contains non-qualification failures: $($UnexpectedQualityReasons -join ', ')"
} else {
  Assert-Condition ($Manifest.qualityGate.passed -eq $true) "manifest production quality gate did not pass: $(@($Manifest.qualityGate.reasons) -join ', ')"
}
Assert-Condition ($Manifest.syntheticDefectCount -eq 0) "manifest contains synthetic defects."
$ManifestPath = $Algorithm.record.summaryPath
Assert-Condition (Test-Path $ManifestPath -PathType Leaf) "manifest file missing: $ManifestPath"
Assert-Condition (Test-Path $Manifest.mesh.texture -PathType Leaf) "texture file missing: $($Manifest.mesh.texture)"
Assert-Condition (Test-Path $Manifest.mesh.json -PathType Leaf) "mesh JSON file missing: $($Manifest.mesh.json)"
Assert-Condition ($null -ne $Manifest.reports) "manifest does not expose reports."

$AcceptanceReportPath = $Manifest.reports.acceptanceReport
$ArtifactIndexPath = $Manifest.reports.artifactIndex
Assert-Condition ([string]::IsNullOrWhiteSpace($AcceptanceReportPath) -eq $false) "acceptance report path missing from manifest."
Assert-Condition ([string]::IsNullOrWhiteSpace($ArtifactIndexPath) -eq $false) "artifact index path missing from manifest."
Assert-Condition (Test-Path $AcceptanceReportPath -PathType Leaf) "acceptance report missing: $AcceptanceReportPath"
Assert-Condition (Test-Path $ArtifactIndexPath -PathType Leaf) "artifact index missing: $ArtifactIndexPath"

$AcceptanceReport = Get-Content -Raw -Encoding UTF8 $AcceptanceReportPath | ConvertFrom-Json
$ArtifactIndex = Get-Content -Raw -Encoding UTF8 $ArtifactIndexPath | ConvertFrom-Json
Assert-Condition ($AcceptanceReport.status -eq "pass") "acceptance report status is not pass: $($AcceptanceReport.status)"
Assert-Condition ($AcceptanceReport.checks.eightCameras -eq $true) "acceptance report did not verify eight cameras."
Assert-Condition ($AcceptanceReport.checks.sdkDerivedDisabled -eq $true) "acceptance report found sdk-derived output."
Assert-Condition ($AcceptanceReport.checks.cameraCropUses3d -eq $true) "acceptance report did not verify 3D-based 2D crop."
Assert-Condition ($AcceptanceReport.checks.contourCropApplied -eq $true) "acceptance report did not verify 3D contour crop."
Assert-Condition ($AcceptanceReport.checks.contourCropUses3d -eq $true) "acceptance report did not verify 3D contour source."
Assert-Condition ($AcceptanceReport.frontendReadiness.cameraTiles -eq $ExpectedCameras) "frontend camera tile count mismatch in acceptance report."
Assert-Condition ($Manifest.acceptance.status -eq "pass") "manifest acceptance status is not pass: $($Manifest.acceptance.status)"
Assert-Condition ($Manifest.acceptance.frontendReady -eq $true) "manifest acceptance does not mark frontend as ready."
Assert-Condition ($Manifest.mesh.contourCrop.applied -eq $true) "manifest mesh contour crop was not applied."
Assert-Condition ($Manifest.quality.contourCrop.applied -eq $true) "quality contour crop was not applied."
Assert-Condition ($Manifest.inputCrop.applied -eq $true) "manifest input crop was not applied."
Assert-Condition ($Manifest.inputCrop.matchedCameras -eq $ExpectedCameras) "input crop did not match all cameras: $($Manifest.inputCrop.matchedCameras)/$ExpectedCameras"
Assert-Condition ($ArtifactIndex.totals.previewFiles -ge ($ExpectedCameras * 2)) "artifact index preview count too low."
Assert-Condition ($ArtifactIndex.totals.stripFiles -ge ($ExpectedCameras * 2)) "artifact index strip count too low."

$CorePath = Join-Path $AlgorithmRoot ($Manifest.core.binaryRelative -replace "/", "\")
Assert-Condition (Test-Path $CorePath -PathType Leaf) "core bsmesh file missing: $CorePath"

$ProductionSummaryPath = if (-not $SkipCapture) { [string]$Algorithm.captureSummary.path } else { "" }
if (-not $SkipCapture) {
  $ProductionSummary = Get-Content -Raw -Encoding UTF8 $ProductionSummaryPath | ConvertFrom-Json
  Assert-Condition ($ProductionSummary.schema -eq "steel.production.summary.v1") "production summary schema mismatch after algorithm: $($ProductionSummary.schema)"
  Assert-Condition ($ProductionSummary.inspection.status -eq "algorithm-complete") "production summary inspection status mismatch: $($ProductionSummary.inspection.status)"
  Assert-Condition ($ProductionSummary.inspection.captureSummaryPath -eq $ProductionSummaryPath) "production summary did not preserve captureSummaryPath."
  Assert-Condition ($ProductionSummary.inspection.algorithmSummaryPath -eq $ManifestPath) "production summary did not link algorithmSummaryPath."
  Assert-Condition ($ProductionSummary.algorithm.status -eq "algorithm-complete") "production summary algorithm status mismatch: $($ProductionSummary.algorithm.status)"
  Assert-Condition ($ProductionSummary.algorithm.acceptanceStatus -eq "pass") "production summary algorithm acceptance mismatch: $($ProductionSummary.algorithm.acceptanceStatus)"
  Assert-Condition ($ProductionSummary.algorithm.coreOutputBytes -gt 0) "production summary algorithm core output is empty."
  Assert-Condition ($ProductionSummary.algorithm.traceability.schema -eq 'steel.algorithm-traceability.v1') "production summary algorithm traceability schema mismatch."
  Assert-Condition ($ProductionSummary.algorithm.traceability.inputSummarySha256 -eq $Manifest.inputSummarySha256) "production summary input trace mismatch."
  Assert-Condition ($ProductionSummary.algorithm.traceability.acceptanceReportSha256 -eq $Manifest.acceptanceReportSha256) "production summary qualification trace mismatch."
  Assert-Condition ($ProductionSummary.algorithm.traceability.qualityGate.passed -eq $true) "production summary quality gate did not pass."
}

$ArchivedReport = $null
$ReportHistory = $null
if (-not [string]::IsNullOrWhiteSpace($AdminToken)) {
  $InspectionId = if ($SteelIn) { [string]$SteelIn.inspectionId } else { [string]$Algorithm.record.id }
  $ArchivedReport = Invoke-Json -Method POST -Path "/api/admin/records/reports" -Body @{ inspectionId = $InspectionId } -TimeoutSec 30
  Assert-Condition ($ArchivedReport.code -eq 0) "formal report issuance failed: code=$($ArchivedReport.code)"
  Assert-Condition ($ArchivedReport.archive.schema -eq 'steel.inspection.report-archive.v1') "formal report archive schema mismatch."
  Assert-Condition ($ArchivedReport.archive.inspectionId -eq $InspectionId) "formal report inspection binding mismatch."
  Assert-Condition ([string]$ArchivedReport.archive.documentSha256 -match '^[0-9a-f]{64}$') "formal report document hash is invalid."
  $ReportHistory = Invoke-Json -Method GET -Path "/api/admin/records/reports?inspectionId=$([uri]::EscapeDataString($InspectionId))" -TimeoutSec 30
  Assert-Condition (@($ReportHistory.reports | Where-Object { $_.reportId -eq $ArchivedReport.reportId }).Count -eq 1) "formal report history does not contain the issued report."
}

if (-not $SkipCapture) {
  $SteelOut = Invoke-Json -Method POST -Path "/api/production/steel-out" -Body $EventBody -TimeoutSec 15
  Assert-Condition ($SteelOut.code -eq 0) "steel-out failed: code=$($SteelOut.code)"
}

$Status = Invoke-Json -Method GET -Path "/api/production/status" -TimeoutSec 15
$Latest = Invoke-Json -Method GET -Path "/api/algorithm/bar-surface/latest" -TimeoutSec 30
Assert-Condition ($Latest.manifest.materialId -eq $MaterialId) "latest algorithm material mismatch: $($Latest.manifest.materialId)"
Assert-Condition ($Latest.manifest.core.available -eq $true) "latest algorithm result does not expose core bsmesh."
if (-not $SkipCapture) {
  Assert-Condition ($Status.latestInspection.captureSummaryPath -eq $ProductionSummaryPath) "production status did not expose captureSummaryPath."
}

$Summary = [ordered]@{
  code = 0
  materialId = $MaterialId
  sessionId = if ($SteelIn) { $SteelIn.sessionId } else { $null }
  inspectionId = if ($SteelIn) { $SteelIn.inspectionId } else { $Status.latestInspection.id }
  capture = [ordered]@{
    skipped = [bool]$SkipCapture
    successes = if ($Capture) { $Capture.provider.successes } else { $CaptureMaterial.cameraCount }
    completeFrames = if ($Capture) { $Capture.provider.completeFrames } else { $CaptureMaterial.minDepthFrames * $ExpectedCameras }
    fileRows = if ($Capture) { $Capture.record.captureFileRows } else { $null }
    sdkDerived = $false
    cameraFolders = $CameraRows
  }
  algorithm = [ordered]@{
    runId = $Manifest.runId
    manifestPath = $ManifestPath
    cameraCount = $Manifest.cameraCount
    frameCount = $Manifest.mesh.frameCount
    vertexCount = $Manifest.mesh.vertexCount
    triangleCount = $Manifest.mesh.triangleCount
    coreBinary = $CorePath
    coreBytes = $Manifest.core.summary.outputBytes
    captureSummary = $ProductionSummaryPath
    acceptanceReport = $AcceptanceReportPath
    artifactIndex = $ArtifactIndexPath
    acceptanceStatus = $AcceptanceReport.status
    contourCrop = $Manifest.mesh.contourCrop
    qualificationMode = if ($AllowDevelopmentQualificationGaps) { 'development-functional' } else { 'production-strict' }
  }
  formalReport = [ordered]@{
    skipped = [string]::IsNullOrWhiteSpace($AdminToken)
    reportId = if ($ArchivedReport) { $ArchivedReport.reportId } else { $null }
    created = if ($ArchivedReport) { $ArchivedReport.created } else { $null }
    archivePath = if ($ArchivedReport) { $ArchivedReport.archivePath } else { $null }
    historyCount = if ($ReportHistory) { @($ReportHistory.reports).Count } else { $null }
  }
  productionStatus = [ordered]@{
    latestInspectionStatus = $Status.latestInspection.status
    latestCaptureCount = $Status.latestInspection.captureCount
    capturePresent = $Status.capture.present
    saveEnabled = $Status.capture.saveEnabled
    connectedCameras = $Status.capture.connectedCameras
  }
}

$Summary | ConvertTo-Json -Depth 12
} finally {
  if ($SteelIn -and -not $SteelOut) {
    try {
      $RecoveryBody = @{
        materialId = [string]$SteelIn.materialId
        sessionId = [string]$SteelIn.sessionId
        source = "script-e2e-finally"
        mode = "manual"
        triggerMode = "manual"
        acquisitionMode = "manual"
        autoCapture = $false
      }
      $SteelOut = Invoke-Json -Method POST -Path "/api/production/steel-out" -Body $RecoveryBody -TimeoutSec 20
      Write-Warning "E2E execution did not reach normal steel-out; session $($SteelIn.sessionId) was closed in finally."
    } catch {
      Write-Warning "E2E session cleanup failed for $($SteelIn.sessionId): $($_.Exception.Message)"
    }
  }
}
