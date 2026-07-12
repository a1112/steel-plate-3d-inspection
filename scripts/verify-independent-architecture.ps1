param(
  [switch]$SkipFrontendBuild,
  [switch]$SkipClientTests,
  [switch]$SkipServiceTests,
  [switch]$SkipTriggerTests,
  [switch]$SkipCaptureBuild,
  [switch]$SkipServiceBuild,
  [switch]$SkipTriggerBuild,
  [switch]$SkipExternalProviderCheck,
  [switch]$SkipPackage,
  [switch]$CheckQt,
  [string]$QtPrefixPath = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ClientDir = Join-Path $RepoRoot "app\client"

function Invoke-Checked {
  param(
    [string]$Command,
    [string[]]$Arguments,
    [string]$WorkingDirectory = $RepoRoot
  )
  Push-Location $WorkingDirectory
  try {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "$Command failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Assert-NoMatches {
  param(
    [string]$Pattern,
    [string]$Path,
    [string]$Message
  )
  $Matches = & rg -n $Pattern $Path
  if ($LASTEXITCODE -eq 0) {
    Write-Host $Matches
    throw $Message
  }
  if ($LASTEXITCODE -gt 1) {
    throw "rg failed while checking $Path"
  }
}

function Assert-PathExists {
  param(
    [string]$Path,
    [string]$Message,
    [ValidateSet("Any", "Leaf", "Container")]
    [string]$Type = "Any"
  )

  $PathType = if ($Type -eq "Any") { "Any" } else { $Type }
  if ($PathType -eq "Any") {
    if (-not (Test-Path $Path)) {
      throw $Message
    }
  } elseif (-not (Test-Path $Path -PathType $PathType)) {
    throw $Message
  }
}

function Assert-PowerShellScriptParses {
  param([string]$Path)

  Assert-PathExists $Path "Missing PowerShell script: $Path" "Leaf"
  $Tokens = $null
  $Errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$Tokens, [ref]$Errors) | Out-Null
  if ($Errors.Count -gt 0) {
    $Errors | Format-List | Out-String | Write-Host
    throw "PowerShell script has parse errors: $Path"
  }
}

function Resolve-PackagePath {
  param(
    [string]$PackageDir,
    [string]$RelativePath
  )
  return Join-Path $PackageDir ($RelativePath -replace "/", "\")
}

function Normalize-ProcessPathEnvironment {
  $PathValue = [Environment]::GetEnvironmentVariable("Path", "Process")
  if ([string]::IsNullOrEmpty($PathValue)) {
    $PathValue = [Environment]::GetEnvironmentVariable("PATH", "Process")
  }
  [Environment]::SetEnvironmentVariable("PATH", $null, "Process")
  if (-not [string]::IsNullOrEmpty($PathValue)) {
    [Environment]::SetEnvironmentVariable("Path", $PathValue, "Process")
  }
}

function Get-FreeLocalPort {
  $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), 0)
  try {
    $Listener.Start()
    return $Listener.LocalEndpoint.Port
  } finally {
    $Listener.Stop()
  }
}

function Test-PackagedRuntimeContract {
  param([switch]$ExpectQt)

  $PackageDir = Join-Path $RepoRoot "target\packages\steel-inspection-runtime"
  Assert-PathExists $PackageDir "Missing runtime package directory: $PackageDir" "Container"

  $ManifestPath = Join-Path $PackageDir "manifest.json"
  Assert-PathExists $ManifestPath "Missing runtime manifest: $ManifestPath" "Leaf"
  try {
    $Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
  } catch {
    throw "Runtime manifest must be valid JSON: $ManifestPath"
  }

  $RequiredManifestValues = @{
    "capture.path" = $Manifest.capture.path
    "capture.sdk" = $Manifest.capture.sdk
    "service.path" = $Manifest.service.path
    "service.triggerGateway" = $Manifest.service.triggerGateway
    "client.path" = $Manifest.client.path
    "scripts.captureHeadless" = $Manifest.scripts.captureHeadless
    "scripts.serviceExternal" = $Manifest.scripts.serviceExternal
    "scripts.serviceSimulated" = $Manifest.scripts.serviceSimulated
    "scripts.triggerGateway" = $Manifest.scripts.triggerGateway
    "scripts.integrated" = $Manifest.scripts.integrated
    "scripts.integratedFullAcceptanceTest" = $Manifest.scripts.integratedFullAcceptanceTest
    "scripts.integratedAcceptanceAuditTest" = $Manifest.scripts.integratedAcceptanceAuditTest
    "scripts.migrationArchitectureTest" = $Manifest.scripts.migrationArchitectureTest
    "scripts.integratedSmokeTest" = $Manifest.scripts.integratedSmokeTest
    "scripts.integratedReadyTest" = $Manifest.scripts.integratedReadyTest
    "scripts.runtimeAcceptanceTest" = $Manifest.scripts.runtimeAcceptanceTest
    "scripts.runtimeLayoutTest" = $Manifest.scripts.runtimeLayoutTest
    "scripts.runtimeUiSmokeTest" = $Manifest.scripts.runtimeUiSmokeTest
    "scripts.realHardwareAcceptanceTest" = $Manifest.scripts.realHardwareAcceptanceTest
    "scripts.realCalibrationAcceptanceTest" = $Manifest.scripts.realCalibrationAcceptanceTest
    "scripts.realCalibrationCrashRecoveryTest" = $Manifest.scripts.realCalibrationCrashRecoveryTest
    "scripts.realCalibrationIntegrityGenerationTest" = $Manifest.scripts.realCalibrationIntegrityGenerationTest
    "scripts.productionStabilityTest" = $Manifest.scripts.productionStabilityTest
    "scripts.barSurfaceE2ETest" = $Manifest.scripts.barSurfaceE2ETest
    "scripts.clientStatic" = $Manifest.scripts.clientStatic
    "scripts.stop" = $Manifest.scripts.stop
    "algorithm.core" = $Manifest.algorithm.core
  }

  foreach ($Entry in $RequiredManifestValues.GetEnumerator()) {
    if ([string]::IsNullOrWhiteSpace([string]$Entry.Value)) {
      throw "Runtime manifest missing $($Entry.Key)"
    }
    $ExpectedPath = Resolve-PackagePath $PackageDir ([string]$Entry.Value)
    Assert-PathExists $ExpectedPath "Runtime manifest points to missing file for $($Entry.Key): $ExpectedPath" "Leaf"
  }

  $MigrationArchitectureTest = Resolve-PackagePath $PackageDir $Manifest.scripts.migrationArchitectureTest
  $MigrationArchitectureReportText = (& $MigrationArchitectureTest -ManifestPath $ManifestPath | Out-String)
  $MigrationArchitectureReport = $MigrationArchitectureReportText | ConvertFrom-Json
  if ($MigrationArchitectureReport.code -ne 0) {
    throw "Packaged runtime failed the architecture migration contract."
  }

  if ($ExpectQt) {
    if ([string]::IsNullOrWhiteSpace([string]$Manifest.captureQt.path)) {
      throw "Runtime manifest missing captureQt.path when -CheckQt is used."
    }
    $QtExePath = Resolve-PackagePath $PackageDir $Manifest.captureQt.path
    $QtOutDir = Split-Path -Parent $QtExePath
    Assert-PathExists $QtExePath "Runtime manifest points to missing Qt executable." "Leaf"
    Assert-PathExists (Join-Path $QtOutDir "Qt6Core.dll") "Runtime Qt package is missing Qt6Core.dll; -CheckQt must preserve deployed Qt DLLs." "Leaf"
    Assert-PathExists (Join-Path $QtOutDir "Qt6Widgets.dll") "Runtime Qt package is missing Qt6Widgets.dll; -CheckQt must preserve deployed Qt DLLs." "Leaf"
    Assert-PathExists (Resolve-PackagePath $PackageDir $Manifest.scripts.captureQt) "Runtime manifest points to missing Qt run script." "Leaf"
  }

  $ScriptNames = @(
    "run-capture-headless.ps1",
    "run-service-external.ps1",
    "run-service-simulated.ps1",
    "run-trigger-gateway.ps1",
    "run-integrated-capture-management.ps1",
    "test-integrated-capture-management-full.ps1",
    "test-integrated-acceptance-audit.ps1",
    "test-architecture-migration-contract.ps1",
    "test-integrated-management-smoke.ps1",
    "test-integrated-runtime-ready.ps1",
    "test-runtime-acceptance.ps1",
    "test-real-hardware-acceptance.ps1",
    "test-real-calibration-acceptance.ps1",
    "test-real-calibration-crash-recovery.ps1",
    "test-real-calibration-integrity-generation.ps1",
    "test-production-stability.ps1",
    "test-runtime-ui-smoke.ps1",
    "scripts\test-bar-surface-e2e.ps1",
    "test-runtime-layout.ps1",
    "run-client-static.ps1",
    "stop-runtime.ps1"
  )
  if ($ExpectQt) {
    $ScriptNames += "run-capture-qt.ps1"
  }
  foreach ($Script in $ScriptNames) {
    Assert-PowerShellScriptParses (Join-Path $PackageDir $Script)
  }

  $IntegratedScript = Join-Path $PackageDir "run-integrated-capture-management.ps1"
  $IntegratedText = Get-Content $IntegratedScript -Raw
  foreach ($RequiredText in @("/health", "/api/production/status", "/api/trigger/status", "run-trigger-gateway.ps1", "run-client-static.ps1", "StopExisting", "stop-runtime.ps1", "Wait-HttpHtml", "Client ready", "Assert-CaptureProviderMatches", "storageRoot", "configRoot")) {
    if ($IntegratedText -notmatch [regex]::Escape($RequiredText)) {
      throw "Integrated runtime script must wait for or invoke $RequiredText"
    }
  }

  foreach ($CaptureScriptName in @("run-capture-headless.ps1", "run-capture-qt.ps1", "run-integrated-capture-management.ps1")) {
    $CaptureScript = Join-Path $PackageDir $CaptureScriptName
    if (-not (Test-Path $CaptureScript -PathType Leaf)) {
      continue
    }
    $CaptureText = Get-Content $CaptureScript -Raw
    if ($CaptureText -match [regex]::Escape("H:\steel-capture-data")) {
      throw "Packaged $CaptureScriptName must not default to H:\steel-capture-data; production frames must land under H:\camera1..camera6."
    }
    $RequiredStorageTexts = if ($CaptureScriptName -eq "run-integrated-capture-management.ps1") {
      @('[string]$StorageRoot = "H:\"', '[string]$CameraStorageRoot = "H:\"', "-CameraStorageRoot")
    } else {
      @('[string]$StorageRoot = "H:\"', '[string]$CameraStorageRoot = "H:\"', '$env:CAPTURE_CAMERA_STORAGE_ROOT = $CameraStorageRoot')
    }
    foreach ($RequiredText in $RequiredStorageTexts) {
      if ($CaptureText -notmatch [regex]::Escape($RequiredText)) {
        throw "Packaged $CaptureScriptName must keep the H:\ production storage default via $RequiredText"
      }
    }
  }

  $StopScript = Join-Path $PackageDir "stop-runtime.ps1"
  $StopText = Get-Content $StopScript -Raw
  foreach ($RequiredText in @("Get-NetTCPConnection", "netstat -ano", "1432", ".Id -gt 4", '-ne $PID')) {
    if ($StopText -notmatch [regex]::Escape($RequiredText)) {
      throw "Packaged stop-runtime.ps1 must stop static-client listeners by port using $RequiredText"
    }
  }

  $SmokeScript = Join-Path $PackageDir "test-integrated-management-smoke.ps1"
  $SmokeText = Get-Content $SmokeScript -Raw
  foreach ($RequiredText in @("run-service-simulated.ps1", "/api/production/steel-info", "/api/trigger/manual/steel-in", "recordWrittenBeforeCapture", "/api/production/status", "/api/system/network", "totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps", "uploadMbps", "downloadMbps", "rateFields", "/api/production/capture-once", "captureGuard", "captureOnce", "captureFileRows", "RunId", 'runs\$RunId\config\service', "-ConfigRoot", "Write-SmokeReport", "reportPath")) {
    if ($SmokeText -notmatch [regex]::Escape($RequiredText)) {
      throw "Integrated smoke test must verify $RequiredText"
    }
  }

  foreach ($ServiceScriptName in @("run-service-simulated.ps1", "run-service-external.ps1")) {
    $ServiceScript = Join-Path $PackageDir $ServiceScriptName
    $ServiceText = Get-Content $ServiceScript -Raw
  foreach ($RequiredText in @('[string]$ConfigRoot', '$env:STEEL_SERVICE_CONFIG_DIR = $ConfigRoot')) {
    if ($ServiceText -notmatch [regex]::Escape($RequiredText)) {
      throw "Packaged $ServiceScriptName must support isolated service config roots via $RequiredText"
    }
  }
  foreach ($RequiredText in @('$env:STEEL_WORKSPACE_ROOT = $Root', '$env:STEEL_BAR_SURFACE_CORE_EXE = Join-Path $Root "algorithm-core\steel_bar_surface_core.exe"')) {
    if ($ServiceText -notmatch [regex]::Escape($RequiredText)) {
      throw "Packaged $ServiceScriptName must expose packaged algorithm assets via $RequiredText"
    }
  }
}

  $ReadyScript = Join-Path $PackageDir "test-integrated-runtime-ready.ps1"
  $ReadyText = Get-Content $ReadyScript -Raw
  foreach ($RequiredText in @("/health", "/api/health/details", "/api/production/status", "/api/system/network", "database", "taskWorker", "capture", "calibrationReconciliation", "storage", "trigger", "trigger.required", "totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps", "uploadMbps", "downloadMbps", "bandwidthMbps", "/api/trigger/status", "?app=terminal")) {
    if ($ReadyText -notmatch [regex]::Escape($RequiredText)) {
      throw "Integrated ready test must verify $RequiredText"
    }
  }

  $IntegratedFullScript = Join-Path $PackageDir "test-integrated-capture-management-full.ps1"
  $IntegratedFullText = Get-Content $IntegratedFullScript -Raw
  foreach ($RequiredText in @(
    "steel.integrated-capture-management.acceptance.v1",
    "test-runtime-layout.ps1",
    "test-integrated-runtime-ready.ps1",
    "test-real-hardware-acceptance.ps1",
    "test-real-calibration-acceptance.ps1",
    "test-real-calibration-crash-recovery.ps1",
    "test-real-calibration-integrity-generation.ps1",
    "test-runtime-ui-smoke.ps1",
    "test-bar-surface-e2e.ps1",
    "test-production-stability.ps1",
    "RunCapture",
    "RunCalibrationApplyRollback",
    "CalibrationSafetyConfirmation",
    "ApplyCrashRecoveryReportPath",
    "RollbackCrashRecoveryReportPath",
    "CalibrationIntegrityGenerationReportPath",
    "RunBarSurface",
    "RunShortStability",
    "StabilityDurationSec",
    "StabilityIntervalSec",
    "StabilityRunAlgorithmEvery",
    "StabilityUseTriggerGateway",
    "RequireFullCoverage",
    "coverage",
    "full =",
    "covered =",
    "required =",
    "uncovered",
    "trigger-gateway-route",
    "real-calibration-apply-rollback",
    "real-calibration-crash-recovery",
    "real-calibration-integrity-generation",
    "bar-surface-e2e",
    "integrated-capture-management",
    "reportPath"
  )) {
    if ($IntegratedFullText -notmatch [regex]::Escape($RequiredText)) {
      throw "Integrated full acceptance test must orchestrate $RequiredText"
    }
  }

  $IntegratedAuditScript = Join-Path $PackageDir "test-integrated-acceptance-audit.ps1"
  $IntegratedAuditText = Get-Content $IntegratedAuditScript -Raw
  foreach ($RequiredText in @(
    "steel.integrated-capture-management.acceptance-audit.v1",
    "ICM-01",
    "ICM-23",
    'RequiredCount = 23',
    "test-architecture-migration-contract.ps1",
    "integratedReportPath",
    "tenMinuteReportPath",
    "acceptance-audit",
    "MinEnduranceCycles",
    "estimated-speed fallback",
    "calibrated-3d",
    "sdkDerived",
    "trigger-gateway-route",
    "verify-independent-architecture.ps1"
  )) {
    if ($IntegratedAuditText -notmatch [regex]::Escape($RequiredText)) {
      throw "Integrated acceptance audit must verify $RequiredText"
    }
  }

  $IntegratedAcceptanceDoc = Join-Path $PackageDir "docs\integrated-capture-management-acceptance.md"
  Assert-PathExists $IntegratedAcceptanceDoc "Runtime package must include integrated capture management acceptance matrix." "Leaf"
  $IntegratedAcceptanceDocText = Get-Content $IntegratedAcceptanceDoc -Raw
  foreach ($RequiredText in @(
    "Integrated Capture Management Acceptance Matrix",
    "RequireFullCoverage",
    "coverage.full",
    "coverage.covered",
    "coverage.required",
    "ICM-01",
    "ICM-23",
    "summary.passed=23",
    "test-architecture-migration-contract.ps1",
    "H:\camera1",
    "integrated-capture-management-20260709-121522-831.json",
    "BAR-STABILITY-20260709-121618-010",
    "BAR-STABILITY-20260709-114929-127",
    "production-stability-20260709-114934-134.json",
    "estimated-speed fallback",
    "calibrated-3d"
  )) {
    if ($IntegratedAcceptanceDocText -notmatch [regex]::Escape($RequiredText)) {
      throw "Integrated acceptance matrix must document $RequiredText"
    }
  }

  $UiSmokeScript = Join-Path $PackageDir "test-runtime-ui-smoke.ps1"
  $UiSmokeText = Get-Content $UiSmokeScript -Raw
  foreach ($RequiredText in @(
    "steel.runtime.ui-smoke.v1",
    "Target.createTarget",
    "Page.captureScreenshot",
    "receiver-status-button",
    "\u5b9e\u65f6\u4e0a\u4f20",
    "\u5b9e\u65f6\u4e0b\u8f7d",
    "\u5e26\u5bbd\u76d1\u63a7",
    "Windows \u7f51\u5361\u5b9e\u65f6\u6536\u53d1\u901f\u7387",
    "network monitor pending",
    "network monitor offline",
    "\u4f30\u7b97\u7f51\u901f",
    "terminal",
    "capture",
    "bar-surface",
    "ui-smoke-report.json",
    "msedge.exe",
    "chrome.exe"
  )) {
    if ($UiSmokeText -notmatch [regex]::Escape($RequiredText)) {
      throw "Runtime UI smoke test must verify $RequiredText"
    }
  }

  $AcceptanceScript = Join-Path $PackageDir "test-runtime-acceptance.ps1"
  $AcceptanceText = Get-Content $AcceptanceScript -Raw
  foreach ($RequiredText in @("test-runtime-layout.ps1", "test-integrated-management-smoke.ps1", "Stop-AcceptancePorts", "Get-NetTCPConnection", "netstat -ano", "SteelInspectionRuntimeAcceptance", "Assert-SmokeResult", "Read-JsonFromOutput", "reportPath", "totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps", "rateFields", "captureGuard", "captureOnce", "captureFileRows")) {
    if ($AcceptanceText -notmatch [regex]::Escape($RequiredText)) {
      throw "Runtime acceptance test must verify $RequiredText"
    }
  }

  $RealHardwareScript = Join-Path $PackageDir "test-real-hardware-acceptance.ps1"
  $RealHardwareText = Get-Content $RealHardwareScript -Raw
  foreach ($RequiredText in @("/api/production/capture-once", "/api/system/network", "totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps", "uploadMbps", "downloadMbps", "H:\camera", "saveSdkDerived", "productionLayout", "steel.production.summary.v1", "captureFiles")) {
    if ($RealHardwareText -notmatch [regex]::Escape($RequiredText)) {
      throw "Real hardware acceptance test must verify $RequiredText"
    }
  }

  $RealCalibrationScript = Join-Path $PackageDir "test-real-calibration-acceptance.ps1"
  $RealCalibrationText = Get-Content $RealCalibrationScript -Raw
  foreach ($RequiredText in @("steel.real-calibration.acceptance.v1", "/api/calibration/apply-all", "/api/calibration/rollback", "/api/calibration/operations/detail", "SafetyConfirmation", "/api/capture/continuous-test", "calibrationReconciliation")) {
    if ($RealCalibrationText -notmatch [regex]::Escape($RequiredText)) {
      throw "Real calibration acceptance test must verify $RequiredText"
    }
  }

  $RealCalibrationCrashScript = Join-Path $PackageDir "test-real-calibration-crash-recovery.ps1"
  $RealCalibrationCrashText = Get-Content $RealCalibrationCrashScript -Raw
  foreach ($RequiredText in @("steel.real-calibration.crash-recovery.v1", "ApplyCrash", "RollbackCrash", "calibrationCrashFailpointArmed", "expectedApplyOperationId", "parentOperationId", "reconciled")) {
    if ($RealCalibrationCrashText -notmatch [regex]::Escape($RequiredText)) {
      throw "Real calibration crash-recovery test must verify $RequiredText"
    }
  }

  $RealCalibrationIntegrityScript = Join-Path $PackageDir "test-real-calibration-integrity-generation.ps1"
  $RealCalibrationIntegrityText = Get-Content $RealCalibrationIntegrityScript -Raw
  foreach ($RequiredText in @("steel.real-calibration.integrity-generation.v1", "sideEffects", "zeroWriteEvidence", "staleGeneration", "stagedTamper")) {
    if ($RealCalibrationIntegrityText -notmatch [regex]::Escape($RequiredText)) {
      throw "Real calibration integrity/generation test must verify $RequiredText"
    }
  }

  $ProductionStabilityScript = Join-Path $PackageDir "test-production-stability.ps1"
  $ProductionStabilityText = Get-Content $ProductionStabilityScript -Raw
  foreach ($RequiredText in @("/api/production/steel-in", "/api/production/capture-once", "/api/production/steel-out", "/api/production/algorithm/run", "/api/system/network", "/api/trigger/manual/steel-in", "/api/trigger/capture-once", "UseTriggerGateway", "triggerRoute", "totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps", "uploadMbps", "downloadMbps", "steel.production.stability.v1", "steel.production.summary.v1", "H:\", "RunAlgorithmEvery", "activeSession", "sdkDerived")) {
    if ($ProductionStabilityText -notmatch [regex]::Escape($RequiredText)) {
      throw "Production stability test must verify $RequiredText"
    }
  }

  Assert-PathExists (Join-Path $PackageDir "scripts\bar_surface_reconstruct.py") "Runtime package is missing bar surface reconstruction script." "Leaf"
  Assert-PathExists (Join-Path $PackageDir "scripts\fit_array_calibration_cross_section.py") "Runtime package is missing calibration fit script." "Leaf"
  Assert-PathExists (Join-Path $PackageDir "algorithm-core\steel_bar_surface_core.exe") "Runtime package is missing bar surface C++ core executable." "Leaf"
  $BarSurfaceScript = Join-Path $PackageDir "scripts\test-bar-surface-e2e.ps1"
  $BarSurfaceText = Get-Content $BarSurfaceScript -Raw
  foreach ($RequiredText in @("/api/production/algorithm/run", "/api/algorithm/bar-surface/latest", "captureSummary", "steel.production.summary.v1", "coreOutputBytes", "sdkDerived", "contourCrop")) {
    if ($BarSurfaceText -notmatch [regex]::Escape($RequiredText)) {
      throw "Bar surface E2E test must verify $RequiredText"
    }
  }

  $BarSurfaceAlgorithmScript = Join-Path $PackageDir "scripts\bar_surface_reconstruct.py"
  $BarSurfaceAlgorithmText = Get-Content $BarSurfaceAlgorithmScript -Raw
  foreach ($RequiredText in @(
    '("camera1", "192.168.101.100", "3G506401BE08818")',
    '("camera2", "192.168.102.100", "3G506501CA09165")',
    '("camera3", "192.168.103.100", "3G506401RE08993")',
    '("camera4", "192.168.104.100", "3G506401BE08819")',
    '("camera5", "192.168.105.13", "YF-0263")',
    '("camera6", "192.168.106.100", "3G506401RE08991")',
    'metadata_text(frame.metadata, "sn", "serial", "cameraSn")',
    'metadata_text(frame.metadata, "ip", "cameraIp")'
  )) {
    if ($BarSurfaceAlgorithmText -notmatch [regex]::Escape($RequiredText)) {
      throw "Packaged bar_surface_reconstruct.py must preserve current six-camera metadata/calibration mapping via $RequiredText"
    }
  }
}

function Test-PackagedClientStaticServer {
  $PackageDir = Join-Path $RepoRoot "target\packages\steel-inspection-runtime"
  $ClientScript = Join-Path $PackageDir "run-client-static.ps1"
  if (-not (Test-Path $ClientScript -PathType Leaf)) {
    throw "Missing packaged client static server script: $ClientScript"
  }

  $Port = Get-FreeLocalPort
  $LogDir = Join-Path $RepoRoot "target\logs\verify"
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $OutLog = Join-Path $LogDir "client-static.out.log"
  $ErrLog = Join-Path $LogDir "client-static.err.log"
  Remove-Item $OutLog, $ErrLog -ErrorAction SilentlyContinue
  Normalize-ProcessPathEnvironment
  $Process = Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $ClientScript,
    "-Port",
    [string]$Port
  ) -WorkingDirectory $PackageDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog

  try {
    $Ready = $false
    for ($i = 0; $i -lt 60; $i++) {
      if ($Process.HasExited) {
        break
      }
      Start-Sleep -Milliseconds 500
      try {
        $Response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2
        if ($Response.StatusCode -eq 200 -and $Response.Content -match "<html") {
          $Ready = $true
          break
        }
      } catch {
      }
    }

    if (-not $Ready) {
      $OutText = Get-Content $OutLog -Raw -ErrorAction SilentlyContinue
      $ErrText = Get-Content $ErrLog -Raw -ErrorAction SilentlyContinue
      throw "Packaged client static server did not serve index.html on port $Port. stdout: $OutText stderr: $ErrText"
    }
  } finally {
    if ($Process -and -not $Process.HasExited) {
      Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host "Checking client/runtime boundaries..."
Assert-NoMatches "NVT_LVM_SDK_ROOT|nvt_lvm_sdk|capture_sdk|rustc-link-lib" (Join-Path $ClientDir "src-tauri") "Tauri client must not link or copy the camera SDK."
Assert-NoMatches "dev:service|service:build|service:start|capture:configure|capture:build|capture:start" (Join-Path $ClientDir "package.json") "Client package scripts must not start services or build capture providers."
Assert-NoMatches "dev-with-service|scripts/cmake" $ClientDir "Client must not keep integrated backend/capture build scripts."
Assert-PathExists (Join-Path $RepoRoot "app\trigger\Cargo.toml") "Standalone trigger gateway project must live under app/trigger." "Leaf"
Assert-PathExists (Join-Path $RepoRoot "scripts\build-trigger-gateway.ps1") "Missing trigger gateway build script." "Leaf"
Assert-PathExists (Join-Path $RepoRoot "scripts\start-integrated-capture-management.ps1") "Missing source integrated capture-management startup script." "Leaf"
$MigrationArchitectureTest = Join-Path $RepoRoot "scripts\test-architecture-migration-contract.ps1"
Assert-PowerShellScriptParses $MigrationArchitectureTest
$MigrationArchitectureReportText = (& $MigrationArchitectureTest -RepoRoot ([string]$RepoRoot) | Out-String)
$MigrationArchitectureReport = $MigrationArchitectureReportText | ConvertFrom-Json
if ($MigrationArchitectureReport.code -ne 0) {
  throw "Source tree failed the architecture migration contract."
}
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\start-integrated-capture-management.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-integrated-capture-management-full.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-integrated-management-smoke.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-integrated-runtime-ready.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-runtime-acceptance.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-real-hardware-acceptance.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-real-calibration-acceptance.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-real-calibration-crash-recovery.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-real-calibration-integrity-generation.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-production-stability.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-bar-surface-e2e.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-runtime-layout.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-runtime-ui-smoke.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\run-service.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\run-trigger-gateway.ps1")

$TauriConfigPath = Join-Path $ClientDir "src-tauri\tauri.conf.json"
try {
  $TauriConfig = Get-Content $TauriConfigPath -Raw | ConvertFrom-Json
} catch {
  throw "Tauri config must be valid JSON: $TauriConfigPath"
}

if ($TauriConfig.build.beforeDevCommand -ne "npm run dev") {
  throw "Tauri beforeDevCommand must only start the frontend dev server."
}
if ($TauriConfig.build.beforeBuildCommand -ne "npm run build") {
  throw "Tauri beforeBuildCommand must only build the frontend."
}

if (-not $SkipClientTests) {
  Invoke-Checked "npm.cmd" @("test", "--", "--run") $ClientDir
}

if (-not $SkipFrontendBuild) {
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-client.ps1"))
}

if (-not $SkipServiceTests) {
  Invoke-Checked "cargo" @("test", "--manifest-path", (Join-Path $RepoRoot "app\service\Cargo.toml"))
}

if (-not $SkipTriggerTests) {
  Invoke-Checked "cargo" @("test", "--manifest-path", (Join-Path $RepoRoot "app\trigger\Cargo.toml"), "--target-dir", (Join-Path $RepoRoot "target\trigger-test"))
}

if (-not $SkipServiceBuild) {
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-service.ps1"))
}

if (-not $SkipTriggerBuild) {
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-trigger-gateway.ps1"))
}

if (-not $SkipCaptureBuild) {
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-capture-headless.ps1"))
}

if (-not $SkipExternalProviderCheck) {
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\verify-external-provider.ps1"))
}

if ($CheckQt) {
  $QtBuildArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-capture-qt.ps1"))
  if ($QtPrefixPath.Trim().Length -gt 0) {
    $QtBuildArgs += @("-QtPrefixPath", $QtPrefixPath)
  }
  Invoke-Checked "powershell" $QtBuildArgs
}

if (-not $SkipPackage) {
  $PackageArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\package-runtime.ps1"), "-SkipBuild")
  if ($CheckQt) {
    $PackageArgs += "-IncludeQt"
    if ($QtPrefixPath.Trim().Length -gt 0) {
      $PackageArgs += @("-QtPrefixPath", $QtPrefixPath)
    }
  }
  Invoke-Checked "powershell" $PackageArgs
  Test-PackagedRuntimeContract -ExpectQt:$CheckQt
  Test-PackagedClientStaticServer
}

Write-Host "Independent architecture verification passed."
