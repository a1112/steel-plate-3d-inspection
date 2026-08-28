[CmdletBinding()]
param(
  [string]$Origin = "http://127.0.0.1:4874",
  [Parameter(Mandatory = $true)]
  [string]$RecordId,
  [string]$CameraId = "C1",
  [long]$SequenceNo = 0,
  [ValidateSet("intensity", "jet")]
  [string]$Kind = "intensity",
  [ValidateSet("gray", "jet")]
  [string]$ColorMode = "gray",
  [ValidateRange(1, 1000)]
  [int]$RenderIterations = 20,
  [ValidateRange(1, 64)]
  [int]$Concurrency = 8,
  [ValidateRange(1, 100000)]
  [int]$ThroughputRequests = 800,
  [string]$Revision = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http

if ([string]::IsNullOrWhiteSpace($Revision)) {
  $Revision = "image-benchmark-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
}

function Encode-QueryValue([string]$Value) {
  return [Uri]::EscapeDataString($Value)
}

function Get-Percentile([double[]]$Values, [double]$Percentile) {
  $ordered = @($Values | Sort-Object)
  $index = [Math]::Min($ordered.Count - 1, [Math]::Floor($ordered.Count * $Percentile))
  return [double]$ordered[$index]
}

function Get-ResponseHeader($Response, [string]$Name) {
  if ($Response.Headers.Contains($Name)) {
    return $Response.Headers.GetValues($Name) -join ","
  }
  return ""
}

$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.MaxConnectionsPerServer = $Concurrency
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(30)
$encodedRecord = Encode-QueryValue $RecordId
$encodedCamera = Encode-QueryValue $CameraId
$encodedKind = Encode-QueryValue $Kind
$encodedColorMode = Encode-QueryValue $ColorMode
$encodedRevision = Encode-QueryValue $Revision
$baseUrl = "$($Origin.TrimEnd('/'))/internal/v1/preview?recordId=$encodedRecord&cameraId=$encodedCamera&sequenceNo=$SequenceNo&kind=$encodedKind&colorMode=$encodedColorMode"

try {
  $profiles = foreach ($profile in @("xs", "sm", "md", "lg", "xl")) {
    $elapsedValues = [System.Collections.Generic.List[double]]::new()
    $responseBytes = 0
    $serverTiming = ""
    $resizeMode = ""
    $decodeCache = ""
    for ($iteration = 0; $iteration -lt $RenderIterations; $iteration += 1) {
      # live=1 deliberately bypasses the encoded rendition cache. The decoded
      # source cache remains active, which isolates repeated resize/encode cost.
      $url = "$baseUrl&profile=$profile&revision=$encodedRevision&live=1"
      $timer = [Diagnostics.Stopwatch]::StartNew()
      $response = $client.GetAsync($url).GetAwaiter().GetResult()
      $body = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
      $timer.Stop()
      if (-not $response.IsSuccessStatusCode) {
        throw "Image service returned HTTP $([int]$response.StatusCode) for profile $profile"
      }
      $elapsedValues.Add($timer.Elapsed.TotalMilliseconds)
      $responseBytes = $body.Length
      $serverTiming = Get-ResponseHeader $response "Server-Timing"
      $resizeMode = Get-ResponseHeader $response "X-Steel-Resize-Mode"
      $decodeCache = Get-ResponseHeader $response "X-Steel-Decode-Cache"
      $response.Dispose()
    }
    [pscustomobject]@{
      profile = $profile
      bytes = $responseBytes
      medianMs = [Math]::Round((Get-Percentile $elapsedValues.ToArray() 0.5), 2)
      p95Ms = [Math]::Round((Get-Percentile $elapsedValues.ToArray() 0.95), 2)
      resizeMode = $resizeMode
      decodeCache = $decodeCache
      serverTiming = $serverTiming
    }
  }

  $throughputUrl = "$baseUrl&profile=md&revision=$encodedRevision"
  $warmResponse = $client.GetAsync($throughputUrl).GetAwaiter().GetResult()
  $null = $warmResponse.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
  if (-not $warmResponse.IsSuccessStatusCode) {
    throw "Image service warm-up returned HTTP $([int]$warmResponse.StatusCode)"
  }
  $warmResponse.Dispose()

  $successful = 0
  $failed = 0
  $remaining = $ThroughputRequests
  $throughputTimer = [Diagnostics.Stopwatch]::StartNew()
  while ($remaining -gt 0) {
    $batchSize = [Math]::Min($Concurrency, $remaining)
    $tasks = for ($index = 0; $index -lt $batchSize; $index += 1) {
      $client.GetAsync($throughputUrl)
    }
    try {
      $responses = [Threading.Tasks.Task]::WhenAll($tasks).GetAwaiter().GetResult()
    } catch {
      $responses = @($tasks | Where-Object { $_.Status -eq "RanToCompletion" } | ForEach-Object Result)
      $failed += @($tasks | Where-Object IsFaulted).Count
    }
    foreach ($response in $responses) {
      $null = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
      if ($response.IsSuccessStatusCode) {
        $successful += 1
      } else {
        $failed += 1
      }
      $response.Dispose()
    }
    $remaining -= $batchSize
  }
  $throughputTimer.Stop()

  [pscustomobject]@{
    origin = $Origin
    recordId = $RecordId
    cameraId = $CameraId
    sequenceNo = $SequenceNo
    kind = $Kind
    colorMode = $ColorMode
    renderIterations = $RenderIterations
    profiles = @($profiles)
    throughput = [pscustomobject]@{
      requests = $ThroughputRequests
      concurrency = $Concurrency
      successful = $successful
      failed = $failed
      seconds = [Math]::Round($throughputTimer.Elapsed.TotalSeconds, 3)
      requestsPerSecond = [Math]::Round($successful / [Math]::Max($throughputTimer.Elapsed.TotalSeconds, 0.001), 1)
    }
  } | ConvertTo-Json -Depth 6
} finally {
  $client.Dispose()
  $handler.Dispose()
}
