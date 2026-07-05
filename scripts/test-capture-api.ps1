param(
  [string]$Origin = "http://127.0.0.1:4317",
  [string]$ProbeIp = "192.0.2.1",
  [int]$ExpectedCameras = 0,
  [switch]$AllowNoCameras
)

$ErrorActionPreference = "Stop"

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
    $Json = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Compress -Depth 8 }
    return Invoke-RestMethod -Uri $Uri -Method Post -ContentType "application/json; charset=utf-8" -Body $Json -TimeoutSec $TimeoutSec
  }

  return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec $TimeoutSec
}

function Add-Check {
  param(
    [string]$Name,
    [bool]$Ok,
    [string]$Detail
  )
  $script:Checks += [pscustomobject]@{
    endpoint = $Name
    ok = $Ok
    detail = $Detail
  }
}

function Assert-JsonOk {
  param(
    [string]$Name,
    [scriptblock]$Call,
    [scriptblock]$Validate = { param($Response) $true }
  )

  try {
    $Response = & $Call
    $Ok = [bool](& $Validate $Response)
    Add-Check $Name $Ok (($Response | ConvertTo-Json -Compress -Depth 8))
  } catch {
    Add-Check $Name $false $_.Exception.Message
  }
}

$Checks = @()
$StorageRoot = $null

Write-Host "Checking capture API at $Origin"

Assert-JsonOk "GET /health" {
  Invoke-CaptureJson -Method GET -Path "/health"
} {
  param($Response)
  $script:StorageRoot = $Response.storageRoot
  $Response.service -eq "steel_capture_service" -and $null -ne $Response.sdkReady
}

Assert-JsonOk "GET /api/storage/status" {
  Invoke-CaptureJson -Method GET -Path "/api/storage/status"
} {
  param($Response)
  if (-not $script:StorageRoot) {
    $script:StorageRoot = $Response.root
  }
  [int]$Response.code -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$Response.root)
}

Assert-JsonOk "POST /api/storage/config current root" {
  Invoke-CaptureJson -Method POST -Path "/api/storage/config" -Body @{ root = $script:StorageRoot }
} {
  param($Response)
  [int]$Response.code -eq 0 -and [bool]$Response.exists
}

Assert-JsonOk "GET /api/cameras" {
  Invoke-CaptureJson -Method GET -Path "/api/cameras"
} {
  param($Response)
  $Response.cameras -is [array] -and ($AllowNoCameras -or $ExpectedCameras -le 0 -or $Response.count -ge $ExpectedCameras)
}

Assert-JsonOk "GET /api/camera/statuses" {
  Invoke-CaptureJson -Method GET -Path "/api/camera/statuses"
} {
  param($Response)
  $Response.statuses -is [array]
}

Assert-JsonOk "GET /api/camera/status" {
  Invoke-CaptureJson -Method GET -Path "/api/camera/status?ip=$([uri]::EscapeDataString($ProbeIp))"
} {
  param($Response)
  $Response.ip -eq $ProbeIp -and $null -ne $Response.connected
}

Assert-JsonOk "GET /api/param missing key" {
  Invoke-CaptureJson -Method GET -Path "/api/param?ip=$([uri]::EscapeDataString($ProbeIp))"
} {
  param($Response)
  [int]$Response.code -eq 400
}

Assert-JsonOk "GET /api/param unconnected" {
  Invoke-CaptureJson -Method GET -Path "/api/param?ip=$([uri]::EscapeDataString($ProbeIp))&key=ExposureTime&type=int"
} {
  param($Response)
  [int]$Response.code -ne 0
}

Assert-JsonOk "POST /api/camera/connect probe" {
  Invoke-CaptureJson -Method POST -Path "/api/camera/connect" -Body @{ ip = $ProbeIp; devType = -1 }
} {
  param($Response)
  $null -ne $Response.code -and $null -ne $Response.connected
}

Assert-JsonOk "POST /api/cameras/connect-all probe" {
  Invoke-CaptureJson -Method POST -Path "/api/cameras/connect-all" -Body @{
    ips = @($ProbeIp)
    expectedCameras = 1
    devType = -1
  }
} {
  param($Response)
  $null -ne $Response.code -and $Response.results -is [array] -and $Response.results.Count -eq 1
}

Assert-JsonOk "POST /api/capture/depth-map unconnected" {
  Invoke-CaptureJson -Method POST -Path "/api/capture/depth-map" -Body @{
    ip = $ProbeIp
    lines = 1280
    width = 0
    timeoutMs = 1000
    dataMode = 1
    output = "api-smoke/depth.png"
  }
} {
  param($Response)
  [int]$Response.code -ne 0
}

Assert-JsonOk "POST /api/preview/capture unconnected" {
  Invoke-CaptureJson -Method POST -Path "/api/preview/capture" -Body @{
    ip = $ProbeIp
    lines = 1280
    width = 0
    timeoutMs = 1000
    dataMode = 1
    output = "api-smoke/preview.png"
  }
} {
  param($Response)
  [int]$Response.code -ne 0
}

Assert-JsonOk "POST /api/capture/continuous-test unconnected" {
  Invoke-CaptureJson -Method POST -Path "/api/capture/continuous-test" -Body @{
    ips = @($ProbeIp)
    expectedCameras = 1
    rounds = 1
    lines = 1280
    width = 0
    timeoutMs = 1000
    intervalMs = 0
    dataMode = 1
    connectFirst = $false
    stopStreams = $true
    outputDir = "api-smoke/continuous"
  }
} {
  param($Response)
  [int]$Response.code -ne 0 -and [int]$Response.attempts -eq 1
}

Assert-JsonOk "POST /api/stream/start unconnected" {
  Invoke-CaptureJson -Method POST -Path "/api/stream/start" -Body @{
    ip = $ProbeIp
    lines = 1280
    width = 0
    dataMode = 1
    hs = $false
    fpsLimit = 5
  }
} {
  param($Response)
  [int]$Response.code -ne 0
}

Assert-JsonOk "POST /api/stream/stop unconnected" {
  Invoke-CaptureJson -Method POST -Path "/api/stream/stop" -Body @{ ip = $ProbeIp }
} {
  param($Response)
  [int]$Response.code -ne 0
}

Assert-JsonOk "GET /api/stream/status unconnected" {
  Invoke-CaptureJson -Method GET -Path "/api/stream/status?ip=$([uri]::EscapeDataString($ProbeIp))"
} {
  param($Response)
  [int]$Response.code -ne 0
}

try {
  $Response = Invoke-WebRequest -Uri "$Origin/api/stream/latest?ip=$([uri]::EscapeDataString($ProbeIp))&kind=depth" -UseBasicParsing -TimeoutSec 8
  Add-Check "GET /api/stream/latest unconnected" ($Response.StatusCode -in 200, 404) "HTTP $($Response.StatusCode)"
} catch {
  $Status = 0
  if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
    $Status = [int]$_.Exception.Response.StatusCode
  } elseif ($_.Exception.StatusCode) {
    $Status = [int]$_.Exception.StatusCode
  }
  Add-Check "GET /api/stream/latest unconnected" ($Status -eq 0 -or $Status -eq 404) "HTTP $Status"
}

Assert-JsonOk "POST /api/calibration/load missing file" {
  Invoke-CaptureJson -Method POST -Path "/api/calibration/load" -Body @{ ip = $ProbeIp; path = "D:\does-not-exist\calib.xml" }
} {
  param($Response)
  [int]$Response.code -ne 0
}

Assert-JsonOk "POST /api/roi/load missing file" {
  Invoke-CaptureJson -Method POST -Path "/api/roi/load" -Body @{ ip = $ProbeIp; path = "D:\does-not-exist\roi.xml" }
} {
  param($Response)
  [int]$Response.code -ne 0
}

Assert-JsonOk "GET /api/calibration/status unconnected" {
  Invoke-CaptureJson -Method GET -Path "/api/calibration/status?ip=$([uri]::EscapeDataString($ProbeIp))"
} {
  param($Response)
  [int]$Response.code -ne 0
}

$Checks | Format-Table -AutoSize

$Failed = @($Checks | Where-Object { -not $_.ok })
if ($Failed.Count -gt 0) {
  Write-Error "Capture API smoke test failed: $($Failed.Count) check(s) failed."
  exit 1
}

Write-Host "Capture API smoke test passed: $($Checks.Count) checks."
