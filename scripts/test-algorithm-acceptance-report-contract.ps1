$ErrorActionPreference = 'Stop'
$Validator = Join-Path $PSScriptRoot 'test-algorithm-acceptance-report.ps1'
$WorkRoot = Join-Path ([IO.Path]::GetTempPath()) ("steel-acceptance-contract-" + [guid]::NewGuid().ToString('N'))

function Write-JsonFile {
  param([string]$Path, [object]$Value)
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
}

function File-Sha256 {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Require-Failure {
  param([scriptblock]$Action, [string]$Name)
  $Failed = $false
  try { & $Action | Out-Null } catch { $Failed = $true }
  if (-not $Failed) { throw "Expected acceptance validation failure: $Name" }
}

New-Item -ItemType Directory -Path $WorkRoot | Out-Null
try {
  $ConfigPath = Join-Path $WorkRoot 'algorithm-config.json'
  $CalibrationPath = Join-Path $WorkRoot 'calibration.bin'
  $ModelSetPath = Join-Path $WorkRoot 'model-set.json'
  $ScriptPath = Join-Path $WorkRoot 'algorithm.py'
  $CorePath = Join-Path $WorkRoot 'algorithm-core.exe'
  $ReportPath = Join-Path $WorkRoot 'acceptance.json'

  $Config = [ordered]@{
    schema = 'steel.algorithm-config.v1'
    algorithmName = 'acceptance-contract-test'
    algorithmVersion = '1.0.0'
    configRevision = 'ALGCFG-TEST-1'
  }
  Write-JsonFile $ConfigPath $Config
  [IO.File]::WriteAllBytes($CalibrationPath, [Text.Encoding]::UTF8.GetBytes('calibration'))
  [IO.File]::WriteAllBytes($ScriptPath, [Text.Encoding]::UTF8.GetBytes('print("contract")'))
  [IO.File]::WriteAllBytes($CorePath, [Text.Encoding]::UTF8.GetBytes('core'))
  $ModelSet = [ordered]@{ schema = 'steel.defect-model-set.v1'; id = 'MODEL-TEST-1'; temporary = $false }
  Write-JsonFile $ModelSetPath $ModelSet

  $ReleaseCommit = 'a' * 40
  $Report = [ordered]@{
    schema = 'steel.algorithm-acceptance.v1'
    status = 'pass'
    algorithmName = $Config.algorithmName
    algorithmVersion = $Config.algorithmVersion
    configRevision = $Config.configRevision
    configSha256 = File-Sha256 $ConfigPath
    scriptSha256 = File-Sha256 $ScriptPath
    coreSha256 = File-Sha256 $CorePath
    releaseCommit = $ReleaseCommit
    datasetRevision = 'DATASET-TEST-1'
    datasetSha256 = 'b' * 64
    datasetValidationSha256 = 'c' * 64
    evaluatorRevision = 'EVALUATOR-TEST-1'
    evaluatorSha256 = 'd' * 64
    modelSetRevision = $ModelSet.id
    modelSetSha256 = File-Sha256 $ModelSetPath
    reproductionManifestRevision = 'REPRODUCTION-TEST-1'
    reproductionManifestSha256 = 'e' * 64
    calibrationRevision = 'CALIBRATION-TEST-1'
    calibrationSha256 = File-Sha256 $CalibrationPath
    evaluatedAt = '2026-08-29T00:00:00Z'
    metrics = [ordered]@{
      detectionRecall = 0.99
      falsePositiveRate = 0.01
      missRate = 0.01
      localizationErrorMmP95 = 0.1
      sizeErrorMmP95 = 0.1
      endToEndLatencyMsP95 = 100.0
    }
    acceptanceCriteria = [ordered]@{
      minimumDetectionRecall = 0.98
      maximumFalsePositiveRate = 0.02
      maximumMissRate = 0.02
      maximumLocalizationErrorMmP95 = 0.2
      maximumSizeErrorMmP95 = 0.2
      maximumEndToEndLatencyMsP95 = 200.0
    }
    approvals = [ordered]@{
      algorithmOwner = 'algorithm-owner'
      qualityOwner = 'quality-owner'
      approvedAt = '2026-08-29T01:00:00Z'
    }
  }
  Write-JsonFile $ReportPath $Report

  $AuditJson = & $Validator -ReportPath $ReportPath -ConfigPath $ConfigPath -CalibrationPath $CalibrationPath -ModelSetPath $ModelSetPath -ScriptPath $ScriptPath -CorePath $CorePath -ReleaseCommit $ReleaseCommit
  $Audit = $AuditJson | ConvertFrom-Json
  if ([string]$Audit.schema -cne 'steel.algorithm-acceptance.audit.v1' -or [int]$Audit.code -ne 0) {
    throw 'Passing acceptance fixture did not produce a passing audit.'
  }

  $ModelSet.temporary = $true
  Write-JsonFile $ModelSetPath $ModelSet
  $Report.modelSetSha256 = File-Sha256 $ModelSetPath
  Write-JsonFile $ReportPath $Report
  Require-Failure { & $Validator -ReportPath $ReportPath -ConfigPath $ConfigPath -ModelSetPath $ModelSetPath } 'temporary model set'

  $ModelSet.temporary = $false
  Write-JsonFile $ModelSetPath $ModelSet
  $Report.modelSetSha256 = File-Sha256 $ModelSetPath
  $Report.approvals.approvedAt = '2026-08-28T23:59:59Z'
  Write-JsonFile $ReportPath $Report
  Require-Failure { & $Validator -ReportPath $ReportPath -ConfigPath $ConfigPath -ModelSetPath $ModelSetPath } 'approval before evaluation'

  Write-Host 'Algorithm acceptance evidence-chain contract passed.'
} finally {
  $ResolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
  $ResolvedWork = [IO.Path]::GetFullPath($WorkRoot).TrimEnd('\', '/')
  if ($ResolvedWork.StartsWith($ResolvedTemp + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $ResolvedWork) -like 'steel-acceptance-contract-*') {
    Remove-Item -LiteralPath $ResolvedWork -Recurse -Force -ErrorAction SilentlyContinue
  }
}
