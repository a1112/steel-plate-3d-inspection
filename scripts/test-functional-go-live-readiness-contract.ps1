param()

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Sut = Join-Path $PSScriptRoot "test-functional-go-live-readiness.ps1"
$Root = Join-Path $RepoRoot "target\logs\functional-go-live-contract"
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$Commit = "1234567890abcdef1234567890abcdef12345678"
$Version = "1.2.3"

function Write-Json {
  param([string]$Name, [object]$Value)
  $Path = Join-Path $Root $Name
  $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding UTF8
  return $Path
}

function New-Scenarios {
  param([string[]]$Ids)
  return @($Ids | ForEach-Object {
    $RawLogName = "raw-$_.log"
    $RawLogPath = Join-Path $Root $RawLogName
    [System.IO.File]::WriteAllText($RawLogPath, "raw evidence for $_", [System.Text.UTF8Encoding]::new($false))
    $EvidenceName = "evidence-$_.json"
    $EvidencePath = Write-Json $EvidenceName ([ordered]@{
      schema = "steel.functional-scenario-evidence.v1"
      releaseVersion = $Version
      releaseCommit = $Commit
      releaseManifestSha256 = $ManifestSha256
      scenarioId = $_
      observedAt = "2026-07-16T10:05:00+08:00"
      result = "pass"
      source = [ordered]@{
        system = "contract-test"
        command = "invoke-$_.ps1"
        rawLogPath = $RawLogName
        rawLogSha256 = (Get-FileHash -LiteralPath $RawLogPath -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    })
    [ordered]@{
      id = $_
      passed = $true
      evidence = @([ordered]@{
        path = [System.IO.Path]::GetFileName($EvidencePath)
        sha256 = (Get-FileHash -LiteralPath $EvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
      })
    }
  })
}

function Invoke-Decision {
  param([string]$PlanPath)
  $Output = & $Sut -PlanPath $PlanPath -ReportDir (Join-Path $Root "reports") -AllowNoGo | Out-String
  return $Output | ConvertFrom-Json
}

$ManifestPath = Write-Json "manifest.json" ([ordered]@{
  schema = "steel.runtime-package.v1"
  releaseVersion = $Version
  source = [ordered]@{ gitCommit = $Commit }
})
$ManifestSha256 = (Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$AlgorithmPath = Write-Json "algorithm.json" ([ordered]@{
  schema = "steel.algorithm-acceptance.audit.v1"
  code = 0
  releaseCommit = $Commit
  datasetRevision = "labeled-v1"
  metrics = [ordered]@{ detectionRecall = 0.99 }
  approvals = [ordered]@{ algorithmOwner = "algorithm"; qualityOwner = "quality" }
})
$IntegratedPath = Write-Json "integrated.json" ([ordered]@{
  schema = "steel.integrated-capture-management.acceptance.v1"
  code = 0
  release = [ordered]@{ version = $Version; commit = $Commit; manifestSha256 = $ManifestSha256 }
  requested = [ordered]@{ requireFullCoverage = $true }
  coverage = [ordered]@{ full = $true; covered = 24; required = 24; uncovered = @() }
  checks = @([ordered]@{ id = "real-hardware"; ok = $true })
})
$PlcPath = Write-Json "plc.json" ([ordered]@{
  schema = "steel.plc-l2-functional-acceptance.v1"
  releaseVersion = $Version
  releaseCommit = $Commit
  target = [ordered]@{ line = "line-1"; plc = "plc-1"; l2 = "l2-1" }
  startedAt = "2026-07-16T10:00:00+08:00"
  finishedAt = "2026-07-16T10:30:00+08:00"
  scenarios = New-Scenarios @("steel-info","steel-in","capture","algorithm","result-report","steel-out","duplicate-retry","wrong-order","disconnect-reconnect","service-restart","back-to-back-materials")
  approvals = [ordered]@{ automationOwner = "automation"; productionOwner = "production"; approvedAt = "2026-07-16T11:00:00+08:00" }
})
$Cycle = [ordered]@{
  identityBinding = [ordered]@{
    sessionMatchesMaterial = $true
    inspectionMatchesSession = $true
    summaryMatchesCycle = $true
  }
}
$Soak = [ordered]@{
  schema = "steel.production.stability.v1"
  code = 0
  release = [ordered]@{ version = $Version; commit = $Commit; manifestSha256 = $ManifestSha256 }
  elapsedSeconds = 28800
  preflight = [ordered]@{ captureProvider = "lvm-nvt" }
  totals = [ordered]@{ cycles = 1; failedCycles = 0 }
  identityIsolation = [ordered]@{ uniqueMaterialIds = 1; uniqueSessionIds = 1; uniqueInspectionIds = 1 }
  cycles = @($Cycle)
  finalConvergence = [ordered]@{
    converged = $true
    status = [ordered]@{
      activeSession = $null
      admission = [ordered]@{ inFlight = 0 }
      tasks = [ordered]@{
        queueDepth = 0
        worker = [ordered]@{ activeTaskId = $null }
      }
    }
  }
}
$SoakPath = Write-Json "soak.json" $Soak
$TargetPath = Write-Json "target.json" ([ordered]@{
  schema = "steel.target-machine-functional-acceptance.v1"
  releaseVersion = $Version
  releaseCommit = $Commit
  machine = [ordered]@{ name = "ipc-01"; line = "line-1" }
  startedAt = "2026-07-16T10:00:00+08:00"
  finishedAt = "2026-07-16T10:30:00+08:00"
  scenarios = New-Scenarios @("clean-install","configuration-readback","service-start","reboot-auto-start","complete-production-cycle","upgrade","rollback","uninstall-preserves-production-data")
  approvals = [ordered]@{ implementationOwner = "implementation"; operationsOwner = "operations"; approvedAt = "2026-07-16T14:30:00+08:00" }
})
$Plan = [ordered]@{
  schema = "steel.functional-go-live-plan.v1"
  releaseVersion = $Version
  releaseCommit = $Commit
  packageManifestPath = $ManifestPath
  evidence = [ordered]@{
    algorithmAuditPath = $AlgorithmPath
    integrated24Path = $IntegratedPath
    plcL2Path = $PlcPath
    productionSoakPath = $SoakPath
    targetMachinePath = $TargetPath
  }
  thresholds = [ordered]@{
    expectedCameras = 8
    requiredIntegratedCoverage = 24
    minimumSoakSeconds = 28800
    minimumSoakCycles = 1
  }
}
$PlanPath = Write-Json "plan.json" $Plan

$Go = Invoke-Decision $PlanPath
if ($Go.decision -ne "go" -or [int]$Go.summary.passed -ne 6) {
  throw "Complete functional evidence did not produce Go."
}

$Soak.preflight.captureProvider = "simulated"
$null = Write-Json "soak.json" $Soak
$Simulated = Invoke-Decision $PlanPath
if ($Simulated.decision -ne "no-go" -or
    -not (@($Simulated.gates | Where-Object { $_.id -eq "FUNC-04" }).failures -match "simulated provider")) {
  throw "Simulated soak was not rejected."
}

$Soak.preflight.captureProvider = "lvm-nvt"
$null = Write-Json "soak.json" $Soak
$Plc = Get-Content -LiteralPath $PlcPath -Raw | ConvertFrom-Json
$Plc.scenarios = @($Plc.scenarios | Where-Object { $_.id -ne "service-restart" })
$null = Write-Json "plc.json" $Plc
$MissingScenario = Invoke-Decision $PlanPath
if ($MissingScenario.decision -ne "no-go" -or
    -not (@($MissingScenario.gates | Where-Object { $_.id -eq "FUNC-03" }).failures -match "service-restart")) {
  throw "Missing PLC/L2 recovery scenario was not rejected."
}

$Plc.scenarios = New-Scenarios @("steel-info","steel-in","capture","algorithm","result-report","steel-out","duplicate-retry","wrong-order","disconnect-reconnect","service-restart","back-to-back-materials")
$null = Write-Json "plc.json" $Plc
$Soak.release.commit = "abcdef1234567890abcdef1234567890abcdef12"
$null = Write-Json "soak.json" $Soak
$WrongRelease = Invoke-Decision $PlanPath
if ($WrongRelease.decision -ne "no-go" -or
    -not (@($WrongRelease.gates | Where-Object { $_.id -eq "FUNC-04" }).failures -match "release identity")) {
  throw "Cross-release production soak was not rejected."
}

$Soak.release.commit = $Commit
$null = Write-Json "soak.json" $Soak
$Target = Get-Content -LiteralPath $TargetPath -Raw | ConvertFrom-Json
$TargetEvidence = [string]$Target.scenarios[0].evidence[0].path
$TargetEvidencePath = Join-Path $Root $TargetEvidence
$WrongScenarioJson = Get-Content -LiteralPath $TargetEvidencePath -Raw | ConvertFrom-Json
$WrongScenarioJson.scenarioId = "unrelated-scenario"
$WrongScenarioJson | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $TargetEvidencePath -Encoding UTF8
$Target.scenarios[0].evidence[0].sha256 = (Get-FileHash -LiteralPath $TargetEvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
$null = Write-Json "target.json" $Target
$WrongScenario = Invoke-Decision $PlanPath
if ($WrongScenario.decision -ne "no-go" -or
    -not (@($WrongScenario.gates | Where-Object { $_.id -eq "FUNC-05" }).failures -match "different scenarioId")) {
  throw "Hash-valid unrelated scenario evidence was not rejected."
}

$Target.scenarios = New-Scenarios @("clean-install","configuration-readback","service-start","reboot-auto-start","complete-production-cycle","upgrade","rollback","uninstall-preserves-production-data")
$null = Write-Json "target.json" $Target
$TargetEvidence = [string]$Target.scenarios[0].evidence[0].path
Add-Content -LiteralPath (Join-Path $Root $TargetEvidence) -Value "tampered"
$TamperedEvidence = Invoke-Decision $PlanPath
if ($TamperedEvidence.decision -ne "no-go" -or
    -not (@($TamperedEvidence.gates | Where-Object { $_.id -eq "FUNC-05" }).failures -match "SHA-256 mismatch")) {
  throw "Tampered target-machine evidence was not rejected."
}

$Target.scenarios = New-Scenarios @("clean-install","configuration-readback","service-start","reboot-auto-start","complete-production-cycle","upgrade","rollback","uninstall-preserves-production-data")
$null = Write-Json "target.json" $Target
$TargetEvidencePath = Join-Path $Root ([string]$Target.scenarios[0].evidence[0].path)
$TargetEvidenceJson = Get-Content -LiteralPath $TargetEvidencePath -Raw | ConvertFrom-Json
Add-Content -LiteralPath (Join-Path $Root ([string]$TargetEvidenceJson.source.rawLogPath)) -Value "tampered raw log"
$TamperedRawLog = Invoke-Decision $PlanPath
if ($TamperedRawLog.decision -ne "no-go" -or
    -not (@($TamperedRawLog.gates | Where-Object { $_.id -eq "FUNC-05" }).failures -match "raw log SHA-256 mismatch")) {
  throw "Tampered raw log was not rejected."
}

[ordered]@{
  schema = "steel.functional-go-live-readiness.contract-test.v1"
  code = 0
  checks = @(
    "complete-evidence-go",
    "simulated-soak-no-go",
    "missing-plc-recovery-no-go",
    "cross-release-soak-no-go",
    "hash-valid-unrelated-scenario-no-go",
    "tampered-scenario-evidence-no-go",
    "tampered-raw-log-no-go"
  )
} | ConvertTo-Json -Depth 5
