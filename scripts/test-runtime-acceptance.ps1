param(
  [string]$RuntimeRoot = "",
  [ValidateSet("debug", "release")]
  [string]$Profile = "debug",
  [int]$ServicePort = 4973,
  [int]$TriggerPort = 4981,
  [int]$ClientPort = 1494,
  [switch]$SkipSmoke,
  [switch]$SkipClient,
  [switch]$NoPortCleanup
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  if (Test-Path (Join-Path $PSScriptRoot "manifest.json") -PathType Leaf) {
    $RuntimeRoot = $PSScriptRoot
  } else {
    $RuntimeRoot = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) "target\runtime"
  }
}

$RuntimeRoot = (Resolve-Path $RuntimeRoot).Path
$LayoutScript = Join-Path $RuntimeRoot "test-runtime-layout.ps1"
$SmokeScript = Join-Path $RuntimeRoot "test-integrated-management-smoke.ps1"
$AcceptanceMutex = $null
$MutexAcquired = $false

function Assert-File {
  param([string]$Path)
  if (-not (Test-Path $Path -PathType Leaf)) {
    throw "Missing required runtime script: $Path"
  }
}

function Invoke-CheckedScript {
  param(
    [string]$ScriptPath,
    [string[]]$Arguments = @()
  )

  Assert-File $ScriptPath
  $Output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Script failed with exit $LASTEXITCODE`: $ScriptPath`n$($Output -join [Environment]::NewLine)"
  }
  return @($Output)
}

function Stop-AcceptancePorts {
  if ($NoPortCleanup) {
    return
  }

  $Ports = @($ServicePort, $TriggerPort, $ClientPort) | Where-Object { $_ -gt 0 } | Sort-Object -Unique
  if (-not $Ports.Count) {
    return
  }

  $ProcessIds = @()
  try {
    $ProcessIds += Get-NetTCPConnection -LocalPort $Ports -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess
  } catch {
    $ProcessIds = @()
  }

  if (-not $ProcessIds.Count) {
    $PortLookup = @{}
    foreach ($Port in $Ports) {
      $PortLookup[[string]$Port] = $true
    }

    $Rows = & netstat -ano -p tcp 2>$null
    foreach ($Row in $Rows) {
      if ($Row -notmatch "\sLISTENING\s") {
        continue
      }
      $Parts = @($Row.Trim() -split "\s+")
      if ($Parts.Count -lt 5) {
        continue
      }
      $LocalEndpoint = [string]$Parts[1]
      $PidText = [string]$Parts[-1]
      $PortText = $null
      if ($LocalEndpoint -match ":(\d+)$") {
        $PortText = $Matches[1]
      }
      if ($PortText -and $PortLookup.ContainsKey($PortText)) {
        $ParsedPid = 0
        if ([int]::TryParse($PidText, [ref]$ParsedPid)) {
          $ProcessIds += $ParsedPid
        }
      }
    }
  }

  foreach ($ProcessId in @($ProcessIds | Where-Object { $_ -and $_ -ne $PID } | Sort-Object -Unique)) {
    try {
      Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    } catch {
      Write-Verbose "Failed to stop listener PID $ProcessId on acceptance ports: $($_.Exception.Message)"
    }
  }
}

function Enter-AcceptancePortLock {
  $Name = "Local\SteelInspectionRuntimeAcceptance_{0}_{1}_{2}" -f $ServicePort, $TriggerPort, $ClientPort
  $script:AcceptanceMutex = [System.Threading.Mutex]::new($false, $Name)
  try {
    $script:MutexAcquired = $script:AcceptanceMutex.WaitOne([TimeSpan]::FromSeconds(120))
  } catch [System.Threading.AbandonedMutexException] {
    $script:MutexAcquired = $true
  }
  if (-not $script:MutexAcquired) {
    throw "Timed out waiting for runtime acceptance port lock: $Name"
  }
}

function Exit-AcceptancePortLock {
  if ($script:AcceptanceMutex) {
    if ($script:MutexAcquired) {
      try {
        $script:AcceptanceMutex.ReleaseMutex()
      } catch {
        Write-Verbose "Failed to release acceptance mutex: $($_.Exception.Message)"
      }
    }
    $script:AcceptanceMutex.Dispose()
    $script:AcceptanceMutex = $null
    $script:MutexAcquired = $false
  }
}

function Get-OutputTail {
  param([object[]]$Lines)
  return @($Lines | ForEach-Object { [string]$_ } | Select-Object -Last 80)
}

function Read-JsonFromOutput {
  param([object[]]$Lines)

  $Text = ($Lines | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
  $Start = $Text.IndexOf("{")
  if ($Start -lt 0) {
    throw "Script output did not contain a JSON object."
  }
  return $Text.Substring($Start) | ConvertFrom-Json
}

function Assert-SmokeResult {
  param([object]$Smoke)

  if ($null -eq $Smoke) {
    throw "Smoke output was empty."
  }
  if ([int]$Smoke.code -ne 0) {
    throw "Smoke output code was not zero: $($Smoke | ConvertTo-Json -Depth 8)"
  }
  if ([string]::IsNullOrWhiteSpace([string]$Smoke.reportPath) -or -not (Test-Path -LiteralPath $Smoke.reportPath -PathType Leaf)) {
    throw "Smoke report file was not written: $($Smoke.reportPath)"
  }
  if ([string]::IsNullOrWhiteSpace([string]$Smoke.service.configRoot)) {
    throw "Smoke output did not include service.configRoot."
  }
  if (-not ([string]$Smoke.service.database.path).StartsWith([string]$Smoke.service.configRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Smoke database path must stay under isolated configRoot. database=$($Smoke.service.database.path), configRoot=$($Smoke.service.configRoot)"
  }
  if ([int]$Smoke.service.network.code -ne 0) {
    throw "Smoke network monitor did not return code 0."
  }
  if ([int]$Smoke.service.network.interfaces -lt 1) {
    throw "Smoke network monitor did not report any interfaces."
  }
  if ([string]::IsNullOrWhiteSpace([string]$Smoke.service.network.source)) {
    throw "Smoke network monitor did not include a source."
  }
  foreach ($RequiredProperty in @("totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps")) {
    if (-not ($Smoke.service.network.PSObject.Properties.Name -contains $RequiredProperty)) {
      throw "Smoke network monitor did not include $RequiredProperty."
    }
  }
  if ($Smoke.service.network.rateFields -ne $true) {
    throw "Smoke network monitor did not verify per-interface realtime rate fields."
  }
  if ([int]$Smoke.production.captureGuard.statusCode -ne 409) {
    throw "Smoke capture guard did not reject pre-steel-in capture."
  }
  if ([string]$Smoke.production.captureGuard.error -ne "steel_not_present") {
    throw "Smoke capture guard expected steel_not_present, got $($Smoke.production.captureGuard.error)"
  }
  if ($Smoke.production.captureOnce.parallel -ne $true) {
    throw "Smoke capture-once did not report parallel provider capture."
  }
  if ([int]$Smoke.production.captureOnce.workerCount -lt 6) {
    throw "Smoke capture-once worker count was below 6."
  }
  if ([int]$Smoke.production.captureOnce.completeFrames -lt 6) {
    throw "Smoke capture-once did not produce six complete frames."
  }
  if ([int]$Smoke.production.captureOnce.metadataFrames -lt 6) {
    throw "Smoke capture-once did not produce six metadata frames."
  }
  if ([int]$Smoke.production.captureOnce.captureFileRows -lt 18) {
    throw "Smoke capture summary did not record depth/intensity/metadata rows for six cameras."
  }
  if ($Smoke.production.captureOnce.saveSdkDerived -ne $false) {
    throw "Smoke capture-once should keep sdk-derived disabled."
  }
  foreach ($TaskName in @("steelInfo", "steelIn", "captureOnce", "steelOut")) {
    if ([string]::IsNullOrWhiteSpace([string]$Smoke.production.durableTasks.$TaskName)) {
      throw "Smoke did not report persisted task identity for $TaskName."
    }
  }
}

$StartedAt = Get-Date
$LayoutOutput = @()
$SmokeOutput = @()
$SmokeSummary = $null

try {
  Enter-AcceptancePortLock
  Stop-AcceptancePorts

  $LayoutOutput = Invoke-CheckedScript -ScriptPath $LayoutScript -Arguments @("-RuntimeRoot", $RuntimeRoot)

  if (-not $SkipSmoke) {
    $SmokeArgs = @(
      "-ServicePort", [string]$ServicePort,
      "-TriggerPort", [string]$TriggerPort,
      "-ClientPort", [string]$ClientPort,
      "-Profile", $Profile
    )
    if ($SkipClient) {
      $SmokeArgs += "-SkipClient"
    }
    $SmokeOutput = Invoke-CheckedScript -ScriptPath $SmokeScript -Arguments $SmokeArgs
    $SmokeSummary = Read-JsonFromOutput $SmokeOutput
    Assert-SmokeResult $SmokeSummary
  }

  [ordered]@{
    code = 0
    checkedAt = (Get-Date).ToString("o")
    elapsedSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 3)
    runtimeRoot = $RuntimeRoot
    checks = [ordered]@{
      layout = [ordered]@{
        ok = $true
        script = $LayoutScript
        outputTail = Get-OutputTail $LayoutOutput
      }
      smoke = [ordered]@{
        ok = -not $SkipSmoke
        skipped = [bool]$SkipSmoke
        script = if ($SkipSmoke) { $null } else { $SmokeScript }
        servicePort = if ($SkipSmoke) { $null } else { $ServicePort }
        triggerPort = if ($SkipSmoke) { $null } else { $TriggerPort }
        clientPort = if ($SkipSmoke -or $SkipClient) { $null } else { $ClientPort }
        reportPath = if ($SkipSmoke -or $null -eq $SmokeSummary) { $null } else { $SmokeSummary.reportPath }
        network = if ($SkipSmoke -or $null -eq $SmokeSummary) { $null } else { $SmokeSummary.service.network }
        durableTasks = if ($SkipSmoke -or $null -eq $SmokeSummary) { $null } else { $SmokeSummary.production.durableTasks }
        captureGuard = if ($SkipSmoke -or $null -eq $SmokeSummary) { $null } else { $SmokeSummary.production.captureGuard }
        captureOnce = if ($SkipSmoke -or $null -eq $SmokeSummary) { $null } else { $SmokeSummary.production.captureOnce }
        outputTail = Get-OutputTail $SmokeOutput
      }
    }
  } | ConvertTo-Json -Depth 8
} catch {
  [ordered]@{
    code = 1
    checkedAt = (Get-Date).ToString("o")
    elapsedSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 3)
    runtimeRoot = $RuntimeRoot
    error = $_.Exception.Message
    layoutTail = Get-OutputTail $LayoutOutput
    smokeTail = Get-OutputTail $SmokeOutput
  } | ConvertTo-Json -Depth 8
  exit 1
} finally {
  Stop-AcceptancePorts
  Exit-AcceptancePortLock
}
