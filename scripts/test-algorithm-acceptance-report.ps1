param(
  [Parameter(Mandatory = $true)]
  [string]$ReportPath,
  [string]$ConfigPath = "",
  [string]$CalibrationPath = "",
  [string]$ScriptPath = "",
  [string]$CorePath = "",
  [string]$ReleaseCommit = "",
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $RepoRoot "config\algorithm\bar-surface-production.json"
}
$ReportPath = (Resolve-Path -LiteralPath $ReportPath).Path
$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$Report = Get-Content -LiteralPath $ReportPath -Raw -Encoding utf8 | ConvertFrom-Json
$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
$ConfigHash = (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
$Failures = [System.Collections.Generic.List[string]]::new()

function Require-Condition {
  param([bool]$Condition, [string]$Failure)
  if (-not $Condition) { $Failures.Add($Failure) | Out-Null }
}

function Test-Sha256 {
  param([object]$Value)
  return [string]$Value -match '^[0-9a-fA-F]{64}$'
}

Require-Condition ([string]$Config.schema -eq 'steel.algorithm-config.v1') 'algorithm_config_schema_invalid'
Require-Condition ([string]$Report.schema -eq 'steel.algorithm-acceptance.v1') 'acceptance_report_schema_invalid'
Require-Condition ([string]$Report.status -eq 'pass') 'acceptance_status_not_pass'
Require-Condition ([string]$Report.algorithmName -ceq [string]$Config.algorithmName) 'algorithm_name_mismatch'
Require-Condition ([string]$Report.algorithmVersion -ceq [string]$Config.algorithmVersion) 'algorithm_version_mismatch'
Require-Condition ([string]$Report.configRevision -ceq [string]$Config.configRevision) 'config_revision_mismatch'
Require-Condition ([string]$Report.configSha256 -ceq $ConfigHash) 'config_sha256_mismatch'
Require-Condition (-not [string]::IsNullOrWhiteSpace([string]$Report.datasetRevision)) 'dataset_revision_missing'
Require-Condition (Test-Sha256 $Report.datasetSha256) 'dataset_sha256_invalid'
Require-Condition (-not [string]::IsNullOrWhiteSpace([string]$Report.evaluatorRevision)) 'evaluator_revision_missing'
Require-Condition (Test-Sha256 $Report.evaluatorSha256) 'evaluator_sha256_invalid'
Require-Condition (-not [string]::IsNullOrWhiteSpace([string]$Report.calibrationRevision)) 'calibration_revision_missing'
Require-Condition (Test-Sha256 $Report.calibrationSha256) 'calibration_sha256_invalid'
Require-Condition (Test-Sha256 $Report.scriptSha256) 'script_sha256_invalid'
Require-Condition (Test-Sha256 $Report.coreSha256) 'core_sha256_invalid'
Require-Condition ([string]$Report.releaseCommit -match '^[0-9a-fA-F]{40,64}$') 'release_commit_invalid'
Require-Condition (-not [string]::IsNullOrWhiteSpace([string]$Report.approvals.algorithmOwner)) 'algorithm_owner_approval_missing'
Require-Condition (-not [string]::IsNullOrWhiteSpace([string]$Report.approvals.qualityOwner)) 'quality_owner_approval_missing'
Require-Condition (-not [string]::IsNullOrWhiteSpace([string]$Report.approvals.approvedAt)) 'approval_time_missing'

$MetricChecks = @(
  @('detectionRecall', 'minimumDetectionRecall', 'minimum'),
  @('falsePositiveRate', 'maximumFalsePositiveRate', 'maximum'),
  @('missRate', 'maximumMissRate', 'maximum'),
  @('localizationErrorMmP95', 'maximumLocalizationErrorMmP95', 'maximum'),
  @('sizeErrorMmP95', 'maximumSizeErrorMmP95', 'maximum'),
  @('endToEndLatencyMsP95', 'maximumEndToEndLatencyMsP95', 'maximum')
)
foreach ($Check in $MetricChecks) {
  $MetricName, $CriterionName, $Direction = $Check
  $Metric = $Report.metrics.$MetricName
  $Criterion = $Report.acceptanceCriteria.$CriterionName
  $MetricValid = $null -ne $Metric -and $Metric -is [ValueType]
  $CriterionValid = $null -ne $Criterion -and $Criterion -is [ValueType]
  Require-Condition $MetricValid "metric_${MetricName}_missing"
  Require-Condition $CriterionValid "criterion_${CriterionName}_missing"
  if ($MetricValid -and $CriterionValid) {
    $Passed = if ($Direction -eq 'minimum') { [double]$Metric -ge [double]$Criterion } else { [double]$Metric -le [double]$Criterion }
    Require-Condition $Passed "metric_${MetricName}_outside_criterion"
  }
}

if (-not [string]::IsNullOrWhiteSpace($CalibrationPath)) {
  $CalibrationPath = (Resolve-Path -LiteralPath $CalibrationPath).Path
  $CalibrationHash = (Get-FileHash -LiteralPath $CalibrationPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Require-Condition ([string]$Report.calibrationSha256 -ceq $CalibrationHash) 'calibration_file_sha256_mismatch'
}
if (-not [string]::IsNullOrWhiteSpace($ScriptPath)) {
  $ScriptPath = (Resolve-Path -LiteralPath $ScriptPath).Path
  $ScriptHash = (Get-FileHash -LiteralPath $ScriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Require-Condition ([string]$Report.scriptSha256 -ceq $ScriptHash) 'script_file_sha256_mismatch'
}
if (-not [string]::IsNullOrWhiteSpace($CorePath)) {
  $CorePath = (Resolve-Path -LiteralPath $CorePath).Path
  $CoreHash = (Get-FileHash -LiteralPath $CorePath -Algorithm SHA256).Hash.ToLowerInvariant()
  Require-Condition ([string]$Report.coreSha256 -ceq $CoreHash) 'core_file_sha256_mismatch'
}
if (-not [string]::IsNullOrWhiteSpace($ReleaseCommit)) {
  Require-Condition ([string]$Report.releaseCommit -ceq $ReleaseCommit.ToLowerInvariant()) 'release_commit_mismatch'
}

$Result = [ordered]@{
  schema = 'steel.algorithm-acceptance.audit.v1'
  code = if ($Failures.Count -eq 0) { 0 } else { 1 }
  report = $ReportPath
  algorithmName = [string]$Config.algorithmName
  algorithmVersion = [string]$Config.algorithmVersion
  configRevision = [string]$Config.configRevision
  configSha256 = $ConfigHash
  datasetRevision = [string]$Report.datasetRevision
  evaluatorRevision = [string]$Report.evaluatorRevision
  calibrationRevision = [string]$Report.calibrationRevision
  releaseCommit = ([string]$Report.releaseCommit).ToLowerInvariant()
  metrics = $Report.metrics
  acceptanceCriteria = $Report.acceptanceCriteria
  approvals = $Report.approvals
  failures = @($Failures)
}
if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputDirectory = Split-Path -Parent $OutputPath
  if ($OutputDirectory) { New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null }
  $Result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding utf8
}
$Result | ConvertTo-Json -Depth 8
if ($Failures.Count -ne 0) {
  throw "Algorithm acceptance report failed $($Failures.Count) checks."
}
