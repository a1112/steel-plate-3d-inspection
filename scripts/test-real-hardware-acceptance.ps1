param(
  [string]$CaptureOrigin = "http://127.0.0.1:4317",
  [string]$ServiceOrigin = "http://127.0.0.1:4873",
  [string]$TriggerOrigin = "http://127.0.0.1:4881",
  [string]$ClientOrigin = "http://127.0.0.1:1432/?app=terminal",
  [string]$CaptureRoot = "H:\",
  [int]$ExpectedCameras = 6,
  [int]$Rounds = 1,
  [int]$Lines = 1000,
  [int]$Width = 0,
  [int]$TimeoutMs = 8000,
  [int]$IntervalMs = 500,
  [int]$Retries = 0,
  [int]$ControlMode = 0,
  [int]$DataMode = 3,
  [int]$TimeoutSec = 15,
  [string]$MaterialId = "",
  [string]$ReportDir = "",
  [switch]$RunCapture,
  [switch]$ConnectFirst,
  [switch]$SkipTrigger,
  [switch]$SkipClient,
  [switch]$AllowOffline
)

$ErrorActionPreference = "Stop"

# Expected production layout: H:\camera1..camera6\<material>\{depth,intensity,metadata}; sdk-derived stays disabled by default.
$ExpectedCameraDirs = 1..$ExpectedCameras | ForEach-Object { "camera$_" }
$KnownClockwiseIps = @(
  "192.168.101.100",
  "192.168.102.100",
  "192.168.103.100",
  "192.168.104.100",
  "192.168.105.13",
  "192.168.106.100"
)

function Join-OriginPath {
  param(
    [string]$Origin,
    [string]$Path
  )
  return $Origin.TrimEnd("/") + "/" + $Path.TrimStart("/")
}

function Convert-JsonBody {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) {
    return $null
  }
  return $Text | ConvertFrom-Json
}

function Invoke-HttpJson {
  param(
    [ValidateSet("GET", "POST")]
    [string]$Method,
    [string]$Uri,
    [object]$Body = $null,
    [int[]]$AllowedStatusCodes = @(200),
    [int]$RequestTimeoutSec = $TimeoutSec
  )

  $JsonBody = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Compress -Depth 20 }
  try {
    if ($Method -eq "GET") {
      $Response = Invoke-WebRequest -Method Get -Uri $Uri -UseBasicParsing -TimeoutSec $RequestTimeoutSec
    } else {
      $Response = Invoke-WebRequest -Method Post -Uri $Uri -UseBasicParsing -ContentType "application/json; charset=utf-8" -Body $JsonBody -TimeoutSec $RequestTimeoutSec
    }
    $StatusCode = [int]$Response.StatusCode
    $Content = [string]$Response.Content
  } catch {
    $WebResponse = $_.Exception.Response
    if ($null -eq $WebResponse) {
      throw
    }
    $StatusCode = [int]$WebResponse.StatusCode
    $Reader = [System.IO.StreamReader]::new($WebResponse.GetResponseStream())
    try {
      $Content = $Reader.ReadToEnd()
    } finally {
      $Reader.Dispose()
    }
  }

  if ($AllowedStatusCodes -notcontains $StatusCode) {
    throw "Unexpected HTTP $StatusCode from $Uri`: $Content"
  }

  [pscustomobject]@{
    statusCode = $StatusCode
    json = Convert-JsonBody $Content
    content = $Content
  }
}

function Test-HtmlEndpoint {
  param([string]$Uri)
  $Response = Invoke-WebRequest -Method Get -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSec
  return [ordered]@{
    ok = ($Response.StatusCode -eq 200 -and ([string]$Response.Content) -match "<html")
    statusCode = [int]$Response.StatusCode
    bytes = ([string]$Response.Content).Length
  }
}

function Test-JsonProperty {
  param(
    [object]$Object,
    [string]$Name
  )
  return $null -ne $Object -and ($Object.PSObject.Properties.Name -contains $Name)
}

function Get-NetworkRateSummary {
  param([object]$NetworkJson)

  $Interfaces = @($NetworkJson.interfaces)
  $HasTotals = $true
  foreach ($RequiredProperty in @("totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps")) {
    $HasTotals = $HasTotals -and (Test-JsonProperty $NetworkJson $RequiredProperty)
  }
  $HasInterfaceRates = $false
  if ($Interfaces.Count -gt 0) {
    $FirstInterface = $Interfaces[0]
    $HasInterfaceRates = $true
    foreach ($RequiredProperty in @("uploadMbps", "downloadMbps", "bandwidthMbps", "online")) {
      $HasInterfaceRates = $HasInterfaceRates -and (Test-JsonProperty $FirstInterface $RequiredProperty)
    }
  }

  return [ordered]@{
    code = $NetworkJson.code
    source = $NetworkJson.source
    interfaces = $Interfaces.Count
    totalUploadMbps = if (Test-JsonProperty $NetworkJson "totalUploadMbps") { [double]$NetworkJson.totalUploadMbps } else { $null }
    totalDownloadMbps = if (Test-JsonProperty $NetworkJson "totalDownloadMbps") { [double]$NetworkJson.totalDownloadMbps } else { $null }
    totalBandwidthMbps = if (Test-JsonProperty $NetworkJson "totalBandwidthMbps") { [double]$NetworkJson.totalBandwidthMbps } else { $null }
    rateFields = ($HasTotals -and $HasInterfaceRates)
  }
}

function Normalize-PathText {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    return ""
  }
  try {
    return ([System.IO.Path]::GetFullPath($Path.Trim())).TrimEnd("\", "/").ToLowerInvariant()
  } catch {
    return $Path.Trim().Replace("/", "\").TrimEnd("\").ToLowerInvariant()
  }
}

function ConvertTo-SafeStorageSegment {
  param([string]$Value)
  $Segment = (($Value.ToCharArray() | ForEach-Object {
        $Char = [char]$_
        if (([int]$Char -ge [int][char]'a' -and [int]$Char -le [int][char]'z') -or
          ([int]$Char -ge [int][char]'A' -and [int]$Char -le [int][char]'Z') -or
          ([int]$Char -ge [int][char]'0' -and [int]$Char -le [int][char]'9') -or
          $Char -eq '-' -or $Char -eq '_' -or $Char -eq '.') {
          [string]$Char
        } else {
          "_"
        }
      }) -join "").Trim("_")
  if ([string]::IsNullOrWhiteSpace($Segment)) {
    return "unknown"
  }
  return $Segment
}

function Get-ExpectedProductionSummaryPath {
  param(
    [string]$Root,
    [string]$Material,
    [string]$Session
  )
  return Join-Path (Join-Path (Join-Path $Root "production") (ConvertTo-SafeStorageSegment $Material)) (Join-Path (ConvertTo-SafeStorageSegment $Session) "summary.json")
}

function Add-Failure {
  param(
    [System.Collections.Generic.List[string]]$Failures,
    [string]$Message
  )
  $Failures.Add($Message)
}

function Test-Condition {
  param(
    [System.Collections.Generic.List[string]]$Failures,
    [bool]$Condition,
    [string]$Message
  )
  if (-not $Condition) {
    Add-Failure -Failures $Failures -Message $Message
  }
}

function Get-ReportRoot {
  if (-not [string]::IsNullOrWhiteSpace($ReportDir)) {
    return [System.IO.Path]::GetFullPath($ReportDir)
  }
  if (Test-Path (Join-Path $PSScriptRoot "manifest.json") -PathType Leaf) {
    return Join-Path $PSScriptRoot "logs\real-hardware-acceptance"
  }
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  return Join-Path $RepoRoot "target\logs\real-hardware-acceptance"
}

function Write-AcceptanceReport {
  param(
    [System.Collections.IDictionary]$Report,
    [string]$Root,
    [string]$Name = "real-hardware-acceptance",
    [int]$Depth = 14
  )

  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  $ReportPath = Join-Path $Root ("{0}-{1}.json" -f $Name, (Get-Date -Format "yyyyMMdd-HHmmss-fff"))
  $Report["reportPath"] = $ReportPath
  $Report | ConvertTo-Json -Depth $Depth | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  return $ReportPath
}

function Get-CaptureTimeoutSec {
  $perRoundMs = ($TimeoutMs * ([Math]::Max(0, $Retries) + 1)) + $IntervalMs
  return [Math]::Max(60, [Math]::Ceiling((($perRoundMs * [Math]::Max(1, $Rounds)) + 90000) / 1000))
}

function Read-LatestArtifactMeta {
  param(
    [string]$Ip,
    [string]$Kind
  )
  try {
    $Uri = (Join-OriginPath $CaptureOrigin "/api/capture/latest") + "?ip=$([uri]::EscapeDataString($Ip))&kind=$Kind&meta=1"
    $Response = Invoke-HttpJson -Method GET -Uri $Uri -AllowedStatusCodes @(200, 404)
    return [ordered]@{
      ok = $Response.statusCode -eq 200
      statusCode = $Response.statusCode
      json = $Response.json
    }
  } catch {
    return [ordered]@{
      ok = $false
      error = $_.Exception.Message
    }
  }
}

function Test-ProductionLayout {
  param(
    [string]$Root,
    [string]$Material,
    [string[]]$CameraDirs,
    [int]$MinimumFiles
  )

  $Rows = foreach ($CameraDir in $CameraDirs) {
    $Base = Join-Path (Join-Path $Root $CameraDir) $Material
    $DepthDir = Join-Path $Base "depth"
    $IntensityDir = Join-Path $Base "intensity"
    $MetadataDir = Join-Path $Base "metadata"
    $SdkDir = Join-Path $Base "sdk-derived"
    [ordered]@{
      camera = $CameraDir
      root = $Base
      depth = if (Test-Path $DepthDir -PathType Container) { @(Get-ChildItem -LiteralPath $DepthDir -File -ErrorAction SilentlyContinue).Count } else { 0 }
      intensity = if (Test-Path $IntensityDir -PathType Container) { @(Get-ChildItem -LiteralPath $IntensityDir -File -ErrorAction SilentlyContinue).Count } else { 0 }
      metadata = if (Test-Path $MetadataDir -PathType Container) { @(Get-ChildItem -LiteralPath $MetadataDir -File -ErrorAction SilentlyContinue).Count } else { 0 }
      sdkDerivedExists = Test-Path $SdkDir -PathType Container
      complete = (Test-Path $DepthDir -PathType Container) -and
        (Test-Path $IntensityDir -PathType Container) -and
        (Test-Path $MetadataDir -PathType Container) -and
        (@(Get-ChildItem -LiteralPath $DepthDir -File -ErrorAction SilentlyContinue).Count -ge $MinimumFiles) -and
        (@(Get-ChildItem -LiteralPath $IntensityDir -File -ErrorAction SilentlyContinue).Count -ge $MinimumFiles) -and
        (@(Get-ChildItem -LiteralPath $MetadataDir -File -ErrorAction SilentlyContinue).Count -ge $MinimumFiles) -and
        -not (Test-Path $SdkDir -PathType Container)
    }
  }
  return @($Rows)
}

function Get-ProviderResultRows {
  param([object]$Provider)

  return @($Provider.results | ForEach-Object {
      $SdkOutput = [string]$_.sdkOutput
      $SdkDepthOutput = [string]$_.sdkDepthOutput
      $SdkIntensityOutput = [string]$_.sdkIntensityOutput
      [ordered]@{
        round = [int]$_.round
        parallelIndex = [int]$_.parallelIndex
        ip = [string]$_.ip
        code = [int]$_.code
        errorName = [string]$_.errorName
        operatorHint = [string]$_.operatorHint
        completeFrame = [bool]$_.completeFrame
        depthExists = [bool]$_.depthExists
        intensityExists = [bool]$_.intensityExists
        metadataExists = [bool]$_.metadataExists
        discarded = [bool]$_.discarded
        discardReason = [string]$_.discardReason
        width = [int]$_.width
        lines = [int]$_.lines
        fid = [int]$_.fid
        lostLines = [int]$_.lostLines
        triggerMinInterval = $_.triggerMinInterval
        triggerMaxInterval = $_.triggerMaxInterval
        depthOutput = [string]$_.depthOutput
        intensityOutput = [string]$_.intensityOutput
        metadataOutput = [string]$_.metadataOutput
        sdkDerivedWritten = -not (
          [string]::IsNullOrWhiteSpace($SdkOutput) -and
          [string]::IsNullOrWhiteSpace($SdkDepthOutput) -and
          [string]::IsNullOrWhiteSpace($SdkIntensityOutput)
        )
      }
    })
}

function Get-CameraStatusRows {
  param([object[]]$Statuses)

  return @($Statuses | ForEach-Object {
      [ordered]@{
        ip = [string]$_.ip
        connected = [bool]$_.connected
        sdkStatus = [string]$_.sdkStatus
        acquisitionState = [string]$_.acquisitionState
        streamRunning = [bool]$_.streamRunning
        controlMode = $_.captureConfig.controlMode
        triggerInputType = $_.captureConfig.triggerInputType
        captureDataType = $_.captureConfig.captureDataType
        triggerLines = $_.captureConfig.triggerLines
        timeTriggerFreq = $_.captureConfig.timeTriggerFreq
        maxFrameRate = $_.captureConfig.maxFrameRate
        exposureTime = $_.captureConfig.exposureTime
        gainK = $_.captureConfig.gainK
      }
    })
}

$Failures = [System.Collections.Generic.List[string]]::new()
$StartedAt = Get-Date
$ReportRoot = Get-ReportRoot
New-Item -ItemType Directory -Force -Path $ReportRoot | Out-Null
if ([string]::IsNullOrWhiteSpace($MaterialId)) {
  $MaterialId = "BAR-HW-" + (Get-Date -Format "yyyyMMdd-HHmmss")
}

try {
  $CaptureHealth = Invoke-HttpJson -Method GET -Uri (Join-OriginPath $CaptureOrigin "/health")
  $StorageStatus = Invoke-HttpJson -Method GET -Uri (Join-OriginPath $CaptureOrigin "/api/storage/status")
  $ConfigStatus = Invoke-HttpJson -Method GET -Uri (Join-OriginPath $CaptureOrigin "/api/config/status")
  $Cameras = Invoke-HttpJson -Method GET -Uri (Join-OriginPath $CaptureOrigin "/api/cameras")
  $Statuses = Invoke-HttpJson -Method GET -Uri (Join-OriginPath $CaptureOrigin "/api/camera/statuses")
  $ServiceStatus = Invoke-HttpJson -Method GET -Uri (Join-OriginPath $ServiceOrigin "/api/production/status")
  $NetworkStatus = Invoke-HttpJson -Method GET -Uri (Join-OriginPath $ServiceOrigin "/api/system/network")
  $TriggerStatus = if ($SkipTrigger) { $null } else { Invoke-HttpJson -Method GET -Uri (Join-OriginPath $TriggerOrigin "/api/trigger/status") }
  $ClientStatus = if ($SkipClient) { $null } else { Test-HtmlEndpoint -Uri $ClientOrigin }
} catch {
  $Offline = [ordered]@{
    code = if ($AllowOffline) { 2 } else { 1 }
    checkedAt = (Get-Date).ToString("o")
    mode = if ($RunCapture) { "capture" } else { "read-only" }
    error = $_.Exception.Message
    allowOffline = [bool]$AllowOffline
  }
  $null = Write-AcceptanceReport -Report $Offline -Root $ReportRoot -Name "real-hardware-acceptance-offline" -Depth 8
  $Offline | ConvertTo-Json -Depth 6
  if ($AllowOffline) {
    exit 0
  }
  exit 1
}

$CameraList = @($Cameras.json.cameras)
$StatusList = @($Statuses.json.statuses)
$StatusRows = Get-CameraStatusRows -Statuses $StatusList
$NetworkSummary = Get-NetworkRateSummary -NetworkJson $NetworkStatus.json
$StorageRoots = @($StorageStatus.json.cameraRoots)
$ConfigRoots = @($ConfigStatus.json.cameraRoots)
$RootSet = @{}
foreach ($Root in $StorageRoots) {
  $RootSet[(Normalize-PathText ([string]$Root.root))] = $Root
}
$ExpectedRootRows = foreach ($CameraDir in $ExpectedCameraDirs) {
  $ExpectedRoot = Join-Path $CaptureRoot $CameraDir
  $Normalized = Normalize-PathText $ExpectedRoot
  $Mapped = if ($RootSet.ContainsKey($Normalized)) { $RootSet[$Normalized] } else { $null }
  [ordered]@{
    camera = $CameraDir
    expectedRoot = $ExpectedRoot
    mapped = $null -ne $Mapped
    ip = if ($Mapped) { [string]$Mapped.ip } else { "" }
    exists = if ($Mapped -and $null -ne $Mapped.exists) { [bool]$Mapped.exists } else { Test-Path $ExpectedRoot -PathType Container }
    writable = if ($Mapped -and $null -ne $Mapped.writable) { [bool]$Mapped.writable } else { $null }
  }
}
$DiscoveredIps = @($CameraList | ForEach-Object { [string]$_.ip } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$LatestArtifacts = foreach ($Ip in @($DiscoveredIps | Select-Object -First $ExpectedCameras)) {
  [ordered]@{
    ip = $Ip
    depth = Read-LatestArtifactMeta -Ip $Ip -Kind "depth"
    intensity = Read-LatestArtifactMeta -Ip $Ip -Kind "intensity"
    metadata = Read-LatestArtifactMeta -Ip $Ip -Kind "metadata"
  }
}

Test-Condition -Failures $Failures -Condition ($CaptureHealth.json.code -eq 0 -or $CaptureHealth.json.sdkReady -eq $true) -Message "Capture provider health did not report a healthy SDK/provider."
Test-Condition -Failures $Failures -Condition ($Cameras.json.code -eq 0) -Message "Camera discovery returned non-zero code."
Test-Condition -Failures $Failures -Condition ($DiscoveredIps.Count -ge $ExpectedCameras) -Message "Discovered $($DiscoveredIps.Count) camera(s), expected at least $ExpectedCameras."
Test-Condition -Failures $Failures -Condition (Test-Path $CaptureRoot -PathType Container) -Message "Capture root drive/folder does not exist: $CaptureRoot"
Test-Condition -Failures $Failures -Condition ([bool]$StorageStatus.json.writable) -Message "Provider storage root is not writable."
Test-Condition -Failures $Failures -Condition ($StorageRoots.Count -ge $ExpectedCameras) -Message "Provider returned $($StorageRoots.Count) camera storage root(s), expected $ExpectedCameras."
foreach ($Row in $ExpectedRootRows) {
  Test-Condition -Failures $Failures -Condition ([bool]$Row.mapped) -Message "No provider camera root maps to $($Row.expectedRoot)."
}
Test-Condition -Failures $Failures -Condition ($ServiceStatus.json.code -eq 0) -Message "Rust production service status returned non-zero code."
Test-Condition -Failures $Failures -Condition ($NetworkStatus.json.code -eq 0 -and @($NetworkStatus.json.interfaces).Count -gt 0) -Message "Rust service network monitor did not report interfaces."
Test-Condition -Failures $Failures -Condition ([bool]$NetworkSummary.rateFields) -Message "Rust service network monitor did not report realtime upload/download/bandwidth fields."
if (-not $SkipTrigger) {
  Test-Condition -Failures $Failures -Condition ($TriggerStatus.json.code -eq 0) -Message "Trigger gateway status returned non-zero code."
}
if (-not $SkipClient) {
  Test-Condition -Failures $Failures -Condition ([bool]$ClientStatus.ok) -Message "Terminal client did not return HTML."
}

$ConnectResult = $null
if ($ConnectFirst -and $Failures.Count -eq 0) {
  $ConnectResult = Invoke-HttpJson -Method POST -Uri (Join-OriginPath $CaptureOrigin "/api/cameras/connect-all") -Body @{
    expectedCameras = $ExpectedCameras
    devType = -1
  } -RequestTimeoutSec 60
  Test-Condition -Failures $Failures -Condition ($ConnectResult.json.code -eq 0) -Message "Connect-all returned non-zero code."
  $Statuses = Invoke-HttpJson -Method GET -Uri (Join-OriginPath $CaptureOrigin "/api/camera/statuses")
  $StatusList = @($Statuses.json.statuses)
  $StatusRows = Get-CameraStatusRows -Statuses $StatusList
}

if (($RunCapture -or $ConnectFirst) -and $Failures.Count -eq 0) {
  $ConnectedRows = @($StatusRows | Where-Object { $_.connected })
  Test-Condition -Failures $Failures -Condition ($ConnectedRows.Count -ge $ExpectedCameras) -Message "Connected $($ConnectedRows.Count) camera(s), expected at least $ExpectedCameras."
  foreach ($Row in @($ConnectedRows | Select-Object -First $ExpectedCameras)) {
    Test-Condition -Failures $Failures -Condition ([int]$Row.controlMode -eq $ControlMode) -Message "Camera $($Row.ip) controlMode readback $($Row.controlMode), expected $ControlMode."
    Test-Condition -Failures $Failures -Condition ([int]$Row.triggerInputType -eq 4) -Message "Camera $($Row.ip) triggerInputType readback $($Row.triggerInputType), expected 4 (time trigger)."
    Test-Condition -Failures $Failures -Condition ([int]$Row.triggerLines -eq $Lines) -Message "Camera $($Row.ip) triggerLines readback $($Row.triggerLines), expected $Lines."
    Test-Condition -Failures $Failures -Condition ([int]$Row.timeTriggerFreq -gt 0) -Message "Camera $($Row.ip) timeTriggerFreq readback was not positive."
  }
}

$CaptureResult = $null
$PostCaptureStatus = $null
$ProductionSummary = $null
$ProviderRows = @()
$LayoutRows = @()
if ($RunCapture -and $Failures.Count -eq 0) {
  $EventBody = @{
    materialId = $MaterialId
    steelId = $MaterialId
    source = "real-hardware-acceptance"
    mode = "manual"
    triggerMode = "manual"
    acquisitionMode = "manual"
    autoCapture = $false
    discardBlackFrames = $true
    saveSdkDerived = $false
    steelType = "round-bar"
  }

  $SteelInOk = $false
  try {
    $null = Invoke-HttpJson -Method POST -Uri (Join-OriginPath $ServiceOrigin "/api/production/steel-info") -Body $EventBody
    $SteelIn = Invoke-HttpJson -Method POST -Uri (Join-OriginPath $ServiceOrigin "/api/production/steel-in") -Body $EventBody
    $SteelInOk = $true
    Test-Condition -Failures $Failures -Condition ($SteelIn.json.code -eq 0) -Message "Production steel-in returned non-zero code."
    Test-Condition -Failures $Failures -Condition ($SteelIn.json.flow.recordWrittenBeforeCapture -eq $true) -Message "Production steel-in did not prove record-before-capture."

    $CaptureBody = @{
      materialId = $MaterialId
      expectedCameras = $ExpectedCameras
      rounds = $Rounds
      lines = $Lines
      width = $Width
      timeoutMs = $TimeoutMs
      intervalMs = $IntervalMs
      retries = $Retries
      controlMode = $ControlMode
      dataMode = $DataMode
      connectFirst = [bool]$ConnectFirst
      stopStreams = $true
      steelStateAware = $true
      requireSteelPresent = $true
      productionLayout = $true
      saveSdkDerived = $false
      discardBlackFrames = $true
      ips = @($DiscoveredIps | Select-Object -First $ExpectedCameras)
    }
    $CaptureResult = Invoke-HttpJson -Method POST -Uri (Join-OriginPath $ServiceOrigin "/api/production/capture-once") -Body $CaptureBody -RequestTimeoutSec (Get-CaptureTimeoutSec)
    $Provider = $CaptureResult.json.provider
    $ProviderRows = Get-ProviderResultRows -Provider $Provider
    Test-Condition -Failures $Failures -Condition ($CaptureResult.json.code -eq 0) -Message "Production capture-once returned non-zero code."
    Test-Condition -Failures $Failures -Condition ($Provider.parallel -eq $true) -Message "Provider did not report parallel synchronized capture."
    Test-Condition -Failures $Failures -Condition ($Provider.workerCount -ge $ExpectedCameras) -Message "Provider worker count $($Provider.workerCount) is below expected $ExpectedCameras."
    Test-Condition -Failures $Failures -Condition ($Provider.saveSdkDerived -eq $false) -Message "Provider saveSdkDerived was not false."
    Test-Condition -Failures $Failures -Condition ($Provider.failures -eq 0) -Message "Provider reported capture failures: $($Provider.failures)."
    Test-Condition -Failures $Failures -Condition ($Provider.completeFrames -ge ($ExpectedCameras * $Rounds)) -Message "Provider completeFrames $($Provider.completeFrames) below expected $($ExpectedCameras * $Rounds)."
    Test-Condition -Failures $Failures -Condition ($Provider.metadataFrames -ge ($ExpectedCameras * $Rounds)) -Message "Provider metadataFrames $($Provider.metadataFrames) below expected $($ExpectedCameras * $Rounds)."
    Test-Condition -Failures $Failures -Condition ($ProviderRows.Count -ge ($ExpectedCameras * $Rounds)) -Message "Provider returned $($ProviderRows.Count) per-camera result row(s), expected at least $($ExpectedCameras * $Rounds)."
    Test-Condition -Failures $Failures -Condition ([int]$CaptureResult.json.record.captureFileRows -ge ($ExpectedCameras * $Rounds * 3)) -Message "Rust record captureFileRows $($CaptureResult.json.record.captureFileRows) below expected $($ExpectedCameras * $Rounds * 3)."
    foreach ($Row in $ProviderRows) {
      Test-Condition -Failures $Failures -Condition ($Row.code -eq 0) -Message "Capture failed for $($Row.ip) round $($Row.round): code=$($Row.code), error=$($Row.errorName), hint=$($Row.operatorHint)."
      Test-Condition -Failures $Failures -Condition ([bool]$Row.completeFrame) -Message "Incomplete frame for $($Row.ip) round $($Row.round): depth=$($Row.depthExists), intensity=$($Row.intensityExists), metadata=$($Row.metadataExists)."
      Test-Condition -Failures $Failures -Condition (-not [bool]$Row.sdkDerivedWritten) -Message "sdk-derived output was written for $($Row.ip) even though saveSdkDerived=false."
    }
  } finally {
    if ($SteelInOk) {
      try {
        $null = Invoke-HttpJson -Method POST -Uri (Join-OriginPath $ServiceOrigin "/api/production/steel-out") -Body $EventBody
      } catch {
        Add-Failure -Failures $Failures -Message "Production steel-out failed after capture: $($_.Exception.Message)"
      }
    }
  }

  $LayoutRows = Test-ProductionLayout -Root $CaptureRoot -Material $MaterialId -CameraDirs $ExpectedCameraDirs -MinimumFiles $Rounds
  foreach ($Row in $LayoutRows) {
    Test-Condition -Failures $Failures -Condition ([bool]$Row.complete) -Message "Incomplete production layout for $($Row.camera): depth=$($Row.depth), intensity=$($Row.intensity), metadata=$($Row.metadata), sdkDerived=$($Row.sdkDerivedExists)."
  }

  if ($null -ne $CaptureResult) {
    $ExpectedSummaryPath = Get-ExpectedProductionSummaryPath -Root $CaptureRoot -Material $MaterialId -Session ([string]$CaptureResult.json.sessionId)
    $ProviderSummaryPath = [string]$CaptureResult.json.provider.summaryOutput
    $ProductionSummary = [ordered]@{
      expected = $ExpectedSummaryPath
      provider = $ProviderSummaryPath
      providerExists = Test-Path -LiteralPath $ProviderSummaryPath -PathType Leaf
      providerMatchesExpected = (Normalize-PathText $ProviderSummaryPath) -eq (Normalize-PathText $ExpectedSummaryPath)
      latestInspection = ""
      latestInspectionExists = $false
      latestInspectionMatchesExpected = $false
      schema = ""
      fileCount = 0
      depth = 0
      intensity = 0
      metadata = 0
      sdkDerived = 0
    }
    Test-Condition -Failures $Failures -Condition ([bool]$ProductionSummary.providerMatchesExpected) -Message "Provider summaryOutput was not the production summary path. expected=$ExpectedSummaryPath actual=$ProviderSummaryPath"
    Test-Condition -Failures $Failures -Condition ([bool]$ProductionSummary.providerExists) -Message "Provider production summary file does not exist: $ProviderSummaryPath"

    $PostCaptureStatus = Invoke-HttpJson -Method GET -Uri (Join-OriginPath $ServiceOrigin "/api/production/status")
    $LatestSummaryPath = [string]$PostCaptureStatus.json.latestInspection.summaryPath
    $ProductionSummary.latestInspection = $LatestSummaryPath
    $ProductionSummary.latestInspectionExists = Test-Path -LiteralPath $LatestSummaryPath -PathType Leaf
    $ProductionSummary.latestInspectionMatchesExpected = (Normalize-PathText $LatestSummaryPath) -eq (Normalize-PathText $ExpectedSummaryPath)
    Test-Condition -Failures $Failures -Condition ([bool]$ProductionSummary.latestInspectionMatchesExpected) -Message "Latest inspection summaryPath was not the production summary path. expected=$ExpectedSummaryPath actual=$LatestSummaryPath"
    Test-Condition -Failures $Failures -Condition ([bool]$ProductionSummary.latestInspectionExists) -Message "Latest inspection summary file does not exist: $LatestSummaryPath"
    if ($ProductionSummary.latestInspectionExists) {
      try {
        $SummaryJson = Get-Content -LiteralPath $LatestSummaryPath -Raw | ConvertFrom-Json
        $ProductionSummary.schema = [string]$SummaryJson.schema
        $ProductionSummary.fileCount = [int]$SummaryJson.captureFiles.count
        $ProductionSummary.depth = [int]$SummaryJson.captureFiles.depth
        $ProductionSummary.intensity = [int]$SummaryJson.captureFiles.intensity
        $ProductionSummary.metadata = [int]$SummaryJson.captureFiles.metadata
        $ProductionSummary.sdkDerived = [int]$SummaryJson.captureFiles.sdkDerived
      } catch {
        Add-Failure -Failures $Failures -Message "Production summary is not readable JSON: $LatestSummaryPath`: $($_.Exception.Message)"
      }
      Test-Condition -Failures $Failures -Condition ($ProductionSummary.schema -eq "steel.production.summary.v1") -Message "Production summary schema mismatch: $($ProductionSummary.schema)"
      Test-Condition -Failures $Failures -Condition ($ProductionSummary.fileCount -ge ($ExpectedCameras * $Rounds * 3)) -Message "Production summary fileCount $($ProductionSummary.fileCount) below expected $($ExpectedCameras * $Rounds * 3)."
      Test-Condition -Failures $Failures -Condition ($ProductionSummary.depth -ge ($ExpectedCameras * $Rounds)) -Message "Production summary depth count $($ProductionSummary.depth) below expected $($ExpectedCameras * $Rounds)."
      Test-Condition -Failures $Failures -Condition ($ProductionSummary.intensity -ge ($ExpectedCameras * $Rounds)) -Message "Production summary intensity count $($ProductionSummary.intensity) below expected $($ExpectedCameras * $Rounds)."
      Test-Condition -Failures $Failures -Condition ($ProductionSummary.metadata -ge ($ExpectedCameras * $Rounds)) -Message "Production summary metadata count $($ProductionSummary.metadata) below expected $($ExpectedCameras * $Rounds)."
      Test-Condition -Failures $Failures -Condition ($ProductionSummary.sdkDerived -eq 0) -Message "Production summary should keep sdk-derived disabled by default; got $($ProductionSummary.sdkDerived)."
    }
    Test-Condition -Failures $Failures -Condition ($null -eq $PostCaptureStatus.json.activeSession) -Message "Production activeSession should be null after steel-out."
  }
}

$Report = [ordered]@{
  code = if ($Failures.Count -eq 0) { 0 } else { 1 }
  checkedAt = (Get-Date).ToString("o")
  elapsedSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 3)
  mode = if ($RunCapture) { "capture" } else { "read-only" }
  materialId = if ($RunCapture) { $MaterialId } else { $null }
  captureRoot = $CaptureRoot
  expectedCameras = $ExpectedCameras
  origins = [ordered]@{
    capture = $CaptureOrigin
    service = $ServiceOrigin
    trigger = if ($SkipTrigger) { $null } else { $TriggerOrigin }
    client = if ($SkipClient) { $null } else { $ClientOrigin }
  }
  checks = [ordered]@{
    captureHealth = $CaptureHealth.json
    storage = [ordered]@{
      root = $StorageStatus.json.root
      writable = $StorageStatus.json.writable
      cameraRoots = $ExpectedRootRows
    }
    config = [ordered]@{
      activeProfile = $ConfigStatus.json.activeProfile
      configRoot = $ConfigStatus.json.configRoot
      cameraRootCount = $ConfigRoots.Count
    }
    cameras = [ordered]@{
      discovered = $DiscoveredIps.Count
      ips = $DiscoveredIps
      knownClockwiseIpsPresent = @($KnownClockwiseIps | Where-Object { $DiscoveredIps -contains $_ }).Count
      statuses = $StatusList.Count
      connected = @($StatusRows | Where-Object { $_.connected }).Count
      readback = $StatusRows
    }
    service = [ordered]@{
      code = $ServiceStatus.json.code
      activeSession = $ServiceStatus.json.activeSession.materialId
      latestSession = $ServiceStatus.json.latestSession.materialId
      network = $NetworkSummary
    }
    trigger = if ($SkipTrigger) { $null } else { $TriggerStatus.json }
    client = $ClientStatus
    latestArtifacts = $LatestArtifacts
    connect = if ($null -eq $ConnectResult) { $null } else { $ConnectResult.json }
    capture = if ($null -eq $CaptureResult) { $null } else { $CaptureResult.json }
    captureResults = $ProviderRows
    productionLayout = $LayoutRows
    productionSummary = $ProductionSummary
    postCaptureStatus = if ($null -eq $PostCaptureStatus) { $null } else { $PostCaptureStatus.json }
  }
  failures = @($Failures)
}

$null = Write-AcceptanceReport -Report $Report -Root $ReportRoot
$Report | ConvertTo-Json -Depth 14

if ($Failures.Count -gt 0) {
  exit 1
}
