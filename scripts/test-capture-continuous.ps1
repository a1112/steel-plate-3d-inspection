param(
  [string]$Origin = "http://127.0.0.1:4317",
  [int]$ExpectedCameras = 6,
  [int]$Rounds = 3,
  [int]$Lines = 1280,
  [int]$Width = 0,
  [int]$TimeoutMs = 8000,
  [int]$IntervalMs = 500,
  [int]$DataMode = 1,
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
    return Invoke-RestMethod -Uri $Uri -Method Post -ContentType "application/json; charset=utf-8" -Body $Json -TimeoutSec ([Math]::Max(2, [Math]::Ceiling($TimeoutMs / 1000) + 5))
  }

  return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 10
}

function ConvertTo-SafeName {
  param([string]$Value)
  return ($Value -replace "[\\/:*?`"<>|.]", "_")
}

if ($Rounds -lt 1) {
  throw "Rounds must be at least 1."
}

Write-Host "Checking capture provider: $Origin"
$Health = Invoke-Json -Method GET -Path "/health"
Write-Host "Provider SDK ready: $($Health.sdkReady), connected cameras: $($Health.cameraCount)"

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

Write-Host "Starting continuous capture: rounds=$Rounds, interval=${IntervalMs}ms, lines=$Lines, width=$Width"
for ($Round = 1; $Round -le $Rounds; $Round++) {
  foreach ($CameraIp in $CameraIps) {
    $SafeIp = ConvertTo-SafeName $CameraIp
    $Output = ("{0}/{1}/round-{2:D3}-shot-{3:D4}.png" -f ($OutputDir -replace "\\", "/"), $SafeIp, $Round, ($Results[$CameraIp].attempts + 1))
    $Results[$CameraIp].attempts += 1

    $Capture = Invoke-Json -Method POST -Path "/api/capture/depth-map" -Body @{
      ip = $CameraIp
      lines = $Lines
      width = $Width
      timeoutMs = $TimeoutMs
      dataMode = $DataMode
      output = $Output
    }

    $Code = [int]$Capture.code
    $Results[$CameraIp].lastCode = $Code
    $Results[$CameraIp].lastOutput = if ($Capture.output) { [string]$Capture.output } else { $Output }
    if ($Code -eq 0) {
      $Results[$CameraIp].successes += 1
    } else {
      $Results[$CameraIp].failures += 1
    }

    Write-Host ("  round={0} ip={1} code={2} output={3}" -f $Round, $CameraIp, $Code, $Results[$CameraIp].lastOutput)

    if ($IntervalMs -gt 0) {
      Start-Sleep -Milliseconds $IntervalMs
    }
  }
}

$Summary = $Results.Values | ForEach-Object { [pscustomobject]$_ }
$Summary | Format-Table -AutoSize

$TotalAttempts = ($Summary | Measure-Object -Property attempts -Sum).Sum
$TotalSuccesses = ($Summary | Measure-Object -Property successes -Sum).Sum
$TotalFailures = ($Summary | Measure-Object -Property failures -Sum).Sum

Write-Host "Continuous capture test complete: attempts=$TotalAttempts, successes=$TotalSuccesses, failures=$TotalFailures"

if ($TotalFailures -gt 0) {
  exit 2
}
