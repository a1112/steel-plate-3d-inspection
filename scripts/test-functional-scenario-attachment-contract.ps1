param()

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Initializer = Join-Path $PSScriptRoot "new-functional-acceptance-workspace.ps1"
$Attacher = Join-Path $PSScriptRoot "add-functional-scenario-evidence.ps1"
$PackageManifest = Join-Path $RepoRoot "target\packages\steel-inspection-runtime\manifest.json"
$Root = Join-Path $RepoRoot ("target\logs\functional-attachment-contract\{0}" -f [guid]::NewGuid().ToString("N"))

& $Initializer `
  -ReleaseManifestPath $PackageManifest `
  -WorkspaceRoot $Root `
  -Line "line-contract" `
  -Plc "plc-contract" `
  -L2 "l2-contract" `
  -TargetMachine "ipc-contract" | Out-Null

$PlcReportPath = Join-Path $Root "03-plc-l2\plc-l2-functional-acceptance.json"
$PlcReport = Get-Content -LiteralPath $PlcReportPath -Raw | ConvertFrom-Json
$PlcReport.startedAt = "2026-07-16T10:00:00+08:00"
$PlcReport.finishedAt = "2026-07-16T11:00:00+08:00"
$PlcReport | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $PlcReportPath -Encoding UTF8

$RawLogPath = Join-Path $Root "03-plc-l2\raw\steel-info.log"
[System.IO.File]::WriteAllText($RawLogPath, "real PLC/L2 steel-info response", [System.Text.UTF8Encoding]::new($false))
$AttachmentOutput = & $Attacher `
  -WorkspaceRoot $Root `
  -Scope plc-l2 `
  -ScenarioId steel-info `
  -SourceSystem "plc-contract" `
  -CommandOrProcedure "send steel-info and verify persisted task" `
  -RawLogPath $RawLogPath `
  -ObservedAt "2026-07-16T10:15:00+08:00" `
  -RequestId "req-contract-1" `
  -MaterialId "BAR-CONTRACT-1" | Out-String
$Attachment = $AttachmentOutput | ConvertFrom-Json
if ([string]$Attachment.schema -ne "steel.functional-scenario-attachment.v1") {
  throw "Scenario attachment returned an unexpected schema."
}
$PlcReport = Get-Content -LiteralPath $PlcReportPath -Raw | ConvertFrom-Json
$SteelInfo = @($PlcReport.scenarios | Where-Object { $_.id -eq "steel-info" })
if ($SteelInfo.Count -ne 1 -or $SteelInfo[0].passed -ne $true -or @($SteelInfo[0].evidence).Count -ne 1) {
  throw "Scenario attachment did not atomically update the PLC/L2 report."
}
$EvidencePath = Join-Path (Split-Path -Parent $PlcReportPath) ([string]$SteelInfo[0].evidence[0].path -replace '/', '\')
if (-not (Test-Path -LiteralPath $EvidencePath -PathType Leaf) -or
    (Get-FileHash -LiteralPath $EvidencePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$SteelInfo[0].evidence[0].sha256) {
  throw "Attached scenario evidence file or hash is invalid."
}

$DuplicateRejected = $false
try {
  & $Attacher `
    -WorkspaceRoot $Root `
    -Scope plc-l2 `
    -ScenarioId steel-info `
    -SourceSystem "plc-contract" `
    -CommandOrProcedure "duplicate" `
    -RawLogPath $RawLogPath `
    -ObservedAt "2026-07-16T10:20:00+08:00" | Out-Null
} catch {
  $DuplicateRejected = $_.Exception.Message -match "cannot be attached twice"
}
if (-not $DuplicateRejected) {
  throw "Duplicate scenario attachment was not rejected."
}

$OutsideRawPath = Join-Path $Root "outside.log"
[System.IO.File]::WriteAllText($OutsideRawPath, "outside", [System.Text.UTF8Encoding]::new($false))
$OutsideRawRejected = $false
try {
  & $Attacher `
    -WorkspaceRoot $Root `
    -Scope plc-l2 `
    -ScenarioId steel-in `
    -SourceSystem "plc-contract" `
    -CommandOrProcedure "outside raw" `
    -RawLogPath $OutsideRawPath `
    -ObservedAt "2026-07-16T10:25:00+08:00" | Out-Null
} catch {
  $OutsideRawRejected = $_.Exception.Message -match "must stay inside"
}
if (-not $OutsideRawRejected) {
  throw "Raw log outside the scope workspace was not rejected."
}

$SteelInRawPath = Join-Path $Root "03-plc-l2\raw\steel-in.log"
[System.IO.File]::WriteAllText($SteelInRawPath, "steel-in", [System.Text.UTF8Encoding]::new($false))
$OutsideWindowRejected = $false
try {
  & $Attacher `
    -WorkspaceRoot $Root `
    -Scope plc-l2 `
    -ScenarioId steel-in `
    -SourceSystem "plc-contract" `
    -CommandOrProcedure "outside execution window" `
    -RawLogPath $SteelInRawPath `
    -ObservedAt "2026-07-16T12:00:00+08:00" | Out-Null
} catch {
  $OutsideWindowRejected = $_.Exception.Message -match "must fall inside"
}
if (-not $OutsideWindowRejected) {
  throw "ObservedAt outside the execution window was not rejected."
}

$PlcReport = Get-Content -LiteralPath $PlcReportPath -Raw | ConvertFrom-Json
$PlcReport.approvals.approvedAt = "2026-07-16T11:30:00+08:00"
$PlcReport | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $PlcReportPath -Encoding UTF8
$ApprovedRejected = $false
try {
  & $Attacher `
    -WorkspaceRoot $Root `
    -Scope plc-l2 `
    -ScenarioId steel-in `
    -SourceSystem "plc-contract" `
    -CommandOrProcedure "approved mutation" `
    -RawLogPath $RawLogPath `
    -ObservedAt "2026-07-16T10:30:00+08:00" | Out-Null
} catch {
  $ApprovedRejected = $_.Exception.Message -match "already approved and is frozen"
}
if (-not $ApprovedRejected) {
  throw "Approved scenario report was not frozen."
}

[ordered]@{
  schema = "steel.functional-scenario-attachment.contract-test.v1"
  code = 0
  workspaceRoot = $Root
  checks = @(
    "atomic-attachment",
    "duplicate-rejected",
    "outside-raw-log-rejected",
    "outside-execution-window-rejected",
    "approved-report-frozen"
  )
} | ConvertTo-Json -Depth 6
