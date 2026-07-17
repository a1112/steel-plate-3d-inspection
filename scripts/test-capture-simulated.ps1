param(
  [int]$Port = 45317,
  [int]$ExpectedCameras = 4,
  [string]$Configuration = "Release",
  [string]$ServiceExe = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Exe = if ([string]::IsNullOrWhiteSpace($ServiceExe)) {
  Join-Path $RepoRoot "target\capture\$Configuration\steel_capture_service.exe"
} else {
  (Resolve-Path $ServiceExe).Path
}
$StorageRoot = Join-Path $RepoRoot "target\simulated-capture-test\storage"
$ConfigRoot = Join-Path $RepoRoot "target\simulated-capture-test\config"
$Origin = "http://127.0.0.1:$Port"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing $Exe. Build the headless capture service first."
}

function Invoke-CaptureJson {
  param(
    [ValidateSet("GET", "POST")]
    [string]$Method,
    [string]$Path,
    [object]$Body = $null,
    [int]$TimeoutSec = 8
  )

  $Uri = "$Origin$Path"
  if ($Method -eq "POST") {
    $Json = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Compress -Depth 12 }
    return Invoke-RestMethod -Uri $Uri -Method Post -ContentType "application/json; charset=utf-8" -Body $Json -TimeoutSec $TimeoutSec
  }

  return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec $TimeoutSec
}

function Wait-ForProvider {
  $Deadline = (Get-Date).AddSeconds(15)
  do {
    try {
      return Invoke-CaptureJson -Method GET -Path "/health" -TimeoutSec 2
    } catch {
      Start-Sleep -Milliseconds 250
    }
  } while ((Get-Date) -lt $Deadline)

  throw "Timed out waiting for simulated capture provider at $Origin"
}

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )
  if (-not $Condition) {
    throw $Message
  }
}

New-Item -ItemType Directory -Force -Path $StorageRoot, $ConfigRoot | Out-Null

$Process = $null
try {
  $StartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $StartInfo.FileName = $Exe
  $StartInfo.WorkingDirectory = Split-Path $Exe
  $StartInfo.Arguments = "--port $Port --driver simulated"
  $StartInfo.UseShellExecute = $false
  $StartInfo.CreateNoWindow = $true
  $StartInfo.Environment["CAPTURE_STORAGE_ROOT"] = $StorageRoot
  $StartInfo.Environment["CAPTURE_CONFIG_ROOT"] = $ConfigRoot
  $Process = [System.Diagnostics.Process]::Start($StartInfo)

  $Health = Wait-ForProvider
  Assert-True ($Health.driverId -eq "simulated") "Expected simulated driverId, got $($Health.driverId)"
  Assert-True ($Health.driverMode -eq "simulated") "Expected simulated driverMode, got $($Health.driverMode)"

  $Profile = @{
    schema = "steel.capture.profile.v1"
    name = "offline-test"
    driverMode = "simulated"
    storageRoot = $StorageRoot
    expectedCameras = $ExpectedCameras
    autoConnect = $true
    lines = 96
    width = 160
    fpsLimit = 4
    simulated = @{
      imageSourceDir = ""
    }
  }

  $Save = Invoke-CaptureJson -Method POST -Path "/api/config/profile/save" -Body @{
    name = "offline-test"
    makeActive = $true
    profileJson = ($Profile | ConvertTo-Json -Compress -Depth 12)
  }
  Assert-True ([int]$Save.code -eq 0) "Profile save failed: $($Save | ConvertTo-Json -Compress -Depth 12)"
  Assert-True (Test-Path (Join-Path $ConfigRoot "profiles\offline-test\profile.json")) "Profile folder was not created"

  $Apply = Invoke-CaptureJson -Method POST -Path "/api/config/profile/apply" -Body @{
    name = "offline-test"
    autoConnect = $true
    expectedCameras = $ExpectedCameras
  }
  Assert-True ([int]$Apply.code -eq 0) "Profile apply failed: $($Apply | ConvertTo-Json -Compress -Depth 12)"

  $Cameras = Invoke-CaptureJson -Method GET -Path "/api/cameras"
  Assert-True ([int]$Cameras.count -eq $ExpectedCameras) "Expected $ExpectedCameras simulated cameras, got $($Cameras.count)"
  $FirstIp = [string]$Cameras.cameras[0].ip
  Assert-True ($FirstIp -eq "192.168.200.101") "Expected first simulated IP 192.168.200.101, got $FirstIp"

  $Storage = Invoke-CaptureJson -Method GET -Path "/api/storage/status"
  Assert-True ($Storage.capacityAvailable -eq $true) "Storage capacity was not available."
  Assert-True ([uint64]$Storage.capacityBytes -gt 0) "Storage capacityBytes was not positive."
  Assert-True ([uint64]$Storage.freeBytes -gt 0) "Storage freeBytes was not positive."
  Assert-True ([double]$Storage.freePercent -gt 0) "Storage freePercent was not positive."
  foreach ($CameraRoot in @($Storage.cameraRoots)) {
    Assert-True ($CameraRoot.capacityAvailable -eq $true) "Camera storage capacity was not available for $($CameraRoot.ip)."
    Assert-True ([uint64]$CameraRoot.capacityBytes -gt 0) "Camera storage capacityBytes was not positive for $($CameraRoot.ip)."
    Assert-True ([uint64]$CameraRoot.freeBytes -gt 0) "Camera storage freeBytes was not positive for $($CameraRoot.ip)."
  }

  $Connect = Invoke-CaptureJson -Method POST -Path "/api/cameras/connect-all" -Body @{
    expectedCameras = $ExpectedCameras
  }
  Assert-True ([int]$Connect.connected -eq $ExpectedCameras) "Expected all cameras connected, got $($Connect.connected)"

  $Stream = Invoke-CaptureJson -Method POST -Path "/api/stream/start" -Body @{
    ip = $FirstIp
    lines = 96
    width = 160
    dataMode = 1
    fpsLimit = 4
  }
  Assert-True ([bool]$Stream.running) "Expected stream to be running"
  Start-Sleep -Milliseconds 600

  $Latest = Invoke-WebRequest -UseBasicParsing -Uri "$Origin/api/stream/latest?ip=$([uri]::EscapeDataString($FirstIp))&kind=depth" -TimeoutSec 8
  Assert-True ($Latest.StatusCode -eq 200) "Expected latest stream PNG HTTP 200, got $($Latest.StatusCode)"
  Assert-True ($Latest.Content.Length -gt 128) "Expected non-empty latest PNG"

  $Capture = Invoke-CaptureJson -Method POST -Path "/api/capture/depth-map" -Body @{
    ip = $FirstIp
    lines = 96
    width = 160
    output = "depth/offline-test.png"
  }
  Assert-True ([int]$Capture.code -eq 0) "Expected simulated capture success, got $($Capture | ConvertTo-Json -Compress -Depth 12)"
  Assert-True (Test-Path $Capture.output) "Expected captured PNG at $($Capture.output)"

  $Status = Invoke-CaptureJson -Method GET -Path "/api/config/status"
  Assert-True ($Status.activeProfile -eq "offline-test") "Expected active profile offline-test"
  Assert-True ($Status.profileEntries.Count -ge 1) "Expected profileEntries in config status"
  $ActiveEntry = @($Status.profileEntries | Where-Object { $_.name -eq "offline-test" -and $_.active -eq $true })
  Assert-True ($ActiveEntry.Count -eq 1) "Expected active profileEntries row for offline-test"

  Write-Host "Simulated capture provider test passed."
} finally {
  if ($Process -and -not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force
  }
}
