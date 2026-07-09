param(
  [string]$CaptureOrigin = "http://127.0.0.1:4317",
  [string]$ServiceOrigin = "http://127.0.0.1:4873",
  [string]$TriggerOrigin = "http://127.0.0.1:4881",
  [string]$ClientOrigin = "http://127.0.0.1:1432/?app=terminal",
  [int]$TimeoutSec = 10,
  [switch]$SkipCapture,
  [switch]$SkipTrigger,
  [switch]$SkipClient
)

$ErrorActionPreference = "Stop"

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

function Read-JsonEndpoint {
  param(
    [string]$Name,
    [string]$Uri
  )

  $Response = Invoke-WebRequest -Method Get -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSec
  $Json = Convert-JsonBody ([string]$Response.Content)
  if ($null -eq $Json) {
    throw "$Name returned empty JSON at $Uri"
  }
  return [ordered]@{
    ok = $true
    uri = $Uri
    statusCode = [int]$Response.StatusCode
    json = $Json
  }
}

function Read-HtmlEndpoint {
  param(
    [string]$Name,
    [string]$Uri
  )

  $Response = Invoke-WebRequest -Method Get -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSec
  $Content = [string]$Response.Content
  if ($Response.StatusCode -ne 200 -or $Content -notmatch "<html") {
    throw "$Name did not return HTML at $Uri"
  }
  return [ordered]@{
    ok = $true
    uri = $Uri
    statusCode = [int]$Response.StatusCode
    bytes = $Content.Length
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

  if ($NetworkJson.code -ne 0) {
    throw "Rust network monitor returned non-zero code: $($NetworkJson.code)"
  }
  $Interfaces = @($NetworkJson.interfaces)
  if ($Interfaces.Count -lt 1) {
    throw "Rust network monitor did not report interfaces."
  }
  foreach ($RequiredProperty in @("totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps")) {
    if (-not (Test-JsonProperty $NetworkJson $RequiredProperty)) {
      throw "Rust network monitor missing $RequiredProperty."
    }
  }
  $FirstInterface = $Interfaces[0]
  foreach ($RequiredProperty in @("uploadMbps", "downloadMbps", "bandwidthMbps", "online")) {
    if (-not (Test-JsonProperty $FirstInterface $RequiredProperty)) {
      throw "Rust network monitor interface missing $RequiredProperty."
    }
  }

  return [ordered]@{
    code = $NetworkJson.code
    interfaces = $Interfaces.Count
    source = $NetworkJson.source
    totalUploadMbps = [double]$NetworkJson.totalUploadMbps
    totalDownloadMbps = [double]$NetworkJson.totalDownloadMbps
    totalBandwidthMbps = [double]$NetworkJson.totalBandwidthMbps
    rateFields = $true
  }
}

$Checks = [ordered]@{}

try {
  if (-not $SkipCapture) {
    $CaptureHealth = Read-JsonEndpoint -Name "Capture provider" -Uri (Join-OriginPath $CaptureOrigin "/health")
    $Checks.capture = [ordered]@{
      ok = $true
      uri = $CaptureHealth.uri
      sdkReady = $CaptureHealth.json.sdkReady
      cameraCount = $CaptureHealth.json.cameraCount
      provider = $CaptureHealth.json.provider
    }
  }

  $ProductionStatus = Read-JsonEndpoint -Name "Rust production status" -Uri (Join-OriginPath $ServiceOrigin "/api/production/status")
  $Checks.service = [ordered]@{
    ok = $true
    uri = $ProductionStatus.uri
    code = $ProductionStatus.json.code
    database = $ProductionStatus.json.database
    activeSession = $ProductionStatus.json.activeSession.materialId
    latestSession = $ProductionStatus.json.latestSession.materialId
  }

  $NetworkStatus = Read-JsonEndpoint -Name "Rust network monitor" -Uri (Join-OriginPath $ServiceOrigin "/api/system/network")
  $NetworkSummary = Get-NetworkRateSummary -NetworkJson $NetworkStatus.json
  $Checks.network = [ordered]@{
    ok = $true
    uri = $NetworkStatus.uri
    code = $NetworkSummary.code
    interfaces = $NetworkSummary.interfaces
    source = $NetworkSummary.source
    totalUploadMbps = $NetworkSummary.totalUploadMbps
    totalDownloadMbps = $NetworkSummary.totalDownloadMbps
    totalBandwidthMbps = $NetworkSummary.totalBandwidthMbps
    rateFields = $NetworkSummary.rateFields
  }

  if (-not $SkipTrigger) {
    $TriggerStatus = Read-JsonEndpoint -Name "Trigger gateway" -Uri (Join-OriginPath $TriggerOrigin "/api/trigger/status")
    $Checks.triggerGateway = [ordered]@{
      ok = $true
      uri = $TriggerStatus.uri
      code = $TriggerStatus.json.code
      mode = $TriggerStatus.json.mode
      manualAllowed = $TriggerStatus.json.manualAllowed
    }
  }

  if (-not $SkipClient) {
    $ClientStatus = Read-HtmlEndpoint -Name "Static client" -Uri $ClientOrigin
    $Checks.client = $ClientStatus
  }

  [ordered]@{
    code = 0
    checkedAt = (Get-Date).ToString("o")
    captureOrigin = if ($SkipCapture) { $null } else { $CaptureOrigin }
    serviceOrigin = $ServiceOrigin
    triggerOrigin = if ($SkipTrigger) { $null } else { $TriggerOrigin }
    clientOrigin = if ($SkipClient) { $null } else { $ClientOrigin }
    checks = $Checks
  } | ConvertTo-Json -Depth 8
} catch {
  [ordered]@{
    code = 1
    checkedAt = (Get-Date).ToString("o")
    error = $_.Exception.Message
    checks = $Checks
  } | ConvertTo-Json -Depth 8
  exit 1
}
