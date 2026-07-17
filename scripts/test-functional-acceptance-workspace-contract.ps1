param()

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Initializer = Join-Path $PSScriptRoot "new-functional-acceptance-workspace.ps1"
$PackageManifest = Join-Path $RepoRoot "target\packages\steel-inspection-runtime\manifest.json"
$Root = Join-Path $RepoRoot ("target\logs\functional-workspace-contract\{0}" -f [guid]::NewGuid().ToString("N"))

$Output = & $Initializer `
  -ReleaseManifestPath $PackageManifest `
  -WorkspaceRoot $Root `
  -Line "line-contract" `
  -Plc "plc-contract" `
  -L2 "l2-contract" `
  -TargetMachine "ipc-contract" `
  -MinimumSoakSeconds 28800 `
  -MinimumSoakCycles 100 | Out-String
$Reference = $Output | ConvertFrom-Json
if ([string]$Reference.schema -ne "steel.functional-acceptance-workspace.reference.v1") {
  throw "Workspace initializer did not return the expected reference schema."
}

$Workspace = Get-Content -LiteralPath (Join-Path $Root "workspace.json") -Raw | ConvertFrom-Json
$Plan = Get-Content -LiteralPath (Join-Path $Root "functional-go-live-plan.json") -Raw | ConvertFrom-Json
$PlcReport = Get-Content -LiteralPath (Join-Path $Root "03-plc-l2\plc-l2-functional-acceptance.json") -Raw | ConvertFrom-Json
$TargetReport = Get-Content -LiteralPath (Join-Path $Root "05-target-machine\target-machine-functional-acceptance.json") -Raw | ConvertFrom-Json
$Manifest = Get-Content -LiteralPath $PackageManifest -Raw | ConvertFrom-Json

if ([string]$Workspace.schema -ne "steel.functional-acceptance-workspace.v1" -or
    [string]$Workspace.releaseCommit -cne [string]$Manifest.source.gitCommit -or
    [string]$Plan.releaseCommit -cne [string]$Manifest.source.gitCommit -or
    [string]$Plan.releaseVersion -cne [string]$Manifest.releaseVersion) {
  throw "Workspace release identity did not bind the package manifest."
}
if ([int]$Plan.thresholds.minimumSoakSeconds -ne 28800 -or
    [int]$Plan.thresholds.minimumSoakCycles -ne 100 -or
    [int]$Plan.thresholds.requiredIntegratedCoverage -ne 24) {
  throw "Workspace thresholds do not preserve the production functionality gate."
}
if (@($PlcReport.scenarios).Count -ne 11 -or
    @($TargetReport.scenarios).Count -ne 8 -or
    @($PlcReport.scenarios | Where-Object { $_.passed -ne $false -or @($_.evidence).Count -ne 0 }).Count -ne 0 -or
    @($TargetReport.scenarios | Where-Object { $_.passed -ne $false -or @($_.evidence).Count -ne 0 }).Count -ne 0) {
  throw "Workspace scenario reports were not initialized fail-closed."
}
foreach ($RequiredPath in @(
  "00-release\manifest.json",
  "01-algorithm",
  "02-eight-camera",
  "03-plc-l2\evidence",
  "03-plc-l2\raw",
  "04-soak",
  "05-target-machine\evidence",
  "05-target-machine\raw",
  "10-signoff"
)) {
  if (-not (Test-Path -LiteralPath (Join-Path $Root $RequiredPath))) {
    throw "Workspace is missing required path: $RequiredPath"
  }
}

$RerunRejected = $false
try {
  & $Initializer `
    -ReleaseManifestPath $PackageManifest `
    -WorkspaceRoot $Root `
    -Line "line-contract" `
    -Plc "plc-contract" `
    -L2 "l2-contract" `
    -TargetMachine "ipc-contract" | Out-Null
} catch {
  $RerunRejected = $_.Exception.Message -match "never overwrites or deletes acceptance evidence"
}
if (-not $RerunRejected) {
  throw "Initializer did not reject a populated workspace."
}

[ordered]@{
  schema = "steel.functional-acceptance-workspace.contract-test.v1"
  code = 0
  workspaceRoot = $Root
  checks = @(
    "release-identity-bound",
    "production-thresholds-preserved",
    "scenario-reports-fail-closed",
    "required-directory-layout",
    "populated-workspace-rejected"
  )
} | ConvertTo-Json -Depth 6
