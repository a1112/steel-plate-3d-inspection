param(
  [string]$CaptureOrigin = "http://127.0.0.1:4317",
  [string]$ServiceOrigin = "http://127.0.0.1:4873",
  [string]$ProfilePath = "",
  [string]$EvidenceRoot = "",
  [ValidateRange(2, 120)]
  [int]$TimeoutSec = 10,
  [switch]$ProfileOnly,
  [switch]$SkipNetworkProbe,
  [switch]$ConnectCameras,
  [switch]$RunCapture,
  [switch]$RequireReady,
  [string]$MaintenanceConfirmation = ""
)

$ErrorActionPreference = "Stop"
$RequiredConfirmation = "CONNECT SICK CAMERAS 6/6"
$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = if (Test-Path -LiteralPath (Join-Path $SourceRoot "config") -PathType Container) {
  $SourceRoot
} else {
  (Resolve-Path $PSScriptRoot).Path
}

if ([string]::IsNullOrWhiteSpace($ProfilePath)) {
  $ProfilePath = Join-Path $RepoRoot "config\sites\sick-array-6\capture.json"
}
$ProfilePath = (Resolve-Path -LiteralPath $ProfilePath).Path
$Profile = Get-Content -LiteralPath $ProfilePath -Raw -Encoding UTF8 | ConvertFrom-Json
$EnabledCameras = @($Profile.cameras | Where-Object { $_.enabled -ne $false })
$ExpectedCameras = [int]$Profile.expectedCameras

if ($ExpectedCameras -ne 6 -or $EnabledCameras.Count -ne 6) {
  throw "Server continuation requires exactly six enabled cameras; profile expected=$ExpectedCameras enabled=$($EnabledCameras.Count)."
}
foreach ($Field in @("ip", "serialNumber", "storageRoot", "key")) {
  $Values = @($EnabledCameras | ForEach-Object { ([string]$_.$Field).Trim() })
  if (@($Values | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0 -or
      @($Values | Sort-Object -Unique).Count -ne 6) {
    throw "Every enabled camera must have a unique non-empty $Field."
  }
}

if (($ConnectCameras -or $RunCapture) -and $ProfileOnly) {
  throw "ProfileOnly cannot be combined with camera mutations."
}
if ($RunCapture -and -not $ConnectCameras) {
  throw "RunCapture requires ConnectCameras so the six-camera gate is checked first."
}
if (($ConnectCameras -or $RunCapture) -and $MaintenanceConfirmation -cne $RequiredConfirmation) {
  throw "Camera mutation requires -MaintenanceConfirmation '$RequiredConfirmation'."
}

$RunId = Get-Date -Format "yyyyMMdd-HHmmss-fff"
if ([string]::IsNullOrWhiteSpace($EvidenceRoot)) {
  $EvidenceRoot = Join-Path $RepoRoot "target\evidence\server-continuation-$RunId"
}
$EvidenceRoot = [System.IO.Path]::GetFullPath($EvidenceRoot)
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Write-JsonEvidence {
  param([string]$Name, [object]$Value)
  $Path = Join-Path $EvidenceRoot "$Name.json"
  [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 50), $Utf8NoBom)
  return $Path
}

function Invoke-EvidenceGet {
  param([string]$Name, [string]$Uri)
  try {
    $Payload = Invoke-RestMethod -Method Get -Uri $Uri -TimeoutSec $TimeoutSec
    $Result = [ordered]@{ ok = $true; uri = $Uri; payload = $Payload; error = "" }
  } catch {
    $Result = [ordered]@{ ok = $false; uri = $Uri; payload = $null; error = $_.Exception.Message }
  }
  $null = Write-JsonEvidence -Name $Name -Value $Result
  return [pscustomobject]$Result
}

function Invoke-EvidencePost {
  param([string]$Name, [string]$Uri, [object]$Body)
  try {
    $Payload = Invoke-RestMethod -Method Post -Uri $Uri -TimeoutSec ([Math]::Max(120, $TimeoutSec)) `
      -ContentType "application/json; charset=utf-8" -Body ($Body | ConvertTo-Json -Compress -Depth 10)
    $Result = [ordered]@{ ok = $true; uri = $Uri; payload = $Payload; error = "" }
  } catch {
    $Result = [ordered]@{ ok = $false; uri = $Uri; payload = $null; error = $_.Exception.Message }
  }
  $null = Write-JsonEvidence -Name $Name -Value $Result
  return [pscustomobject]$Result
}

function Get-CameraIdentityRows {
  param([object]$Statuses)
  $Rows = if ($Statuses -and $Statuses.PSObject.Properties.Name -contains "statuses") {
    @($Statuses.statuses)
  } elseif ($Statuses -and $Statuses.PSObject.Properties.Name -contains "cameras") {
    @($Statuses.cameras)
  } else {
    @()
  }
  foreach ($Camera in $EnabledCameras) {
    $ExpectedIp = [string]$Camera.ip
    $ExpectedSerial = [string]$Camera.serialNumber
    $Match = @($Rows | Where-Object {
      ([string]$_.ip -eq $ExpectedIp) -and
      ([string]$_.sn -eq $ExpectedSerial -or [string]$_.serialNumber -eq $ExpectedSerial)
    } | Select-Object -First 1)
    [ordered]@{
      cameraKey = [string]$Camera.key
      expectedIp = $ExpectedIp
      expectedSerialNumber = $ExpectedSerial
      matched = $Match.Count -eq 1
      connected = $Match.Count -eq 1 -and [bool]$Match[0].connected
      lastError = if ($Match.Count -eq 1) { [string]$Match[0].lastError } else { "identity not returned" }
    }
  }
}

function Get-Readiness {
  param(
    [object]$CaptureHealth,
    [object]$CaptureCameras,
    [object]$CaptureStatuses,
    [object]$CaptureStorage,
    [object]$ServiceHealth,
    [object]$CtiEvidence,
    [object[]]$NetworkRows,
    [int]$ListenerCount
  )
  $IdentityRows = @(Get-CameraIdentityRows -Statuses $CaptureStatuses)
  $Checks = [ordered]@{
    captureReachable = $null -ne $CaptureHealth
    sdkReady = $null -ne $CaptureHealth -and [bool]$CaptureHealth.sdkReady
    providerReady = $null -ne $CaptureHealth -and [bool]$CaptureHealth.providerReady
    liveMode = $null -ne $CaptureHealth -and -not [bool]$CaptureHealth.historyOnly
    configuredCameras = $null -ne $CaptureCameras -and [int]$CaptureCameras.count -eq 6
    connectedCameras = $null -ne $CaptureCameras -and [int]$CaptureCameras.connectedCameras -eq 6
    identitiesMatched = $IdentityRows.Count -eq 6 -and @($IdentityRows | Where-Object { -not $_.matched }).Count -eq 0
    identitiesConnected = $IdentityRows.Count -eq 6 -and @($IdentityRows | Where-Object { -not $_.connected }).Count -eq 0
    storageWritable = $null -ne $CaptureStorage -and [bool]$CaptureStorage.writable
    ctiVerified = $null -ne $CtiEvidence -and [bool]$CtiEvidence.hashMatches
    cameraNetworkReachable = $SkipNetworkProbe -or
      ($NetworkRows.Count -eq 6 -and @($NetworkRows | Where-Object { -not $_.reachable }).Count -eq 0)
    uniqueCaptureListener = $ListenerCount -eq 1
    businessServiceReady = $null -ne $ServiceHealth -and [bool]$ServiceHealth.ok
  }
  return [ordered]@{
    ready = @($Checks.Values | Where-Object { $_ -ne $true }).Count -eq 0
    checks = $Checks
    cameras = $IdentityRows
  }
}

$ProfileSummary = [ordered]@{
  schema = [string]$Profile.schema
  path = $ProfilePath
  name = [string]$Profile.name
  expectedCameras = $ExpectedCameras
  autoConnect = [bool]$Profile.autoConnect
  ctiPath = [string]$Profile.sick.ctiPath
  ctiSha256 = [string]$Profile.sick.ctiSha256
  cameras = @($EnabledCameras | ForEach-Object {
    [ordered]@{
      key = [string]$_.key
      ip = [string]$_.ip
      serialNumber = [string]$_.serialNumber
      storageRoot = [string]$_.storageRoot
    }
  })
}
$null = Write-JsonEvidence -Name "profile" -Value $ProfileSummary

try {
  $GitStatus = @(& git -C $RepoRoot status --short --branch 2>&1)
  $GitHead = @(& git -C $RepoRoot log -1 --oneline 2>&1)
  [System.IO.File]::WriteAllLines((Join-Path $EvidenceRoot "git-status.txt"), $GitStatus, $Utf8NoBom)
  [System.IO.File]::WriteAllLines((Join-Path $EvidenceRoot "git-head.txt"), $GitHead, $Utf8NoBom)
} catch {
  [System.IO.File]::WriteAllText((Join-Path $EvidenceRoot "git-error.txt"), $_.Exception.Message, $Utf8NoBom)
}

if ($ProfileOnly) {
  $Report = [ordered]@{
    schema = "steel.sick-server-continuation.v1"
    code = 0
    mode = "profile-only"
    evidenceRoot = $EvidenceRoot
    profile = $ProfileSummary
    mutations = @()
  }
  $ReportPath = Write-JsonEvidence -Name "report" -Value $Report
  Write-Host "SICK server continuation profile contract passed: $ReportPath"
  return
}

$CtiText = if (-not [string]::IsNullOrWhiteSpace($env:SICK_GENTL_CTI)) {
  $env:SICK_GENTL_CTI
} else {
  [string]$Profile.sick.ctiPath
}
$CtiPath = if ([System.IO.Path]::IsPathRooted($CtiText)) {
  [System.IO.Path]::GetFullPath($CtiText)
} else {
  [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ProfilePath) $CtiText))
}
$CtiExists = Test-Path -LiteralPath $CtiPath -PathType Leaf
$CtiActualHash = if ($CtiExists) { (Get-FileHash -LiteralPath $CtiPath -Algorithm SHA256).Hash.ToLowerInvariant() } else { "" }
$CtiEvidence = [ordered]@{
  path = $CtiPath
  exists = $CtiExists
  expectedSha256 = ([string]$Profile.sick.ctiSha256).ToLowerInvariant()
  actualSha256 = $CtiActualHash
  hashMatches = $CtiExists -and $CtiActualHash -eq ([string]$Profile.sick.ctiSha256).ToLowerInvariant()
}
$null = Write-JsonEvidence -Name "cti" -Value $CtiEvidence

$NetworkRows = @()
if (-not $SkipNetworkProbe) {
  $NetworkRows = @($EnabledCameras | ForEach-Object {
    $Reachable = $false
    try { $Reachable = [bool](Test-Connection -ComputerName ([string]$_.ip) -Count 1 -Quiet -ErrorAction Stop) } catch {}
    [ordered]@{ cameraKey = [string]$_.key; ip = [string]$_.ip; reachable = $Reachable }
  })
}
$null = Write-JsonEvidence -Name "camera-network" -Value $NetworkRows

$CaptureUri = [Uri]$CaptureOrigin
$ListenerRows = @()
$ListenerSource = "Get-NetTCPConnection"
try {
  $ListenerRows = @(Get-NetTCPConnection -LocalPort $CaptureUri.Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, OwningProcess)
} catch {}
if ($ListenerRows.Count -eq 0) {
  # Get-NetTCPConnection can be access-restricted even though the listener is
  # observable. netstat is read-only and still gives us the owning PID needed
  # to enforce the single-owner gate.
  $ListenerSource = "netstat"
  try {
    $ListenerRows = @(& netstat.exe -ano -p TCP 2>$null | ForEach-Object {
      $Parts = @(($_.Trim()) -split "\s+")
      if ($Parts.Count -ge 5 -and $Parts[0] -eq "TCP" -and
          $Parts[1] -match ":$([regex]::Escape([string]$CaptureUri.Port))$" -and
          $Parts[3] -eq "LISTENING") {
        [pscustomobject]@{
          LocalAddress = $Parts[1]
          LocalPort = $CaptureUri.Port
          OwningProcess = [int]$Parts[4]
        }
      }
    })
  } catch {}
}
$ListenerOwnerCount = @($ListenerRows | Select-Object -ExpandProperty OwningProcess -Unique).Count
$ProcessRows = @()
try {
  $ProcessRows = @(Get-CimInstance Win32_Process -ErrorAction Stop |
    Where-Object { $_.CommandLine -match "sick_capture_service|steel-inspection-service|steel-runtime-supervisor" } |
    Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine)
} catch {
  $ProcessRows = @($ListenerRows | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
    Get-Process -Id $_ -ErrorAction SilentlyContinue | Select-Object `
      @{ Name = "ProcessId"; Expression = { $_.Id } }, Name, Path
  })
}
$null = Write-JsonEvidence -Name "runtime-processes" -Value ([ordered]@{
  captureListenerSource = $ListenerSource
  captureListeners = $ListenerRows
  processes = $ProcessRows
})

$CaptureHealthResult = Invoke-EvidenceGet -Name "capture-health" -Uri "$($CaptureOrigin.TrimEnd('/'))/health"
$CaptureCamerasResult = Invoke-EvidenceGet -Name "capture-cameras" -Uri "$($CaptureOrigin.TrimEnd('/'))/api/cameras"
$CaptureStatusesResult = Invoke-EvidenceGet -Name "capture-statuses" -Uri "$($CaptureOrigin.TrimEnd('/'))/api/camera/statuses"
$CaptureStorageResult = Invoke-EvidenceGet -Name "capture-storage" -Uri "$($CaptureOrigin.TrimEnd('/'))/api/storage/status"
$ServiceHealthResult = Invoke-EvidenceGet -Name "service-health" -Uri "$($ServiceOrigin.TrimEnd('/'))/api/health"
$ProductionStatusResult = Invoke-EvidenceGet -Name "production-status" -Uri "$($ServiceOrigin.TrimEnd('/'))/api/production/status"

if ($ConnectCameras) {
  if (-not $CaptureHealthResult.ok -or [bool]$CaptureHealthResult.payload.historyOnly) {
    throw "Live SICK sidecar is required before connect-all; stop the history-only instance and start the unique live owner."
  }
  if (-not [bool]$CaptureHealthResult.payload.sdkReady) {
    throw "SICK SDK/CTI is not ready; connect-all is blocked."
  }
  if ([bool]$CaptureHealthResult.payload.cameraConnection.inProgress) {
    throw "camera_connection_in_progress: wait for the current connection owner to finish."
  }
  if ($ListenerOwnerCount -ne 1) {
    throw "Exactly one capture listener owner is required on port $($CaptureUri.Port); found $ListenerOwnerCount."
  }
  if (-not $ProductionStatusResult.ok -or $null -ne $ProductionStatusResult.payload.activeSession -or
      [int]$ProductionStatusResult.payload.admission.inFlight -ne 0) {
    throw "Production must be idle with no active session or in-flight request before connecting cameras."
  }

  $ConnectResult = Invoke-EvidencePost -Name "capture-connect-all" `
    -Uri "$($CaptureOrigin.TrimEnd('/'))/api/cameras/connect-all" `
    -Body @{ expectedCameras = 6; devType = -1 }
  if (-not $ConnectResult.ok -or [int]$ConnectResult.payload.code -ne 0 -or
      [int]$ConnectResult.payload.connectedCameras -ne 6) {
    throw "Six-camera connect-all failed; inspect capture-connect-all.json and capture logs."
  }

  $CaptureHealthResult = Invoke-EvidenceGet -Name "capture-health-after-connect" -Uri "$($CaptureOrigin.TrimEnd('/'))/health"
  $CaptureCamerasResult = Invoke-EvidenceGet -Name "capture-cameras-after-connect" -Uri "$($CaptureOrigin.TrimEnd('/'))/api/cameras"
  $CaptureStatusesResult = Invoke-EvidenceGet -Name "capture-statuses-after-connect" -Uri "$($CaptureOrigin.TrimEnd('/'))/api/camera/statuses"
  $ServiceHealthResult = Invoke-EvidenceGet -Name "service-health-after-connect" -Uri "$($ServiceOrigin.TrimEnd('/'))/api/health"
}

$Readiness = Get-Readiness `
  -CaptureHealth $CaptureHealthResult.payload `
  -CaptureCameras $CaptureCamerasResult.payload `
  -CaptureStatuses $CaptureStatusesResult.payload `
  -CaptureStorage $CaptureStorageResult.payload `
  -ServiceHealth $ServiceHealthResult.payload `
  -CtiEvidence $CtiEvidence `
  -NetworkRows $NetworkRows `
  -ListenerCount $ListenerOwnerCount

$Mutations = @()
if ($ConnectCameras) { $Mutations += "connect-all" }
if ($RunCapture) {
  if (-not $Readiness.ready) {
    throw "Controlled capture is blocked until every six-camera readiness gate passes."
  }
  $ContinuousScript = @(
    (Join-Path $PSScriptRoot "test-capture-continuous.ps1"),
    (Join-Path $RepoRoot "test-capture-continuous.ps1")
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $ContinuousScript) {
    throw "test-capture-continuous.ps1 was not found."
  }
  & $ContinuousScript -Origin $CaptureOrigin -ExpectedCameras 6 -Rounds 1 -SkipPreset `
    -OutputDir "acceptance\server-continuation-$RunId"
  if (-not $?) {
    throw "Controlled six-camera capture failed."
  }
  $Mutations += "one-round-continuous-capture"
}

$Report = [ordered]@{
  schema = "steel.sick-server-continuation.v1"
  code = if ($Readiness.ready) { 0 } else { 2 }
  mode = if ($RunCapture) { "capture" } elseif ($ConnectCameras) { "connect" } else { "read-only" }
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  evidenceRoot = $EvidenceRoot
  profile = $ProfileSummary
  cti = $CtiEvidence
  network = $NetworkRows
  listenerCount = $ListenerOwnerCount
  readiness = $Readiness
  cameraConnection = $CaptureHealthResult.payload.cameraConnection
  mutations = $Mutations
}
$ReportPath = Write-JsonEvidence -Name "report" -Value $Report
Write-Host "SICK server continuation evidence: $ReportPath"
if (-not $Readiness.ready) {
  Write-Warning "Six-camera runtime is not ready; inspect report.json and the endpoint evidence files."
}
if (($RequireReady -or $ConnectCameras -or $RunCapture) -and -not $Readiness.ready) {
  throw "Six-camera server continuation readiness failed."
}
