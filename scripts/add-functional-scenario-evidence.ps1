param(
  [Parameter(Mandatory = $true)]
  [string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)]
  [ValidateSet("plc-l2", "target-machine")]
  [string]$Scope,
  [Parameter(Mandatory = $true)]
  [string]$ScenarioId,
  [Parameter(Mandatory = $true)]
  [string]$SourceSystem,
  [Parameter(Mandatory = $true)]
  [string]$CommandOrProcedure,
  [Parameter(Mandatory = $true)]
  [string]$RawLogPath,
  [string]$ObservedAt = "",
  [string]$RequestId = "",
  [string]$MaterialId = "",
  [string]$SessionId = "",
  [string]$InspectionId = "",
  [string]$Notes = ""
)

$ErrorActionPreference = "Stop"

function Write-Utf8JsonAtomically {
  param([string]$Path, [object]$Value)

  $Directory = Split-Path -Parent $Path
  $Temporary = Join-Path $Directory (".{0}.{1}.tmp" -f [System.IO.Path]::GetFileName($Path), [guid]::NewGuid().ToString("N"))
  $Backup = Join-Path $Directory (".{0}.{1}.bak" -f [System.IO.Path]::GetFileName($Path), [guid]::NewGuid().ToString("N"))
  try {
    [System.IO.File]::WriteAllText(
      $Temporary,
      ($Value | ConvertTo-Json -Depth 20),
      [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::Replace($Temporary, $Path, $Backup, $true)
    Remove-Item -LiteralPath $Backup -Force
  } finally {
    if (Test-Path -LiteralPath $Temporary -PathType Leaf) {
      Remove-Item -LiteralPath $Temporary -Force
    }
    if (Test-Path -LiteralPath $Backup -PathType Leaf) {
      Remove-Item -LiteralPath $Backup -Force
    }
  }
}

function Assert-PathWithinRoot {
  param([string]$Path, [string]$Root, [string]$Name)
  $FullPath = [System.IO.Path]::GetFullPath($Path)
  $FullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  if (-not $FullPath.StartsWith($FullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Name must stay inside $Root"
  }
  return $FullPath
}

$WorkspaceRoot = [System.IO.Path]::GetFullPath($WorkspaceRoot)
$WorkspaceManifestPath = Join-Path $WorkspaceRoot "workspace.json"
if (-not (Test-Path -LiteralPath $WorkspaceManifestPath -PathType Leaf)) {
  throw "Functional acceptance workspace manifest is missing: $WorkspaceManifestPath"
}
$Workspace = Get-Content -LiteralPath $WorkspaceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$Workspace.schema -ne "steel.functional-acceptance-workspace.v1") {
  throw "Workspace schema mismatch."
}

$ScopeRoot = if ($Scope -eq "plc-l2") {
  Join-Path $WorkspaceRoot "03-plc-l2"
} else {
  Join-Path $WorkspaceRoot "05-target-machine"
}
$ReportPath = if ($Scope -eq "plc-l2") {
  Join-Path $ScopeRoot "plc-l2-functional-acceptance.json"
} else {
  Join-Path $ScopeRoot "target-machine-functional-acceptance.json"
}
$RawRoot = Join-Path $ScopeRoot "raw"
$EvidenceRoot = Join-Path $ScopeRoot "evidence"
if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) {
  throw "Scenario report is missing: $ReportPath"
}
$RawLogPath = Assert-PathWithinRoot -Path $RawLogPath -Root $RawRoot -Name "RawLogPath"
if (-not (Test-Path -LiteralPath $RawLogPath -PathType Leaf)) {
  throw "Raw log file is missing: $RawLogPath"
}

$OriginalReportSha256 = (Get-FileHash -LiteralPath $ReportPath -Algorithm SHA256).Hash.ToLowerInvariant()
$Report = Get-Content -LiteralPath $ReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$Report.releaseVersion -cne [string]$Workspace.releaseVersion -or
    [string]$Report.releaseCommit -cne [string]$Workspace.releaseCommit) {
  throw "Scenario report release identity does not match workspace.json."
}
$ApprovedAt = [string]$Report.approvals.approvedAt
if (-not [string]::IsNullOrWhiteSpace($ApprovedAt)) {
  throw "Scenario report is already approved and is frozen: $ReportPath"
}

$StartedAt = [DateTimeOffset]::MinValue
$FinishedAt = [DateTimeOffset]::MinValue
if (-not [DateTimeOffset]::TryParse([string]$Report.startedAt, [ref]$StartedAt) -or
    -not [DateTimeOffset]::TryParse([string]$Report.finishedAt, [ref]$FinishedAt) -or
    $FinishedAt -le $StartedAt) {
  throw "Set a valid startedAt/finishedAt execution window before attaching scenario evidence."
}
$Observed = [DateTimeOffset]::Now
if (-not [string]::IsNullOrWhiteSpace($ObservedAt) -and
    -not [DateTimeOffset]::TryParse($ObservedAt, [ref]$Observed)) {
  throw "ObservedAt must be a valid ISO-8601 timestamp."
}
if ($Observed -lt $StartedAt -or $Observed -gt $FinishedAt) {
  throw "ObservedAt must fall inside the scenario report execution window."
}

$Matches = @($Report.scenarios | Where-Object { [string]$_.id -ceq $ScenarioId })
if ($Matches.Count -ne 1) {
  throw "ScenarioId must appear exactly once in the $Scope report: $ScenarioId"
}
$Scenario = $Matches[0]
if ($Scenario.passed -eq $true -or @($Scenario.evidence).Count -gt 0) {
  throw "Scenario already has evidence and cannot be attached twice: $ScenarioId"
}

$GeneratorPath = Join-Path $PSScriptRoot "new-functional-scenario-evidence.ps1"
if (-not (Test-Path -LiteralPath $GeneratorPath -PathType Leaf)) {
  throw "Scenario evidence generator is missing: $GeneratorPath"
}
$ReleaseManifestPath = Join-Path $WorkspaceRoot "00-release\manifest.json"
$EvidenceFileName = "{0}-{1}.json" -f $ScenarioId, (Get-Date -Format "yyyyMMdd-HHmmss-fff")
$EvidencePath = Join-Path $EvidenceRoot $EvidenceFileName
$GeneratorArguments = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $GeneratorPath,
  "-ReleaseManifestPath", $ReleaseManifestPath,
  "-ScenarioId", $ScenarioId,
  "-SourceSystem", $SourceSystem,
  "-CommandOrProcedure", $CommandOrProcedure,
  "-RawLogPath", $RawLogPath,
  "-OutputPath", $EvidencePath,
  "-ObservedAt", $Observed.ToString("o")
)
foreach ($Optional in @(
  [ordered]@{ name = "-RequestId"; value = $RequestId },
  [ordered]@{ name = "-MaterialId"; value = $MaterialId },
  [ordered]@{ name = "-SessionId"; value = $SessionId },
  [ordered]@{ name = "-InspectionId"; value = $InspectionId },
  [ordered]@{ name = "-Notes"; value = $Notes }
)) {
  if (-not [string]::IsNullOrWhiteSpace([string]$Optional.value)) {
    $GeneratorArguments += @([string]$Optional.name, [string]$Optional.value)
  }
}
$GeneratorOutput = & powershell.exe @GeneratorArguments | Out-String
if ($LASTEXITCODE -ne 0) {
  throw "Scenario evidence generator failed with exit code $LASTEXITCODE."
}
$Reference = $GeneratorOutput | ConvertFrom-Json
if ([string]$Reference.schema -ne "steel.functional-scenario-evidence.reference.v1") {
  throw "Scenario evidence generator returned an unexpected response."
}

$ResolvedEvidencePath = Assert-PathWithinRoot -Path ([string]$Reference.path) -Root $EvidenceRoot -Name "Generated evidence path"
$RelativeEvidencePath = "evidence/" + [System.IO.Path]::GetFileName($ResolvedEvidencePath)
$Scenario.passed = $true
$Scenario.evidence = @([ordered]@{
  path = $RelativeEvidencePath
  sha256 = [string]$Reference.sha256
})
try {
  $CurrentReportSha256 = (Get-FileHash -LiteralPath $ReportPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($CurrentReportSha256 -cne $OriginalReportSha256) {
    throw "Scenario report changed while evidence was being generated; retry against the latest report."
  }
  Write-Utf8JsonAtomically -Path $ReportPath -Value $Report
} catch {
  if (Test-Path -LiteralPath $EvidencePath -PathType Leaf) {
    Remove-Item -LiteralPath $EvidencePath -Force
  }
  throw
}

[ordered]@{
  schema = "steel.functional-scenario-attachment.v1"
  scope = $Scope
  scenarioId = $ScenarioId
  reportPath = $ReportPath
  evidencePath = [string]$Reference.path
  evidenceSha256 = [string]$Reference.sha256
  rawLogPath = $RawLogPath
  rawLogSha256 = [string]$Reference.rawLogSha256
} | ConvertTo-Json -Depth 6
