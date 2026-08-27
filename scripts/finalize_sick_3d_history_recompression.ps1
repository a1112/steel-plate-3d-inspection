param(
  [Parameter(Mandatory = $true)][string]$ProjectRoot,
  [Parameter(Mandatory = $true)][string]$Profile,
  [Parameter(Mandatory = $true)][string]$ProcessIds,
  [Parameter(Mandatory = $true)][string]$DataReports,
  [Parameter(Mandatory = $true)][string]$EventReport,
  [Parameter(Mandatory = $true)][string]$CombinedReport,
  [int]$PollSeconds = 30,
  [int]$EventWorkers = 16
)

$ErrorActionPreference = 'Stop'

function Write-MonitorLog {
  param([string]$Message)
  $timestamp = [DateTimeOffset]::UtcNow.ToString('o')
  Write-Output "[$timestamp] $Message"
}

$root = [System.IO.Path]::GetFullPath($ProjectRoot)
$profilePath = [System.IO.Path]::GetFullPath((Join-Path $root $Profile))
$ids = @($ProcessIds.Split(',') | ForEach-Object { [int]$_.Trim() })
$reports = @($DataReports.Split(';') | ForEach-Object { [System.IO.Path]::GetFullPath($_.Trim()) })
$eventReportPath = [System.IO.Path]::GetFullPath($EventReport)
$combinedReportPath = [System.IO.Path]::GetFullPath($CombinedReport)

if ($ids.Count -ne $reports.Count -or $ids.Count -eq 0) {
  throw 'ProcessIds and DataReports must contain the same nonzero number of entries.'
}
if ($PollSeconds -lt 5 -or $PollSeconds -gt 300) {
  throw 'PollSeconds must be between 5 and 300.'
}

Write-MonitorLog "Waiting for $($ids.Count) recompression jobs."
while ($true) {
  $missingReports = @($reports | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
  if ($missingReports.Count -eq 0) {
    break
  }
  for ($index = 0; $index -lt $ids.Count; $index++) {
    if ((Test-Path -LiteralPath $reports[$index] -PathType Leaf)) {
      continue
    }
    if ($null -eq (Get-Process -Id $ids[$index] -ErrorAction SilentlyContinue)) {
      throw "Recompression process $($ids[$index]) exited without report $($reports[$index])."
    }
  }
  Start-Sleep -Seconds $PollSeconds
}

$data = @($reports | ForEach-Object { Get-Content -LiteralPath $_ -Raw | ConvertFrom-Json })
$failed = @($data | Where-Object { $_.status -ne 'complete' -or [long]$_.counts.error -gt 0 })
if ($failed.Count -gt 0) {
  throw "$($failed.Count) recompression report(s) failed; event reconciliation was not started."
}
$discovered = [long](($data | Measure-Object -Property framesDiscovered -Sum).Sum)
$rewritten = [long](($data | ForEach-Object { [long]$_.counts.rewritten } | Measure-Object -Sum).Sum)
$alreadyCompressed = [long](($data | ForEach-Object { [long]$_.'counts'.'already-compressed' } | Measure-Object -Sum).Sum)
$bytesSaved = [long](($data | Measure-Object -Property bytesSaved -Sum).Sum)
if ($discovered -ne ($rewritten + $alreadyCompressed)) {
  throw "Coverage mismatch: discovered=$discovered rewritten=$rewritten alreadyCompressed=$alreadyCompressed."
}

Write-MonitorLog "Data migration complete; reconciling committed events."
$eventDirectory = Split-Path -Parent $eventReportPath
New-Item -ItemType Directory -Force -Path $eventDirectory | Out-Null
Push-Location $root
try {
  & py -3.12 scripts/recompress_sick_3d_history.py `
    --profile $profilePath `
    --workers $EventWorkers `
    --apply `
    --events-only `
    --report $eventReportPath
  if ($LASTEXITCODE -ne 0) {
    throw "Committed-event reconciliation failed with exit code $LASTEXITCODE."
  }
}
finally {
  Pop-Location
}

$events = Get-Content -LiteralPath $eventReportPath -Raw | ConvertFrom-Json
if ($events.status -ne 'complete' -or [long]$events.counts.error -gt 0) {
  throw 'Committed-event reconciliation report is not complete.'
}

$combined = [ordered]@{
  schema = 'steel.sick-3d-history-recompression.aggregate.v1'
  status = 'complete'
  completedAt = [DateTimeOffset]::UtcNow.ToString('o')
  profile = $profilePath
  framesDiscovered = $discovered
  rewritten = $rewritten
  alreadyCompressed = $alreadyCompressed
  bytesSaved = $bytesSaved
  eventsDiscovered = [long]$events.eventsDiscovered
  eventFramesUpdated = [long]$events.framesUpdated
  dataReports = $reports
  eventReport = $eventReportPath
}
$combinedDirectory = Split-Path -Parent $combinedReportPath
New-Item -ItemType Directory -Force -Path $combinedDirectory | Out-Null
$temporary = "$combinedReportPath.$([Guid]::NewGuid().ToString('N')).tmp"
try {
  $combined | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $combinedReportPath -Force
}
finally {
  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}
Write-MonitorLog "All historical 3D frames and committed events are complete: $combinedReportPath"
