param(
  [string]$CaptureOrigin = "http://127.0.0.1:4317",
  [string]$ServiceOrigin = "http://127.0.0.1:4873",
  [string]$TriggerOrigin = "http://127.0.0.1:4881",
  [string]$ClientOrigin = "http://127.0.0.1:1432/?app=terminal",
  [string]$CaptureRoot = "H:\",
  [string]$AlgorithmRoot = "G:\bar-surface-algorithm",
  [string]$MaterialPrefix = "BAR-STABILITY",
  [int]$ExpectedCameras = 6,
  [int]$DurationSec = 600,
  [int]$MaxCycles = 0,
  [int]$IntervalSec = 2,
  [int]$RoundsPerCycle = 1,
  [int]$Lines = 1000,
  [int]$Width = 0,
  [int]$TimeoutMs = 8000,
  [int]$CaptureIntervalMs = 500,
  [int]$Retries = 0,
  [int]$ControlMode = 0,
  [int]$DataMode = 3,
  [int]$RunAlgorithmEvery = 0,
  [int]$MaxFrames = 1,
  [int]$MeshRows = 72,
  [int]$MeshColsPerCamera = 48,
  [double]$MaxFaceEdgeMm = 8.0,
  [string]$ReportDir = "",
  [switch]$SkipTrigger,
  [switch]$SkipClient,
  [switch]$UseTriggerGateway,
  [switch]$ConnectFirst,
  [switch]$ForceCloseActiveSession
)

$ErrorActionPreference = "Stop"

function Join-OriginPath {
  param([string]$Origin, [string]$Path)
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
    [int]$TimeoutSec = 30
  )

  $JsonBody = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Compress -Depth 30 }
  try {
    if ($Method -eq "GET") {
      $Response = Invoke-WebRequest -Method Get -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSec
    } else {
      $Response = Invoke-WebRequest -Method Post -Uri $Uri -UseBasicParsing -ContentType "application/json; charset=utf-8" -Body $JsonBody -TimeoutSec $TimeoutSec
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

function Invoke-ProductionPost {
  param(
    [string]$ProductionPath,
    [string]$TriggerPath,
    [object]$Body,
    [int]$TimeoutSec = 30
  )

  if ($UseTriggerGateway) {
    if ($SkipTrigger) {
      throw "UseTriggerGateway requires trigger gateway checks; remove -SkipTrigger."
    }
    $Response = Invoke-HttpJson -Method POST -Uri (Join-OriginPath $TriggerOrigin $TriggerPath) -Body $Body -TimeoutSec $TimeoutSec
    $ServiceJson = if (Test-JsonProperty $Response.json "service") { $Response.json.service } else { $Response.json }
    return [pscustomobject]@{
      statusCode = $Response.statusCode
      json = $ServiceJson
      gateway = $Response.json
      content = $Response.content
      viaTriggerGateway = $true
    }
  }

  $Response = Invoke-HttpJson -Method POST -Uri (Join-OriginPath $ServiceOrigin $ProductionPath) -Body $Body -TimeoutSec $TimeoutSec
  return [pscustomobject]@{
    statusCode = $Response.statusCode
    json = $Response.json
    gateway = $null
    content = $Response.content
    viaTriggerGateway = $false
  }
}

function Test-HtmlEndpoint {
  param([string]$Uri)
  $Response = Invoke-WebRequest -Method Get -Uri $Uri -UseBasicParsing -TimeoutSec 10
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

function Get-ProductionSummaryPath {
  param([string]$Material, [string]$Session)
  return Join-Path (Join-Path (Join-Path $CaptureRoot "production") (ConvertTo-SafeStorageSegment $Material)) (Join-Path (ConvertTo-SafeStorageSegment $Session) "summary.json")
}

function Get-ReportRoot {
  if (-not [string]::IsNullOrWhiteSpace($ReportDir)) {
    return [System.IO.Path]::GetFullPath($ReportDir)
  }
  if (Test-Path (Join-Path $PSScriptRoot "manifest.json") -PathType Leaf) {
    return Join-Path $PSScriptRoot "logs\production-stability"
  }
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  return Join-Path $RepoRoot "target\logs\production-stability"
}

function Add-Failure {
  param(
    [System.Collections.Generic.List[string]]$Failures,
    [string]$Message
  )
  $Failures.Add($Message)
}

function Assert-CycleCondition {
  param(
    [System.Collections.Generic.List[string]]$Failures,
    [bool]$Condition,
    [string]$Message
  )
  if (-not $Condition) {
    Add-Failure -Failures $Failures -Message $Message
  }
}

function Get-CaptureTimeoutSec {
  $PerRoundMs = ($TimeoutMs * ([Math]::Max(0, $Retries) + 1)) + $CaptureIntervalMs
  return [Math]::Max(60, [Math]::Ceiling((($PerRoundMs * [Math]::Max(1, $RoundsPerCycle)) + 90000) / 1000))
}

function Test-CameraMaterialLayout {
  param([string]$Material)
  $Rows = foreach ($Index in 1..$ExpectedCameras) {
    $Camera = "camera$Index"
    $Base = Join-Path (Join-Path $CaptureRoot $Camera) $Material
    $DepthDir = Join-Path $Base "depth"
    $IntensityDir = Join-Path $Base "intensity"
    $MetadataDir = Join-Path $Base "metadata"
    $SdkDir = Join-Path $Base "sdk-derived"
    [ordered]@{
      camera = $Camera
      root = $Base
      depth = if (Test-Path $DepthDir -PathType Container) { @(Get-ChildItem -LiteralPath $DepthDir -File -ErrorAction SilentlyContinue).Count } else { 0 }
      intensity = if (Test-Path $IntensityDir -PathType Container) { @(Get-ChildItem -LiteralPath $IntensityDir -File -ErrorAction SilentlyContinue).Count } else { 0 }
      metadata = if (Test-Path $MetadataDir -PathType Container) { @(Get-ChildItem -LiteralPath $MetadataDir -File -ErrorAction SilentlyContinue).Count } else { 0 }
      sdkDerivedExists = Test-Path $SdkDir -PathType Container
    }
  }
  return @($Rows)
}

function Read-ProductionSummary {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function New-MaterialId {
  param([int]$CycleIndex)
  return "{0}-{1}-{2:000}" -f $MaterialPrefix, (Get-Date -Format "yyyyMMdd-HHmmss"), $CycleIndex
}

function Invoke-ProductionCycle {
  param([int]$CycleIndex)

  $CycleFailures = [System.Collections.Generic.List[string]]::new()
  $StartedAt = Get-Date
  $MaterialId = New-MaterialId -CycleIndex $CycleIndex
  $SessionId = ""
  $InspectionId = ""
  $SteelInOk = $false
  $AlgorithmResult = $null
  $CaptureResult = $null
  $SteelOutResult = $null
  $PostStatus = $null
  $TriggerRoute = [ordered]@{
    enabled = [bool]$UseTriggerGateway
    steelInfoTarget = $null
    steelInTarget = $null
    captureOnceTarget = $null
    steelOutTarget = $null
    mode = $null
  }

  $EventBody = @{
    materialId = $MaterialId
    steelId = $MaterialId
    source = "production-stability"
    mode = "manual"
    triggerMode = "manual"
    acquisitionMode = "manual"
    autoCapture = $false
    discardBlackFrames = $true
    saveSdkDerived = $false
    steelType = "round-bar"
  }

  try {
    $SteelInfo = Invoke-ProductionPost -ProductionPath "/api/production/steel-info" -TriggerPath "/api/trigger/manual/steel-info" -Body $EventBody -TimeoutSec 15
    if ($UseTriggerGateway) {
      $TriggerRoute.steelInfoTarget = [string]$SteelInfo.gateway.target
      $TriggerRoute.mode = [string]$SteelInfo.gateway.mode
      Assert-CycleCondition -Failures $CycleFailures -Condition ($SteelInfo.gateway.target -eq "/api/production/steel-info") -Message "trigger steel-info routed to $($SteelInfo.gateway.target)."
    }
    $SteelIn = Invoke-ProductionPost -ProductionPath "/api/production/steel-in" -TriggerPath "/api/trigger/manual/steel-in" -Body $EventBody -TimeoutSec 15
    $SteelInOk = $true
    $SessionId = [string]$SteelIn.json.sessionId
    $InspectionId = [string]$SteelIn.json.inspectionId
    if ($UseTriggerGateway) {
      $TriggerRoute.steelInTarget = [string]$SteelIn.gateway.target
      $TriggerRoute.mode = [string]$SteelIn.gateway.mode
      Assert-CycleCondition -Failures $CycleFailures -Condition ($SteelIn.gateway.target -eq "/api/production/steel-in") -Message "trigger steel-in routed to $($SteelIn.gateway.target)."
      Assert-CycleCondition -Failures $CycleFailures -Condition ($SteelIn.gateway.mode -eq "manual") -Message "trigger gateway mode was $($SteelIn.gateway.mode), expected manual."
    }
    Assert-CycleCondition -Failures $CycleFailures -Condition ($SteelIn.json.code -eq 0) -Message "steel-in returned code $($SteelIn.json.code)."
    Assert-CycleCondition -Failures $CycleFailures -Condition ($SteelIn.json.flow.recordWrittenBeforeCapture -eq $true) -Message "steel-in did not prove record-before-capture."

    $CaptureBody = @{
      materialId = $MaterialId
      sessionId = $SessionId
      inspectionId = $InspectionId
      expectedCameras = $ExpectedCameras
      rounds = $RoundsPerCycle
      lines = $Lines
      width = $Width
      timeoutMs = $TimeoutMs
      intervalMs = $CaptureIntervalMs
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
    }
    $CaptureResult = Invoke-ProductionPost -ProductionPath "/api/production/capture-once" -TriggerPath "/api/trigger/capture-once" -Body $CaptureBody -TimeoutSec (Get-CaptureTimeoutSec)
    if ($UseTriggerGateway) {
      $TriggerRoute.captureOnceTarget = [string]$CaptureResult.gateway.target
      Assert-CycleCondition -Failures $CycleFailures -Condition ($CaptureResult.gateway.target -eq "/api/production/capture-once") -Message "trigger capture-once routed to $($CaptureResult.gateway.target)."
    }
    $Provider = $CaptureResult.json.provider
    $ProviderRows = @($Provider.results)
    Assert-CycleCondition -Failures $CycleFailures -Condition ($CaptureResult.json.code -eq 0) -Message "capture-once returned code $($CaptureResult.json.code)."
    Assert-CycleCondition -Failures $CycleFailures -Condition ($Provider.parallel -eq $true) -Message "provider did not report parallel capture."
    Assert-CycleCondition -Failures $CycleFailures -Condition ($Provider.workerCount -ge $ExpectedCameras) -Message "provider workerCount $($Provider.workerCount) below $ExpectedCameras."
    Assert-CycleCondition -Failures $CycleFailures -Condition ($Provider.failures -eq 0) -Message "provider failures $($Provider.failures)."
    Assert-CycleCondition -Failures $CycleFailures -Condition ($Provider.completeFrames -ge ($ExpectedCameras * $RoundsPerCycle)) -Message "provider completeFrames $($Provider.completeFrames) below expected."
    Assert-CycleCondition -Failures $CycleFailures -Condition ($Provider.metadataFrames -ge ($ExpectedCameras * $RoundsPerCycle)) -Message "provider metadataFrames $($Provider.metadataFrames) below expected."
    Assert-CycleCondition -Failures $CycleFailures -Condition ([int]$CaptureResult.json.record.captureFileRows -ge ($ExpectedCameras * $RoundsPerCycle * 3)) -Message "captureFileRows below expected: $($CaptureResult.json.record.captureFileRows)."
    foreach ($Row in $ProviderRows) {
      Assert-CycleCondition -Failures $CycleFailures -Condition ([int]$Row.code -eq 0) -Message "camera $($Row.ip) round $($Row.round) returned code $($Row.code), error $($Row.errorName)."
      Assert-CycleCondition -Failures $CycleFailures -Condition ([bool]$Row.completeFrame) -Message "camera $($Row.ip) round $($Row.round) incomplete frame."
      Assert-CycleCondition -Failures $CycleFailures -Condition (-not [bool]$Row.discarded) -Message "camera $($Row.ip) round $($Row.round) discarded: $($Row.discardReason)."
    }
  } catch {
    Add-Failure -Failures $CycleFailures -Message $_.Exception.Message
  } finally {
    if ($SteelInOk) {
      try {
        $SteelOutResult = Invoke-ProductionPost -ProductionPath "/api/production/steel-out" -TriggerPath "/api/trigger/manual/steel-out" -Body $EventBody -TimeoutSec 15
        if ($UseTriggerGateway) {
          $TriggerRoute.steelOutTarget = [string]$SteelOutResult.gateway.target
        }
      } catch {
        Add-Failure -Failures $CycleFailures -Message "steel-out failed: $($_.Exception.Message)"
      }
    }
  }

  try {
    $PostStatus = Invoke-HttpJson -Method GET -Uri (Join-OriginPath $ServiceOrigin "/api/production/status") -TimeoutSec 15
    Assert-CycleCondition -Failures $CycleFailures -Condition ($null -eq $PostStatus.json.activeSession) -Message "activeSession was not cleared after cycle."
  } catch {
    Add-Failure -Failures $CycleFailures -Message "post status failed: $($_.Exception.Message)"
  }

  $LayoutRows = Test-CameraMaterialLayout -Material $MaterialId
  foreach ($Layout in $LayoutRows) {
    Assert-CycleCondition -Failures $CycleFailures -Condition ([int]$Layout.depth -ge $RoundsPerCycle) -Message "$($Layout.camera) depth count $($Layout.depth) below $RoundsPerCycle."
    Assert-CycleCondition -Failures $CycleFailures -Condition ([int]$Layout.intensity -ge $RoundsPerCycle) -Message "$($Layout.camera) intensity count $($Layout.intensity) below $RoundsPerCycle."
    Assert-CycleCondition -Failures $CycleFailures -Condition ([int]$Layout.metadata -ge $RoundsPerCycle) -Message "$($Layout.camera) metadata count $($Layout.metadata) below $RoundsPerCycle."
    Assert-CycleCondition -Failures $CycleFailures -Condition (-not [bool]$Layout.sdkDerivedExists) -Message "$($Layout.camera) wrote sdk-derived while disabled."
  }

  $SummaryPath = if ($SessionId) { Get-ProductionSummaryPath -Material $MaterialId -Session $SessionId } else { "" }
  $SummaryJson = if ($SummaryPath) { Read-ProductionSummary -Path $SummaryPath } else { $null }
  if ($null -eq $SummaryJson) {
    Add-Failure -Failures $CycleFailures -Message "production summary missing: $SummaryPath"
  } else {
    Assert-CycleCondition -Failures $CycleFailures -Condition ($SummaryJson.schema -eq "steel.production.summary.v1") -Message "summary schema mismatch: $($SummaryJson.schema)."
    Assert-CycleCondition -Failures $CycleFailures -Condition ([int]$SummaryJson.captureFiles.count -ge ($ExpectedCameras * $RoundsPerCycle * 3)) -Message "summary file count below expected: $($SummaryJson.captureFiles.count)."
    Assert-CycleCondition -Failures $CycleFailures -Condition ([int]$SummaryJson.captureFiles.depth -ge ($ExpectedCameras * $RoundsPerCycle)) -Message "summary depth count below expected."
    Assert-CycleCondition -Failures $CycleFailures -Condition ([int]$SummaryJson.captureFiles.intensity -ge ($ExpectedCameras * $RoundsPerCycle)) -Message "summary intensity count below expected."
    Assert-CycleCondition -Failures $CycleFailures -Condition ([int]$SummaryJson.captureFiles.metadata -ge ($ExpectedCameras * $RoundsPerCycle)) -Message "summary metadata count below expected."
    Assert-CycleCondition -Failures $CycleFailures -Condition ([int]$SummaryJson.captureFiles.sdkDerived -eq 0) -Message "summary sdkDerived should be 0."
  }

  $ShouldRunAlgorithm = $RunAlgorithmEvery -gt 0 -and ($CycleIndex % $RunAlgorithmEvery -eq 0) -and $CycleFailures.Count -eq 0
  if ($ShouldRunAlgorithm) {
    try {
      $AlgorithmBody = @{
        materialId = $MaterialId
        sessionId = $SessionId
        inspectionId = $InspectionId
        captureRoot = $CaptureRoot
        outputRoot = $AlgorithmRoot
        maxFrames = $MaxFrames
        meshRows = $MeshRows
        meshColsPerCamera = $MeshColsPerCamera
        maxFaceEdgeMm = $MaxFaceEdgeMm
        runCore = $true
      }
      $AlgorithmResult = Invoke-HttpJson -Method POST -Uri (Join-OriginPath $ServiceOrigin "/api/production/algorithm/run") -Body $AlgorithmBody -TimeoutSec 240
      Assert-CycleCondition -Failures $CycleFailures -Condition ($AlgorithmResult.json.code -eq 0) -Message "algorithm returned code $($AlgorithmResult.json.code)."
      Assert-CycleCondition -Failures $CycleFailures -Condition ($AlgorithmResult.json.captureSummary.ok -eq $true) -Message "algorithm did not update production summary: $($AlgorithmResult.json.captureSummary.error)."
      Assert-CycleCondition -Failures $CycleFailures -Condition ($AlgorithmResult.json.algorithm.result.manifest.acceptance.status -eq "pass") -Message "algorithm acceptance was $($AlgorithmResult.json.algorithm.result.manifest.acceptance.status)."
      Assert-CycleCondition -Failures $CycleFailures -Condition ($AlgorithmResult.json.algorithm.result.manifest.core.available -eq $true) -Message "algorithm core output unavailable."
    } catch {
      Add-Failure -Failures $CycleFailures -Message "algorithm failed: $($_.Exception.Message)"
    }
  }

  return [ordered]@{
    index = $CycleIndex
    materialId = $MaterialId
    sessionId = $SessionId
    inspectionId = $InspectionId
    startedAt = $StartedAt.ToString("o")
    elapsedSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 3)
    ok = $CycleFailures.Count -eq 0
    failures = @($CycleFailures)
    capture = if ($null -eq $CaptureResult) { $null } else {
      [ordered]@{
        code = $CaptureResult.json.code
        successes = $CaptureResult.json.provider.successes
        failures = $CaptureResult.json.provider.failures
        completeFrames = $CaptureResult.json.provider.completeFrames
        metadataFrames = $CaptureResult.json.provider.metadataFrames
        workerCount = $CaptureResult.json.provider.workerCount
        parallel = $CaptureResult.json.provider.parallel
        summaryOutput = $CaptureResult.json.provider.summaryOutput
      }
    }
    triggerRoute = $TriggerRoute
    layout = $LayoutRows
    summary = if ($null -eq $SummaryJson) { $null } else {
      [ordered]@{
        path = $SummaryPath
        schema = $SummaryJson.schema
        status = $SummaryJson.inspection.status
        files = $SummaryJson.captureFiles.count
        depth = $SummaryJson.captureFiles.depth
        intensity = $SummaryJson.captureFiles.intensity
        metadata = $SummaryJson.captureFiles.metadata
        sdkDerived = $SummaryJson.captureFiles.sdkDerived
        algorithmStatus = $SummaryJson.algorithm.status
        algorithmAcceptance = $SummaryJson.algorithm.acceptanceStatus
      }
    }
    algorithm = if ($null -eq $AlgorithmResult) { $null } else {
      [ordered]@{
        status = $AlgorithmResult.json.record.status
        manifestPath = $AlgorithmResult.json.record.summaryPath
        acceptance = $AlgorithmResult.json.algorithm.result.manifest.acceptance.status
        coreBytes = $AlgorithmResult.json.algorithm.result.manifest.core.summary.outputBytes
      }
    }
    postStatus = if ($null -eq $PostStatus) { $null } else {
      [ordered]@{
        activeSession = $PostStatus.json.activeSession
        latestInspectionStatus = $PostStatus.json.latestInspection.status
        captureCount = $PostStatus.json.latestInspection.captureCount
      }
    }
  }
}

if ($DurationSec -lt 1 -and $MaxCycles -lt 1) {
  throw "Set DurationSec >= 1 or MaxCycles >= 1."
}
if ($ExpectedCameras -lt 1) {
  throw "ExpectedCameras must be positive."
}

$ReportRoot = Get-ReportRoot
New-Item -ItemType Directory -Force -Path $ReportRoot | Out-Null
$StartedAt = Get-Date
$GlobalFailures = [System.Collections.Generic.List[string]]::new()

try {
  $Services = Invoke-HttpJson -Method GET -Uri (Join-OriginPath $ServiceOrigin "/api/services") -TimeoutSec 10
  $ProductionStatus = Invoke-HttpJson -Method GET -Uri (Join-OriginPath $ServiceOrigin "/api/production/status") -TimeoutSec 10
  $CameraStatuses = Invoke-HttpJson -Method GET -Uri (Join-OriginPath $ServiceOrigin "/api/camera/statuses") -TimeoutSec 20
  $Network = Invoke-HttpJson -Method GET -Uri (Join-OriginPath $ServiceOrigin "/api/system/network") -TimeoutSec 20
  $Trigger = if ($SkipTrigger) { $null } else { Invoke-HttpJson -Method GET -Uri (Join-OriginPath $TriggerOrigin "/api/trigger/status") -TimeoutSec 10 }
  $Client = if ($SkipClient) { $null } else { Test-HtmlEndpoint -Uri $ClientOrigin }
} catch {
  throw "Preflight failed: $($_.Exception.Message)"
}

if ($UseTriggerGateway) {
  if ($SkipTrigger -or $null -eq $Trigger) {
    throw "UseTriggerGateway requires a reachable trigger gateway."
  }
  if ($Trigger.json.mode -ne "manual" -or $Trigger.json.manualAllowed -ne $true) {
    $Trigger = Invoke-HttpJson -Method POST -Uri (Join-OriginPath $TriggerOrigin "/api/trigger/mode") -Body @{ mode = "manual" } -TimeoutSec 10
  }
  if ($Trigger.json.mode -ne "manual" -or $Trigger.json.manualAllowed -ne $true) {
    throw "Trigger gateway did not enter manual mode for stability run."
  }
}

if ($null -ne $ProductionStatus.json.activeSession) {
  if (-not $ForceCloseActiveSession) {
    throw "Production activeSession is not null before stability run. Finish or rerun with -ForceCloseActiveSession."
  }
  $ActiveMaterial = [string]$ProductionStatus.json.activeSession.materialId
  if ([string]::IsNullOrWhiteSpace($ActiveMaterial)) {
    $ActiveMaterial = [string]$ProductionStatus.json.capture.steelId
  }
  $null = Invoke-ProductionPost -ProductionPath "/api/production/steel-out" -TriggerPath "/api/trigger/manual/steel-out" -Body @{ materialId = $ActiveMaterial; source = "production-stability-cleanup" } -TimeoutSec 15
}

$Connected = @($CameraStatuses.json.statuses | Where-Object { $_.connected })
$NetworkSummary = Get-NetworkRateSummary -NetworkJson $Network.json
if ($Connected.Count -lt $ExpectedCameras) {
  throw "Connected camera count $($Connected.Count) below expected $ExpectedCameras."
}
foreach ($Camera in @($Connected | Select-Object -First $ExpectedCameras)) {
  if ([int]$Camera.captureConfig.controlMode -ne $ControlMode) {
    Add-Failure -Failures $GlobalFailures -Message "Camera $($Camera.ip) controlMode $($Camera.captureConfig.controlMode), expected $ControlMode."
  }
  if ([int]$Camera.captureConfig.triggerInputType -ne 4) {
    Add-Failure -Failures $GlobalFailures -Message "Camera $($Camera.ip) triggerInputType $($Camera.captureConfig.triggerInputType), expected 4."
  }
  if ([int]$Camera.captureConfig.triggerLines -ne $Lines) {
    Add-Failure -Failures $GlobalFailures -Message "Camera $($Camera.ip) triggerLines $($Camera.captureConfig.triggerLines), expected $Lines."
  }
}
if ($Network.json.code -ne 0 -or @($Network.json.interfaces).Count -lt 1) {
  Add-Failure -Failures $GlobalFailures -Message "Network monitor did not return interfaces."
}
if (-not [bool]$NetworkSummary.rateFields) {
  Add-Failure -Failures $GlobalFailures -Message "Network monitor did not return realtime upload/download/bandwidth fields."
}
if (-not $SkipClient -and -not [bool]$Client.ok) {
  Add-Failure -Failures $GlobalFailures -Message "Client endpoint did not return HTML."
}
if (-not $SkipTrigger -and $Trigger.json.code -ne 0) {
  Add-Failure -Failures $GlobalFailures -Message "Trigger gateway status was not healthy."
}

$Cycles = @()
$CycleIndex = 0
while ($GlobalFailures.Count -eq 0) {
  $Elapsed = ((Get-Date) - $StartedAt).TotalSeconds
  if ($MaxCycles -gt 0 -and $CycleIndex -ge $MaxCycles) {
    break
  }
  if ($MaxCycles -le 0 -and $CycleIndex -gt 0 -and $Elapsed -ge $DurationSec) {
    break
  }
  if ($MaxCycles -gt 0 -and $DurationSec -gt 0 -and $CycleIndex -gt 0 -and $Elapsed -ge $DurationSec) {
    break
  }

  $CycleIndex += 1
  Write-Host ("Starting production stability cycle {0}: rounds={1}, algorithmEvery={2}" -f $CycleIndex, $RoundsPerCycle, $RunAlgorithmEvery)
  $Cycle = Invoke-ProductionCycle -CycleIndex $CycleIndex
  $Cycles += $Cycle
  if (-not [bool]$Cycle.ok) {
    foreach ($Failure in @($Cycle.failures)) {
      Add-Failure -Failures $GlobalFailures -Message "cycle ${CycleIndex}: $Failure"
    }
    break
  }

  if ($IntervalSec -gt 0) {
    Start-Sleep -Seconds $IntervalSec
  }
}

$Report = [ordered]@{
  schema = "steel.production.stability.v1"
  code = if ($GlobalFailures.Count -eq 0) { 0 } else { 1 }
  startedAt = $StartedAt.ToString("o")
  finishedAt = (Get-Date).ToString("o")
  elapsedSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 3)
  requested = [ordered]@{
    durationSec = $DurationSec
    maxCycles = $MaxCycles
    intervalSec = $IntervalSec
    roundsPerCycle = $RoundsPerCycle
    expectedCameras = $ExpectedCameras
    lines = $Lines
    dataMode = $DataMode
    runAlgorithmEvery = $RunAlgorithmEvery
    useTriggerGateway = [bool]$UseTriggerGateway
  }
  origins = [ordered]@{
    capture = $CaptureOrigin
    service = $ServiceOrigin
    trigger = if ($SkipTrigger) { $null } else { $TriggerOrigin }
    client = if ($SkipClient) { $null } else { $ClientOrigin }
  }
  preflight = [ordered]@{
    services = $Services.json
    connectedCameras = $Connected.Count
    network = $NetworkSummary
    networkInterfaces = $NetworkSummary.interfaces
    trigger = if ($null -eq $Trigger) { $null } else { $Trigger.json }
    client = $Client
  }
  cycles = $Cycles
  totals = [ordered]@{
    cycles = $Cycles.Count
    okCycles = @($Cycles | Where-Object { $_.ok }).Count
    failedCycles = @($Cycles | Where-Object { -not $_.ok }).Count
    captureFrames = (@($Cycles | ForEach-Object { if ($_.capture) { [int]$_.capture.completeFrames } }) | Measure-Object -Sum).Sum
    metadataFrames = (@($Cycles | ForEach-Object { if ($_.capture) { [int]$_.capture.metadataFrames } }) | Measure-Object -Sum).Sum
    algorithms = @($Cycles | Where-Object { $null -ne $_.algorithm }).Count
  }
  failures = @($GlobalFailures)
}

$ReportPath = Join-Path $ReportRoot ("production-stability-{0}.json" -f (Get-Date -Format "yyyyMMdd-HHmmss-fff"))
$Report["reportPath"] = $ReportPath
$Report | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
$Report | ConvertTo-Json -Depth 30

if ($GlobalFailures.Count -gt 0) {
  exit 1
}
