param(
  [string]$Origin = "http://127.0.0.1:4317",
  [int]$ExpectedCameras = 8,
  [int]$Rounds = 3,
  [int]$Lines = 1280,
  [int]$Width = 0,
  [int]$TimeoutMs = 8000,
  [int]$IntervalMs = 500,
  [int]$Retries = 2,
  [int]$ControlMode = 0,
  [int]$DataMode = 3,
  [switch]$SkipPreset,
  [string]$OutputDir = "captures/continuous-test",
  [switch]$SelectedOnly,
  [string]$Ip = ""
)

$ErrorActionPreference = "Stop"

function Invoke-Json {
  param(
    [ValidateSet("GET", "POST")]
    [string]$Method,
    [string]$Path,
    [object]$Body = $null
  )

  $Uri = "$Origin$Path"
  if ($Method -eq "POST") {
    $Json = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Compress -Depth 6 }
    $PostTimeoutSec = if ($Path -eq "/api/capture/continuous-test") {
      [Math]::Max(30, [Math]::Ceiling(((($TimeoutMs * ([Math]::Max(0, $Retries) + 1)) + $IntervalMs) * $Rounds + 60000) / 1000))
    } else {
      [Math]::Max(10, [Math]::Ceiling((($TimeoutMs * ([Math]::Max(0, $Retries) + 1)) + 10000) / 1000))
    }
    return Invoke-RestMethod -Uri $Uri -Method Post -ContentType "application/json; charset=utf-8" -Body $Json -TimeoutSec $PostTimeoutSec
  }

  return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 10
}

function ConvertTo-SafeName {
  param([string]$Value)
  return ($Value -replace "[\\/:*?`"<>|.]", "_")
}

function Resolve-OutputRoot {
  param(
    [string]$StorageRoot,
    [string]$OutputDir
  )
  if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    return [System.IO.Path]::GetFullPath($OutputDir)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $StorageRoot $OutputDir))
}

if ($Rounds -lt 1) {
  throw "Rounds must be at least 1."
}

Write-Host "Checking capture provider: $Origin"
$Health = Invoke-Json -Method GET -Path "/health"
Write-Host "Provider SDK ready: $($Health.sdkReady), connected cameras: $($Health.cameraCount)"
$StorageRoot = if ($Health.storageRoot) { [string]$Health.storageRoot } else { (Get-Location).Path }
$ResolvedOutputRoot = Resolve-OutputRoot -StorageRoot $StorageRoot -OutputDir $OutputDir

if ($SelectedOnly) {
  if ([string]::IsNullOrWhiteSpace($Ip)) {
    throw "Pass -Ip when using -SelectedOnly."
  }
  $CameraIps = @($Ip.Trim())
} else {
  $Cameras = Invoke-Json -Method GET -Path "/api/cameras"
  $CameraIps = @($Cameras.cameras | ForEach-Object { $_.ip } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

if ($CameraIps.Count -lt $ExpectedCameras) {
  Write-Warning "Discovered $($CameraIps.Count) camera(s), expected $ExpectedCameras."
}
if ($CameraIps.Count -eq 0) {
  throw "No camera IPs available for continuous capture test."
}

$Results = @{}
foreach ($CameraIp in $CameraIps) {
  $Results[$CameraIp] = [ordered]@{
    ip = $CameraIp
    connectCode = $null
    attempts = 0
    successes = 0
    failures = 0
    lastCode = $null
    lastOutput = ""
    lastDepthOutput = ""
    lastIntensityOutput = ""
    lastMetadataOutput = ""
    lastDepthExists = $false
    lastIntensityExists = $false
    lastMetadataExists = $false
    completeFrames = 0
    metadataFrames = 0
    errorName = ""
    operatorHint = ""
  }
}

Write-Host "Auto-connecting $($CameraIps.Count) camera(s)..."
foreach ($CameraIp in $CameraIps) {
  $Connect = Invoke-Json -Method POST -Path "/api/camera/connect" -Body @{
    ip = $CameraIp
    devType = -1
  }
  $Results[$CameraIp].connectCode = [int]$Connect.code
  Write-Host ("  {0} connect code={1}" -f $CameraIp, $Connect.code)
}

if (-not $SkipPreset) {
  Write-Host "Applying line continuous preset..."
  $Preset = Invoke-Json -Method POST -Path "/api/capture/preset/line-continuous" -Body @{
    ips = $CameraIps
    lines = $Lines
    timeTriggerFreq = 300
    laserPower = 100
    laserLineSelect = 0
    controlMode = $ControlMode
    connectFirst = $false
    saveToDevice = $false
  }
  Write-Host ("  preset code={0}, applied={1}, failed={2}" -f $Preset.code, $Preset.applied, $Preset.failed)
}

Write-Host "Starting parallel synchronized continuous capture: rounds=$Rounds, interval=${IntervalMs}ms, lines=$Lines, width=$Width"
$CaptureSummary = Invoke-Json -Method POST -Path "/api/capture/continuous-test" -Body @{
  expectedCameras = $ExpectedCameras
  rounds = $Rounds
  lines = $Lines
  width = $Width
  timeoutMs = $TimeoutMs
  intervalMs = $IntervalMs
  retries = $Retries
  controlMode = $ControlMode
  dataMode = $DataMode
  outputDir = $OutputDir
  connectFirst = $false
  stopStreams = $true
  ips = $CameraIps
}
Write-Host ("  provider code={0}, parallel={1}, sync={2}, workers={3}, elapsed={4}ms" -f $CaptureSummary.code, $CaptureSummary.parallel, $CaptureSummary.syncMode, $CaptureSummary.workerCount, $CaptureSummary.elapsedMs)

foreach ($Capture in @($CaptureSummary.results)) {
  $CameraIp = [string]$Capture.ip
  if ([string]::IsNullOrWhiteSpace($CameraIp) -or -not $Results.ContainsKey($CameraIp)) {
    continue
  }
  $Code = [int]$Capture.code
  $Results[$CameraIp].attempts += 1
  $Results[$CameraIp].lastCode = $Code
  $Results[$CameraIp].lastOutput = if ($Capture.output) { [string]$Capture.output } else { "" }
  $Results[$CameraIp].lastDepthOutput = if ($Capture.depthOutput) { [string]$Capture.depthOutput } else { $Results[$CameraIp].lastOutput }
  $Results[$CameraIp].lastIntensityOutput = if ($Capture.intensityOutput) { [string]$Capture.intensityOutput } else { "" }
  $Results[$CameraIp].lastMetadataOutput = if ($Capture.metadataOutput) { [string]$Capture.metadataOutput } else { "" }
  $Results[$CameraIp].lastDepthExists = [bool]$Capture.depthExists
  $Results[$CameraIp].lastIntensityExists = [bool]$Capture.intensityExists
  $Results[$CameraIp].lastMetadataExists = [bool]$Capture.metadataExists
  $Results[$CameraIp].errorName = if ($Capture.errorName) { [string]$Capture.errorName } else { "" }
  $Results[$CameraIp].operatorHint = if ($Capture.operatorHint) { [string]$Capture.operatorHint } else { "" }
  if ($Code -eq 0) {
    $Results[$CameraIp].successes += 1
  } else {
    $Results[$CameraIp].failures += 1
  }
  if ([bool]$Capture.completeFrame) {
    $Results[$CameraIp].completeFrames += 1
  }
  if ([bool]$Capture.metadataExists) {
    $Results[$CameraIp].metadataFrames += 1
  }

  Write-Host ("  round={0} worker={1} ip={2} code={3} error={4} attempts={5} output={6} metadata={7}" -f $Capture.round, $Capture.parallelIndex, $CameraIp, $Code, $Results[$CameraIp].errorName, $Capture.attemptsUsed, $Results[$CameraIp].lastOutput, $Capture.metadataOutput)
  if ($Code -ne 0 -and $Results[$CameraIp].operatorHint) {
    Write-Host ("    hint={0}" -f $Results[$CameraIp].operatorHint)
  }
}

$Summary = $Results.Values | ForEach-Object { [pscustomobject]$_ }
$Summary | Format-Table -AutoSize

$TotalAttempts = ($Summary | Measure-Object -Property attempts -Sum).Sum
$TotalSuccesses = ($Summary | Measure-Object -Property successes -Sum).Sum
$TotalFailures = ($Summary | Measure-Object -Property failures -Sum).Sum
$TotalCompleteFrames = ($Summary | Measure-Object -Property completeFrames -Sum).Sum
$TotalMetadataFrames = ($Summary | Measure-Object -Property metadataFrames -Sum).Sum

New-Item -ItemType Directory -Force -Path $ResolvedOutputRoot | Out-Null
$Report = [ordered]@{
  schema = "steel.capture.continuous-test.summary.v1"
  generatedAt = (Get-Date).ToString("o")
  origin = $Origin
  storageRoot = $StorageRoot
  outputDir = $OutputDir
  outputRoot = $ResolvedOutputRoot
  expectedCameras = $ExpectedCameras
  cameraCount = $CameraIps.Count
  rounds = $Rounds
  lines = $Lines
  width = $Width
  timeoutMs = $TimeoutMs
  intervalMs = $IntervalMs
  retries = $Retries
  controlMode = $ControlMode
  dataMode = $DataMode
  parallel = [bool]$CaptureSummary.parallel
  syncMode = [string]$CaptureSummary.syncMode
  workerCount = [int]$CaptureSummary.workerCount
  providerElapsedMs = [int]$CaptureSummary.elapsedMs
  providerSummaryOutput = [string]$CaptureSummary.summaryOutput
  attempts = $TotalAttempts
  successes = $TotalSuccesses
  failures = $TotalFailures
  completeFrames = $TotalCompleteFrames
  metadataFrames = $TotalMetadataFrames
  complete = ($TotalFailures -eq 0 -and $TotalCompleteFrames -eq $TotalAttempts)
  cameras = @($Summary)
}
$SummaryJsonPath = Join-Path $ResolvedOutputRoot "script-summary.json"
$SummaryCsvPath = Join-Path $ResolvedOutputRoot "script-summary.csv"
$Report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $SummaryJsonPath -Encoding UTF8
$Summary | Export-Csv -LiteralPath $SummaryCsvPath -Encoding UTF8 -NoTypeInformation

Write-Host "Continuous capture test complete: attempts=$TotalAttempts, successes=$TotalSuccesses, failures=$TotalFailures, completeFrames=$TotalCompleteFrames, metadataFrames=$TotalMetadataFrames"
Write-Host "Provider Summary JSON: $($CaptureSummary.summaryOutput)"
Write-Host "Script Summary JSON:   $SummaryJsonPath"
Write-Host "Script Summary CSV:    $SummaryCsvPath"

if ($TotalFailures -gt 0) {
  exit 2
}
