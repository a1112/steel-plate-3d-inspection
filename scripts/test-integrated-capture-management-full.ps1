param(
  [string]$CaptureOrigin = "http://127.0.0.1:4317",
  [string]$ServiceOrigin = "http://127.0.0.1:4873",
  [string]$TriggerOrigin = "http://127.0.0.1:4881",
  [string]$ClientOrigin = "http://127.0.0.1:1432/?app=terminal",
  [string]$RuntimeRoot = "",
  [string]$ReportDir = "",
  [int]$ExpectedCameras = 6,
  [switch]$SkipRuntimeLayout,
  [switch]$SkipReady,
  [switch]$SkipRealHardware,
  [switch]$SkipUiSmoke,
  [switch]$SkipClient,
  [switch]$RunCapture,
  [switch]$RunBarSurface,
  [switch]$BarSurfaceCapture,
  [string]$BarSurfaceMaterialId = "",
  [switch]$RunShortStability,
  [int]$StabilityCycles = 1,
  [int]$StabilityDurationSec = 0,
  [int]$StabilityIntervalSec = 2,
  [int]$StabilityRunAlgorithmEvery = 0,
  [switch]$StabilityUseTriggerGateway,
  [switch]$RequireFullCoverage,
  [string]$CaptureRoot = "H:\",
  [string]$AlgorithmRoot = "G:\bar-surface-algorithm"
)

$ErrorActionPreference = "Stop"
$ScriptRoot = (Resolve-Path $PSScriptRoot).Path
$SourceMode = Test-Path (Join-Path $ScriptRoot "package-runtime.ps1") -PathType Leaf
$RepoRoot = if ($SourceMode) {
  (Resolve-Path (Join-Path $ScriptRoot "..")).Path
} else {
  $ScriptRoot
}

if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  $RuntimeRoot = if ($SourceMode) {
    Join-Path $RepoRoot "target\packages\steel-inspection-runtime"
  } else {
    $ScriptRoot
  }
}

if ([string]::IsNullOrWhiteSpace($ReportDir)) {
  $ReportDir = if ($SourceMode) {
    Join-Path $RepoRoot "target\logs\integrated-capture-management"
  } else {
    Join-Path $ScriptRoot "logs\integrated-capture-management"
  }
}

New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$RunId = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$ReportPath = Join-Path $ReportDir ("integrated-capture-management-{0}.json" -f $RunId)

function Resolve-RepoScript {
  param([string]$RelativePath)
  if ($SourceMode) {
    return Join-Path $RepoRoot $RelativePath
  }
  return Join-Path $ScriptRoot (Split-Path -Leaf $RelativePath)
}

function Resolve-RuntimeScript {
  param([string]$RelativePath)
  return Join-Path $RuntimeRoot ($RelativePath -replace "/", "\")
}

function Assert-File {
  param([string]$Path)
  if (-not (Test-Path $Path -PathType Leaf)) {
    throw "Missing required script: $Path"
  }
}

function Invoke-CheckedScript {
  param(
    [string]$ScriptPath,
    [string[]]$Arguments = @()
  )

  Assert-File $ScriptPath
  $Output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments 2>&1
  $ExitCode = $LASTEXITCODE
  return [ordered]@{
    exitCode = $ExitCode
    output = @($Output | ForEach-Object { [string]$_ })
  }
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

function Get-OutputTail {
  param([object[]]$Lines)
  return @($Lines | ForEach-Object { [string]$_ } | Select-Object -Last 80)
}

function Add-CheckResult {
  param(
    [System.Collections.Generic.List[object]]$Checks,
    [string]$Id,
    [string]$ScriptPath,
    [string[]]$Arguments = @(),
    [switch]$Skipped
  )

  if ($Skipped) {
    $Checks.Add([ordered]@{
        id = $Id
        ok = $true
        skipped = $true
      })
    return $null
  }

  $StartedAt = Get-Date
  try {
    $Result = Invoke-CheckedScript -ScriptPath $ScriptPath -Arguments $Arguments
    $Json = $null
    try {
      $Json = Read-JsonFromOutput $Result.output
    } catch {
      if ($Result.exitCode -eq 0) {
        throw
      }
    }
    if ($Result.exitCode -ne 0) {
      throw "Script failed with exit $($Result.exitCode): $ScriptPath"
    }
    if ($null -ne $Json -and ($Json.PSObject.Properties.Name -contains "code") -and [int]$Json.code -ne 0) {
      throw "Script returned code $($Json.code): $ScriptPath"
    }

    $Checks.Add([ordered]@{
        id = $Id
        ok = $true
        skipped = $false
        script = $ScriptPath
        elapsedSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 3)
        summary = $Json
        outputTail = Get-OutputTail $Result.output
      })
    return $Json
  } catch {
    $Checks.Add([ordered]@{
        id = $Id
        ok = $false
        skipped = $false
        script = $ScriptPath
        elapsedSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 3)
        error = $_.Exception.Message
        outputTail = if ($Result) { Get-OutputTail $Result.output } else { @() }
      })
    throw
  }
}

function Get-CheckById {
  param(
    [System.Collections.Generic.List[object]]$Checks,
    [string]$Id
  )

  return @($Checks | Where-Object { [string](Get-ObjectMemberValue -Object $_ -Name "id") -eq $Id } | Select-Object -First 1)[0]
}

function Test-ObjectMember {
  param(
    [object]$Object,
    [string]$Name
  )

  if ($null -eq $Object) {
    return $false
  }
  if ($Object -is [System.Collections.IDictionary]) {
    return $Object.Contains($Name)
  }
  return $Object.PSObject.Properties.Name -contains $Name
}

function Get-ObjectMemberValue {
  param(
    [object]$Object,
    [string]$Name,
    [object]$Default = $null
  )

  if ($null -eq $Object) {
    return $Default
  }
  if ($Object -is [System.Collections.IDictionary]) {
    if ($Object.Contains($Name)) {
      return $Object[$Name]
    }
    return $Default
  }
  if ($Object.PSObject.Properties.Name -contains $Name) {
    return $Object.$Name
  }
  return $Default
}

function New-CoverageItem {
  param(
    [string]$Id,
    [string]$Label,
    [object]$Check,
    [string]$Evidence = "",
    [bool]$Required = $true,
    [bool]$ExtraCondition = $true,
    [string]$SkipReason = ""
  )

  $Exists = $null -ne $Check
  $HasSkipped = Test-ObjectMember -Object $Check -Name "skipped"
  $HasOk = Test-ObjectMember -Object $Check -Name "ok"
  $Skipped = (-not $Exists) -or ($HasSkipped -and [bool](Get-ObjectMemberValue -Object $Check -Name "skipped"))
  $CheckOk = $Exists -and $HasOk -and [bool](Get-ObjectMemberValue -Object $Check -Name "ok")
  $Covered = $Required -and $CheckOk -and (-not $Skipped) -and $ExtraCondition
  $Reason = $SkipReason
  if ([string]::IsNullOrWhiteSpace($Reason)) {
    if (-not $Exists) {
      $Reason = "check missing"
    } elseif ($Skipped) {
      $Reason = "check skipped"
    } elseif (-not $CheckOk) {
      $Reason = "check failed"
    } elseif (-not $ExtraCondition) {
      $Reason = "required mode was not exercised"
    }
  }

  return [ordered]@{
    id = $Id
    label = $Label
    required = $Required
    covered = [bool]$Covered
    ok = [bool]$CheckOk
    skipped = [bool]$Skipped
    evidence = $Evidence
    reason = if ($Covered) { "" } else { $Reason }
  }
}

function Invoke-ServiceJson {
  param(
    [ValidateSet("GET", "POST")]
    [string]$Method,
    [string]$Path,
    [object]$Body = $null,
    [int]$TimeoutSec = 30
  )

  $Uri = $ServiceOrigin.TrimEnd("/") + "/" + $Path.TrimStart("/")
  if ($Method -eq "GET") {
    return Invoke-RestMethod -Method Get -Uri $Uri -TimeoutSec $TimeoutSec
  }
  $JsonBody = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Compress -Depth 20 }
  return Invoke-RestMethod -Method Post -Uri $Uri -ContentType "application/json; charset=utf-8" -Body $JsonBody -TimeoutSec $TimeoutSec
}

function Get-LatestBarSurfaceMaterialId {
  $Captures = Invoke-ServiceJson -Method GET -Path "/api/algorithm/bar-surface/captures" -TimeoutSec 30
  $Candidate = @($Captures.materials |
      Where-Object { [int]$_.cameraCount -ge $ExpectedCameras -and [int]$_.minDepthFrames -ge 1 } |
      Select-Object -First 1)[0]
  if ($null -eq $Candidate -or [string]::IsNullOrWhiteSpace([string]$Candidate.materialId)) {
    throw "No existing six-camera bar-surface capture is available. Rerun with -BarSurfaceCapture to capture a fresh material."
  }
  return [string]$Candidate.materialId
}

$Checks = [System.Collections.Generic.List[object]]::new()
$Failures = [System.Collections.Generic.List[string]]::new()
$StartedAt = Get-Date
$ResolvedRuntimeRoot = ""

try {
  $ResolvedRuntimeRoot = (Resolve-Path $RuntimeRoot).Path
} catch {
  $ResolvedRuntimeRoot = $RuntimeRoot
}

try {
  $LayoutScript = if ($SourceMode) {
    Resolve-RepoScript "scripts\test-runtime-layout.ps1"
  } else {
    Resolve-RuntimeScript "test-runtime-layout.ps1"
  }
  $LayoutArgs = @("-RuntimeRoot", $ResolvedRuntimeRoot)
  $null = Add-CheckResult -Checks $Checks -Id "runtime-layout" -ScriptPath $LayoutScript -Arguments $LayoutArgs -Skipped:$SkipRuntimeLayout

  $ReadyScript = if ($SourceMode) {
    Resolve-RepoScript "scripts\test-integrated-runtime-ready.ps1"
  } else {
    Resolve-RuntimeScript "test-integrated-runtime-ready.ps1"
  }
  $ReadyArgs = @(
    "-CaptureOrigin", $CaptureOrigin,
    "-ServiceOrigin", $ServiceOrigin,
    "-TriggerOrigin", $TriggerOrigin,
    "-ClientOrigin", $ClientOrigin
  )
  if ($SkipClient) {
    $ReadyArgs += "-SkipClient"
  }
  $null = Add-CheckResult -Checks $Checks -Id "live-ready" -ScriptPath $ReadyScript -Arguments $ReadyArgs -Skipped:$SkipReady

  $HardwareScript = if ($SourceMode) {
    Resolve-RepoScript "scripts\test-real-hardware-acceptance.ps1"
  } else {
    Resolve-RuntimeScript "test-real-hardware-acceptance.ps1"
  }
  $HardwareArgs = @(
    "-CaptureOrigin", $CaptureOrigin,
    "-ServiceOrigin", $ServiceOrigin,
    "-TriggerOrigin", $TriggerOrigin,
    "-ClientOrigin", $ClientOrigin,
    "-CaptureRoot", $CaptureRoot,
    "-ExpectedCameras", [string]$ExpectedCameras
  )
  if ($SkipClient) {
    $HardwareArgs += "-SkipClient"
  }
  if ($RunCapture) {
    $HardwareArgs += "-RunCapture"
  }
  $null = Add-CheckResult -Checks $Checks -Id "real-hardware" -ScriptPath $HardwareScript -Arguments $HardwareArgs -Skipped:$SkipRealHardware

  $UiScript = if ($SourceMode) {
    Resolve-RepoScript "scripts\test-runtime-ui-smoke.ps1"
  } else {
    Resolve-RuntimeScript "test-runtime-ui-smoke.ps1"
  }
  $UiArgs = @("-ClientOrigin", $ClientOrigin)
  $null = Add-CheckResult -Checks $Checks -Id "ui-smoke" -ScriptPath $UiScript -Arguments $UiArgs -Skipped:($SkipUiSmoke -or $SkipClient)

  if ($RunShortStability) {
    $StabilityScript = if ($SourceMode) {
      Resolve-RepoScript "scripts\test-production-stability.ps1"
    } else {
      Resolve-RuntimeScript "test-production-stability.ps1"
    }
    $StabilityArgs = @(
      "-CaptureOrigin", $CaptureOrigin,
      "-ServiceOrigin", $ServiceOrigin,
      "-TriggerOrigin", $TriggerOrigin,
      "-ClientOrigin", $ClientOrigin,
      "-CaptureRoot", $CaptureRoot,
      "-AlgorithmRoot", $AlgorithmRoot,
      "-ExpectedCameras", [string]$ExpectedCameras,
      "-DurationSec", [string]$StabilityDurationSec,
      "-IntervalSec", [string]$StabilityIntervalSec,
      "-RunAlgorithmEvery", [string]$StabilityRunAlgorithmEvery
    )
    if ($StabilityDurationSec -le 0) {
      $StabilityArgs += @("-MaxCycles", [string]$StabilityCycles)
    }
    if ($SkipClient) {
      $StabilityArgs += "-SkipClient"
    }
    if ($StabilityUseTriggerGateway) {
      $StabilityArgs += "-UseTriggerGateway"
    }
    $null = Add-CheckResult -Checks $Checks -Id "short-stability" -ScriptPath $StabilityScript -Arguments $StabilityArgs
  } else {
    $Checks.Add([ordered]@{ id = "short-stability"; ok = $true; skipped = $true })
  }

  if ($RunBarSurface) {
    $BarScript = if ($SourceMode) {
      Resolve-RepoScript "scripts\test-bar-surface-e2e.ps1"
    } else {
      Resolve-RuntimeScript "scripts\test-bar-surface-e2e.ps1"
    }
    $MaterialForBarSurface = $BarSurfaceMaterialId
    $BarArgs = @(
      "-ServiceOrigin", $ServiceOrigin,
      "-ExpectedCameras", [string]$ExpectedCameras,
      "-CaptureRoot", $CaptureRoot,
      "-AlgorithmRoot", $AlgorithmRoot
    )
    if (-not $BarSurfaceCapture) {
      if ([string]::IsNullOrWhiteSpace($MaterialForBarSurface)) {
        $MaterialForBarSurface = Get-LatestBarSurfaceMaterialId
      }
      $BarArgs += @("-SkipCapture", "-MaterialId", $MaterialForBarSurface)
    } elseif (-not [string]::IsNullOrWhiteSpace($MaterialForBarSurface)) {
      $BarArgs += @("-MaterialId", $MaterialForBarSurface)
    }
    $null = Add-CheckResult -Checks $Checks -Id "bar-surface-e2e" -ScriptPath $BarScript -Arguments $BarArgs
  } else {
    $Checks.Add([ordered]@{ id = "bar-surface-e2e"; ok = $true; skipped = $true })
  }
} catch {
  $Failures.Add($_.Exception.Message)
}

$RuntimeCheck = Get-CheckById -Checks $Checks -Id "runtime-layout"
$ReadyCheck = Get-CheckById -Checks $Checks -Id "live-ready"
$HardwareCheck = Get-CheckById -Checks $Checks -Id "real-hardware"
$UiCheck = Get-CheckById -Checks $Checks -Id "ui-smoke"
$BarSurfaceCheck = Get-CheckById -Checks $Checks -Id "bar-surface-e2e"
$StabilityCheck = Get-CheckById -Checks $Checks -Id "short-stability"

$CoverageItems = @(
  (New-CoverageItem `
      -Id "runtime-package" `
      -Label "target runtime/package layout includes service, trigger, capture provider, Qt viewer, client, scripts and config" `
      -Check $RuntimeCheck `
      -Evidence "test-runtime-layout.ps1"),
  (New-CoverageItem `
      -Id "live-stack" `
      -Label "capture provider, Rust service, trigger gateway, network monitor and terminal client are reachable" `
      -Check $ReadyCheck `
      -Evidence "test-integrated-runtime-ready.ps1"),
  (New-CoverageItem `
      -Id "real-hardware-six-camera" `
      -Label "real SDK provider sees six cameras, H-drive storage roots, and current camera configuration" `
      -Check $HardwareCheck `
      -Evidence "test-real-hardware-acceptance.ps1"),
  (New-CoverageItem `
      -Id "ui-workspaces" `
      -Label "terminal, capture management and 3D reconstruction workspaces render and expose key controls" `
      -Check $UiCheck `
      -Evidence "test-runtime-ui-smoke.ps1"),
  (New-CoverageItem `
      -Id "production-trigger-storage" `
      -Label "production steel-in/capture/steel-out flow stores depth, intensity and metadata under H:\camera1..camera6 with sdk-derived disabled" `
      -Check $StabilityCheck `
      -Evidence "test-production-stability.ps1" `
      -ExtraCondition ([bool]$RunShortStability)),
  (New-CoverageItem `
      -Id "trigger-gateway-route" `
      -Label "production flow is exercised through the standalone trigger gateway API" `
      -Check $StabilityCheck `
      -Evidence "test-production-stability.ps1 -UseTriggerGateway" `
      -ExtraCondition ([bool]$RunShortStability -and [bool]$StabilityUseTriggerGateway) `
      -SkipReason $(if (-not $RunShortStability) { "short stability was not run" } elseif (-not $StabilityUseTriggerGateway) { "trigger gateway route was not requested" } else { "" })),
  (New-CoverageItem `
      -Id "bar-surface-e2e" `
      -Label "latest six-camera capture can run calibrated 3D reconstruction, artifact indexing and acceptance checks" `
      -Check $BarSurfaceCheck `
      -Evidence "test-bar-surface-e2e.ps1" `
      -ExtraCondition ([bool]$RunBarSurface))
)
$UncoveredItems = @($CoverageItems | Where-Object { $_.required -eq $true -and $_.covered -ne $true })
$Coverage = [ordered]@{
  full = ($UncoveredItems.Count -eq 0)
  requireFullCoverage = [bool]$RequireFullCoverage
  covered = @($CoverageItems | Where-Object { $_.covered -eq $true }).Count
  required = @($CoverageItems | Where-Object { $_.required -eq $true }).Count
  uncovered = @($UncoveredItems | ForEach-Object { $_.id })
  items = @($CoverageItems)
}

if ($RequireFullCoverage -and $UncoveredItems.Count -gt 0) {
  $Failures.Add(("Full coverage required but not proven: {0}" -f (($UncoveredItems | ForEach-Object { "{0} ({1})" -f $_.id, $_.reason }) -join "; ")))
}

$Report = [ordered]@{
  schema = "steel.integrated-capture-management.acceptance.v1"
  code = if ($Failures.Count -eq 0 -and @($Checks | Where-Object { $_.ok -eq $false }).Count -eq 0) { 0 } else { 1 }
  runId = $RunId
  checkedAt = (Get-Date).ToString("o")
  elapsedSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 3)
  sourceMode = [bool]$SourceMode
  runtimeRoot = $ResolvedRuntimeRoot
  origins = [ordered]@{
    capture = $CaptureOrigin
    service = $ServiceOrigin
    trigger = $TriggerOrigin
    client = if ($SkipClient) { $null } else { $ClientOrigin }
  }
  requested = [ordered]@{
    expectedCameras = $ExpectedCameras
    runCapture = [bool]$RunCapture
    runBarSurface = [bool]$RunBarSurface
    barSurfaceCapture = [bool]$BarSurfaceCapture
    runShortStability = [bool]$RunShortStability
    stabilityCycles = $StabilityCycles
    stabilityDurationSec = $StabilityDurationSec
    stabilityIntervalSec = $StabilityIntervalSec
    stabilityRunAlgorithmEvery = $StabilityRunAlgorithmEvery
    stabilityUseTriggerGateway = [bool]$StabilityUseTriggerGateway
    requireFullCoverage = [bool]$RequireFullCoverage
  }
  coverage = $Coverage
  checks = @($Checks)
  failures = @($Failures)
  reportPath = $ReportPath
}

$Report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
$Report | ConvertTo-Json -Depth 20

if ($Report.code -ne 0) {
  exit 1
}
