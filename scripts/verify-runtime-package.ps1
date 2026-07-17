param(
  [Parameter(Mandatory = $true)]
  [string]$PackageDir,
  [switch]$Engineering,
  [string]$ExpectedFirstPartyThumbprint = "",
  [string[]]$AllowedVendorSdkSignerThumbprints = @(),
  [string]$ExpectedPublisher = "",
  [string]$ExpectedReleasePolicySha256 = "",
  [string]$ExpectedBundleToolchainManifestSha256 = "",
  [string]$ExpectedExternalComponentsSha256 = "",
  [switch]$AllowPackageCodeExecution,
  [switch]$SkipClientSmoke
)

$ErrorActionPreference = "Stop"
$Verifier = Join-Path $PSScriptRoot "verify-independent-architecture.ps1"
$Arguments = @{
  ExistingPackageDir = $PackageDir
  PackageOnly = $true
  RequireFormalPackage = -not [bool]$Engineering
  ExpectedFirstPartyThumbprint = $ExpectedFirstPartyThumbprint
  AllowedVendorSdkSignerThumbprints = $AllowedVendorSdkSignerThumbprints
  ExpectedPublisher = $ExpectedPublisher
  ExpectedReleasePolicySha256 = $ExpectedReleasePolicySha256
  ExpectedBundleToolchainManifestSha256 = $ExpectedBundleToolchainManifestSha256
  ExpectedExternalComponentsSha256 = $ExpectedExternalComponentsSha256
  AllowPackageCodeExecution = [bool]$AllowPackageCodeExecution
  SkipPackagedClientSmoke = [bool]$SkipClientSmoke
}

& $Verifier @Arguments
