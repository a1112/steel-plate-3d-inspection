param(
  [string]$ServiceOrigin = "http://127.0.0.1:4873",
  [string]$MaterialId = "",
  [switch]$SkipCapture,
  [int]$ExpectedCameras = 6,
  [int]$Rounds = 1,
  [int]$Lines = 1000,
  [int]$TimeoutMs = 8000,
  [int]$IntervalMs = 500,
  [int]$MaxFrames = 1,
  [int]$MeshRows = 72,
  [int]$MeshColsPerCamera = 48,
  [double]$MaxFaceEdgeMm = 8.0,
  [string]$CaptureRoot = "H:\",
  [string]$AlgorithmRoot = "G:\bar-surface-algorithm"
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
  if ($Method -eq "GET") {
    return Invoke-RestMethod -Method Get -Uri $Uri -TimeoutSec $TimeoutSec
  }

  $JsonBody = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Compress -Depth 20 }
  return Invoke-RestMethod -Method Post -Uri $Uri -ContentType "application/json" -Body $JsonBody -TimeoutSec $TimeoutSec
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

$SteelIn = $null
$Capture = $null
$SteelOut = $null

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
    retries = 0
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
  Assert-Condition ($Capture.code -eq 0) "capture-once failed: code=$($Capture.code)"
  Assert-Condition ($Capture.provider.code -eq 0) "capture provider failed: code=$($Capture.provider.code)"
  Assert-Condition ($Capture.provider.successes -eq $ExpectedCameras) "capture successes mismatch: $($Capture.provider.successes)/$ExpectedCameras"
  Assert-Condition ($Capture.provider.failures -eq 0) "capture failures detected: $($Capture.provider.failures)"
  Assert-Condition ($Capture.provider.completeFrames -ge $ExpectedCameras) "complete frame count too low: $($Capture.provider.completeFrames)"
  Assert-Condition ($Capture.provider.saveSdkDerived -eq $false) "saveSdkDerived must remain false."

  $SteelOut = Invoke-Json -Method POST -Path "/api/production/steel-out" -Body $EventBody -TimeoutSec 15
  Assert-Condition ($SteelOut.code -eq 0) "steel-out failed: code=$($SteelOut.code)"
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
  maxFrames = $MaxFrames
  meshRows = $MeshRows
  meshColsPerCamera = $MeshColsPerCamera
  maxFaceEdgeMm = $MaxFaceEdgeMm
  runCore = $true
  captureRoot = $CaptureRoot
  outputRoot = $AlgorithmRoot
}
if ($SteelIn -and $SteelIn.sessionId) {
  $AlgorithmBody.sessionId = $SteelIn.sessionId
  $AlgorithmBody.inspectionId = $SteelIn.inspectionId
}

$Algorithm = Invoke-Json -Method POST -Path "/api/production/algorithm/run" -Body $AlgorithmBody -TimeoutSec 240
Assert-Condition ($Algorithm.code -eq 0) "algorithm API failed: code=$($Algorithm.code)"
Assert-Condition ($Algorithm.record.status -eq "algorithm-complete") "algorithm record status mismatch: $($Algorithm.record.status)"
Assert-Condition ($Algorithm.record.captureCount -ge $ExpectedCameras) "algorithm record capture count too low: $($Algorithm.record.captureCount)"
Assert-Condition ($Algorithm.algorithm.result.manifest.cameraCount -eq $ExpectedCameras) "algorithm camera count mismatch."
Assert-Condition ($Algorithm.algorithm.result.manifest.core.available -eq $true) "C++ core bsmesh is not available."
Assert-Condition ($Algorithm.algorithm.result.manifest.core.summary.outputBytes -gt 0) "C++ core output is empty."
Assert-Condition ($Algorithm.captureSummary.ok -eq $true) "algorithm did not update the production capture summary: $($Algorithm.captureSummary.error)"
Assert-Condition ($Algorithm.captureSummary.status -eq "algorithm-complete") "capture summary algorithm status mismatch: $($Algorithm.captureSummary.status)"
Assert-Condition (Test-Path ([string]$Algorithm.captureSummary.path) -PathType Leaf) "capture summary file missing after algorithm update: $($Algorithm.captureSummary.path)"

$Manifest = $Algorithm.algorithm.result.manifest
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
Assert-Condition ($AcceptanceReport.checks.sixCameras -eq $true) "acceptance report did not verify six cameras."
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

$ProductionSummaryPath = [string]$Algorithm.captureSummary.path
$ProductionSummary = Get-Content -Raw -Encoding UTF8 $ProductionSummaryPath | ConvertFrom-Json
Assert-Condition ($ProductionSummary.schema -eq "steel.production.summary.v1") "production summary schema mismatch after algorithm: $($ProductionSummary.schema)"
Assert-Condition ($ProductionSummary.inspection.status -eq "algorithm-complete") "production summary inspection status mismatch: $($ProductionSummary.inspection.status)"
Assert-Condition ($ProductionSummary.inspection.captureSummaryPath -eq $ProductionSummaryPath) "production summary did not preserve captureSummaryPath."
Assert-Condition ($ProductionSummary.inspection.algorithmSummaryPath -eq $ManifestPath) "production summary did not link algorithmSummaryPath."
Assert-Condition ($ProductionSummary.algorithm.status -eq "algorithm-complete") "production summary algorithm status mismatch: $($ProductionSummary.algorithm.status)"
Assert-Condition ($ProductionSummary.algorithm.acceptanceStatus -eq "pass") "production summary algorithm acceptance mismatch: $($ProductionSummary.algorithm.acceptanceStatus)"
Assert-Condition ($ProductionSummary.algorithm.coreOutputBytes -gt 0) "production summary algorithm core output is empty."

$Status = Invoke-Json -Method GET -Path "/api/production/status" -TimeoutSec 15
$Latest = Invoke-Json -Method GET -Path "/api/algorithm/bar-surface/latest" -TimeoutSec 30
Assert-Condition ($Latest.manifest.materialId -eq $MaterialId) "latest algorithm material mismatch: $($Latest.manifest.materialId)"
Assert-Condition ($Latest.manifest.core.available -eq $true) "latest algorithm result does not expose core bsmesh."
Assert-Condition ($Status.latestInspection.captureSummaryPath -eq $ProductionSummaryPath) "production status did not expose captureSummaryPath."

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
