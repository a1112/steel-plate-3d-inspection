function Import-EnvFile {
  param(
    [string]$Path
  )

  if (-not $Path -or $Path.Trim().Length -eq 0) {
    return
  }

  $Resolved = Resolve-Path $Path -ErrorAction Stop
  foreach ($Line in Get-Content $Resolved) {
    $Trimmed = $Line.Trim()
    if ($Trimmed.Length -eq 0 -or $Trimmed.StartsWith("#")) {
      continue
    }

    $Index = $Trimmed.IndexOf("=")
    if ($Index -le 0) {
      continue
    }

    $Name = $Trimmed.Substring(0, $Index).Trim()
    $Value = $Trimmed.Substring($Index + 1).Trim()
    if (($Value.StartsWith('"') -and $Value.EndsWith('"')) -or ($Value.StartsWith("'") -and $Value.EndsWith("'"))) {
      $Value = $Value.Substring(1, $Value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
  }
}
