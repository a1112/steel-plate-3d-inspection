param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseManifestPath,
  [Parameter(Mandatory = $true)]
  [string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)]
  [string]$Line,
  [Parameter(Mandatory = $true)]
  [string]$Plc,
  [Parameter(Mandatory = $true)]
  [string]$L2,
  [Parameter(Mandatory = $true)]
  [string]$TargetMachine,
  [int]$MinimumSoakSeconds = 28800,
  [int]$MinimumSoakCycles = 100
)

$ErrorActionPreference = "Stop"

function Write-Utf8JsonAtomically {
  param([string]$Path, [object]$Value)

  $Directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  $Temporary = Join-Path $Directory (".{0}.{1}.tmp" -f [System.IO.Path]::GetFileName($Path), [guid]::NewGuid().ToString("N"))
  try {
    [System.IO.File]::WriteAllText(
      $Temporary,
      ($Value | ConvertTo-Json -Depth 20),
      [System.Text.UTF8Encoding]::new($false)
    )
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      [System.IO.File]::Replace($Temporary, $Path, $null, $true)
    } else {
      [System.IO.File]::Move($Temporary, $Path)
    }
  } finally {
    if (Test-Path -LiteralPath $Temporary -PathType Leaf) {
      Remove-Item -LiteralPath $Temporary -Force
    }
  }
}

function New-ScenarioRows {
  param([string[]]$Ids)
  return @($Ids | ForEach-Object {
    [ordered]@{
      id = $_
      passed = $false
      evidence = @()
    }
  })
}

if (-not (Test-Path -LiteralPath $ReleaseManifestPath -PathType Leaf)) {
  throw "Release manifest is missing: $ReleaseManifestPath"
}
$ReleaseManifestPath = (Resolve-Path -LiteralPath $ReleaseManifestPath).Path
$Manifest = Get-Content -LiteralPath $ReleaseManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$Manifest.schema -ne "steel.runtime-package.v1" -or
    [string]::IsNullOrWhiteSpace([string]$Manifest.releaseVersion) -or
    [string]$Manifest.source.gitCommit -notmatch "^[0-9a-f]{40,64}$") {
  throw "Release manifest does not expose a valid runtime package identity."
}
foreach ($RequiredValue in @(
  [ordered]@{ name = "Line"; value = $Line },
  [ordered]@{ name = "Plc"; value = $Plc },
  [ordered]@{ name = "L2"; value = $L2 },
  [ordered]@{ name = "TargetMachine"; value = $TargetMachine }
)) {
  if ([string]::IsNullOrWhiteSpace([string]$RequiredValue.value)) {
    throw "$($RequiredValue.name) is required."
  }
}
if ($MinimumSoakSeconds -lt 28800) {
  throw "MinimumSoakSeconds cannot be below one eight-hour production shift."
}
if ($MinimumSoakCycles -lt 1) {
  throw "MinimumSoakCycles must be positive."
}

$WorkspaceRoot = [System.IO.Path]::GetFullPath($WorkspaceRoot)
if (Test-Path -LiteralPath $WorkspaceRoot -PathType Container) {
  $Existing = @(Get-ChildItem -LiteralPath $WorkspaceRoot -Force -ErrorAction Stop)
  if ($Existing.Count -gt 0) {
    throw "WorkspaceRoot is not empty. Use a new directory; the initializer never overwrites or deletes acceptance evidence."
  }
}

$Directories = @(
  "00-release",
  "01-algorithm",
  "02-eight-camera",
  "03-plc-l2\evidence",
  "03-plc-l2\raw",
  "04-soak",
  "05-target-machine\evidence",
  "05-target-machine\raw",
  "10-signoff"
)
foreach ($Relative in $Directories) {
  New-Item -ItemType Directory -Force -Path (Join-Path $WorkspaceRoot $Relative) | Out-Null
}

$ManifestEvidencePath = Join-Path $WorkspaceRoot "00-release\manifest.json"
[System.IO.File]::Copy($ReleaseManifestPath, $ManifestEvidencePath, $false)
$ReleaseVersion = [string]$Manifest.releaseVersion
$ReleaseCommit = [string]$Manifest.source.gitCommit
$CreatedAt = (Get-Date).ToString("o")

$PlcReportPath = Join-Path $WorkspaceRoot "03-plc-l2\plc-l2-functional-acceptance.json"
$PlcReport = [ordered]@{
  schema = "steel.plc-l2-functional-acceptance.v1"
  releaseVersion = $ReleaseVersion
  releaseCommit = $ReleaseCommit
  target = [ordered]@{ line = $Line; plc = $Plc; l2 = $L2 }
  startedAt = ""
  finishedAt = ""
  scenarios = New-ScenarioRows @(
    "steel-info", "steel-in", "capture", "algorithm", "result-report", "steel-out",
    "duplicate-retry", "wrong-order", "disconnect-reconnect", "service-restart",
    "back-to-back-materials"
  )
  approvals = [ordered]@{ automationOwner = ""; productionOwner = ""; approvedAt = "" }
}
Write-Utf8JsonAtomically $PlcReportPath $PlcReport

$TargetReportPath = Join-Path $WorkspaceRoot "05-target-machine\target-machine-functional-acceptance.json"
$TargetReport = [ordered]@{
  schema = "steel.target-machine-functional-acceptance.v1"
  releaseVersion = $ReleaseVersion
  releaseCommit = $ReleaseCommit
  machine = [ordered]@{ name = $TargetMachine; line = $Line }
  startedAt = ""
  finishedAt = ""
  scenarios = New-ScenarioRows @(
    "clean-install", "configuration-readback", "service-start", "reboot-auto-start",
    "complete-production-cycle", "upgrade", "rollback", "uninstall-preserves-production-data"
  )
  approvals = [ordered]@{ implementationOwner = ""; operationsOwner = ""; approvedAt = "" }
}
Write-Utf8JsonAtomically $TargetReportPath $TargetReport

$PlanPath = Join-Path $WorkspaceRoot "functional-go-live-plan.json"
$Plan = [ordered]@{
  schema = "steel.functional-go-live-plan.v1"
  releaseVersion = $ReleaseVersion
  releaseCommit = $ReleaseCommit
  packageManifestPath = "00-release/manifest.json"
  evidence = [ordered]@{
    algorithmAuditPath = "01-algorithm/algorithm-acceptance-audit.json"
    integrated24Path = "02-eight-camera/integrated-capture-management-24-of-24.json"
    plcL2Path = "03-plc-l2/plc-l2-functional-acceptance.json"
    productionSoakPath = "04-soak/production-stability.json"
    targetMachinePath = "05-target-machine/target-machine-functional-acceptance.json"
  }
  thresholds = [ordered]@{
    expectedCameras = 8
    requiredIntegratedCoverage = 24
    minimumSoakSeconds = $MinimumSoakSeconds
    minimumSoakCycles = $MinimumSoakCycles
  }
}
Write-Utf8JsonAtomically $PlanPath $Plan

$WorkspaceManifestPath = Join-Path $WorkspaceRoot "workspace.json"
$WorkspaceManifest = [ordered]@{
  schema = "steel.functional-acceptance-workspace.v1"
  createdAt = $CreatedAt
  releaseVersion = $ReleaseVersion
  releaseCommit = $ReleaseCommit
  releaseManifestSha256 = (Get-FileHash -LiteralPath $ManifestEvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
  line = $Line
  plc = $Plc
  l2 = $L2
  targetMachine = $TargetMachine
  planPath = $PlanPath
  plcL2ReportPath = $PlcReportPath
  targetMachineReportPath = $TargetReportPath
}
Write-Utf8JsonAtomically $WorkspaceManifestPath $WorkspaceManifest

[ordered]@{
  schema = "steel.functional-acceptance-workspace.reference.v1"
  workspaceRoot = $WorkspaceRoot
  workspaceManifestPath = $WorkspaceManifestPath
  planPath = $PlanPath
  releaseVersion = $ReleaseVersion
  releaseCommit = $ReleaseCommit
  nextActions = @(
    "copy the real algorithm audit into 01-algorithm",
    "copy the release-bound unskipped 24/24 report into 02-eight-camera",
    "generate and attach every PLC/L2 scenario evidence",
    "copy the release-bound real production-shift report into 04-soak",
    "generate and attach every target-machine scenario evidence",
    "complete approvals, then run test-functional-go-live-readiness.ps1"
  )
} | ConvertTo-Json -Depth 8
