param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,
  [string]$OutputDirectory = ".\workflows\canonical",
  [switch]$KeepPinData,
  [switch]$AllowSuspiciousSecrets
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Exit-WithCode {
  param(
    [int]$Code,
    [string]$Message
  )
  if ($Code -eq 0) {
    Write-Host $Message
  } else {
    Write-Error $Message
  }
  exit $Code
}

function Remove-PropertyIfExists {
  param(
    [object]$Object,
    [string]$Name
  )
  if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) {
    $Object.PSObject.Properties.Remove($Name)
  }
}

function Get-NormalizedName {
  param([string]$Name)
  if ($null -eq $Name) {
    return ""
  }
  return ($Name -replace '[^A-Za-z0-9]', '').ToLowerInvariant()
}

function Test-SensitiveName {
  param([string]$Name)
  $normalized = Get-NormalizedName -Name $Name
  $sensitive = @(
    "authorization",
    "cookie",
    "xapikey",
    "apikey",
    "accesstoken",
    "refreshtoken",
    "clientsecret",
    "clientsecret",
    "password",
    "token",
    "secret",
    "sessiontoken"
  )
  return $sensitive -contains $normalized
}

function Scrub-Object {
  param([object]$Value)

  if ($null -eq $Value) {
    return
  }

  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string] -and $Value -isnot [pscustomobject]) {
    foreach ($item in $Value) {
      Scrub-Object -Value $item
    }
    return
  }

  if ($Value -is [pscustomobject]) {
    $nameLikeProperty = @("name", "key", "headerName") | Where-Object {
      $null -ne $Value.PSObject.Properties[$_]
    } | Select-Object -First 1
    if ($nameLikeProperty) {
      $nameLikeValue = [string]$Value.PSObject.Properties[$nameLikeProperty].Value
      if ((Test-SensitiveName -Name $nameLikeValue) -and $null -ne $Value.PSObject.Properties["value"]) {
        $Value.PSObject.Properties["value"].Value = "__SCRUBBED__"
      }
    }

    foreach ($property in @($Value.PSObject.Properties)) {
      if (Test-SensitiveName -Name $property.Name) {
        $property.Value = "__SCRUBBED__"
      } elseif ($property.Name -match '^(credentials|usedCredentials)$') {
        $Value.PSObject.Properties.Remove($property.Name)
      } else {
        Scrub-Object -Value $property.Value
      }
    }
  }
}

function Test-SuspiciousSecret {
  param([string]$Raw)

  $patterns = @(
    'sk-[A-Za-z0-9_\-]{20,}',
    'Bearer\s+[A-Za-z0-9_\.\-/+=]{20,}',
    '(?i)"(authorization|cookie|x-api-key|apiKey|accessToken|refreshToken|clientSecret|client_secret|password|token|secret|sessionToken)"\s*:\s*"(?!__SCRUBBED__")',
    '[A-Za-z]:\\Users\\',
    '"\s*:\s*"/(Users|home|etc|var|tmp)/'
  )

  foreach ($pattern in $patterns) {
    if ($Raw -match $pattern) {
      return $pattern
    }
  }

  return $null
}

if (-not (Test-Path -LiteralPath $InputPath)) {
  Exit-WithCode -Code 2 -Message "Input path does not exist: $InputPath"
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$resolved = Resolve-Path -LiteralPath $InputPath
$item = Get-Item -LiteralPath $resolved
$files = @(
  if ($item.PSIsContainer) {
    Get-ChildItem -LiteralPath $resolved -Filter *.json -File
  } else {
    $item
  }
)

if ($files.Count -eq 0) {
  Exit-WithCode -Code 2 -Message "No JSON files found at $InputPath"
}

$failed = $false

foreach ($file in $files) {
  try {
    $workflow = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json -Depth 100

    foreach ($name in @("id", "versionId", "shared", "usedCredentials", "staticData", "versionMetadata", "ownedBy", "homeProject")) {
      Remove-PropertyIfExists -Object $workflow -Name $name
    }

    if (-not $KeepPinData) {
      Remove-PropertyIfExists -Object $workflow -Name "pinData"
    }

    if ($workflow.PSObject.Properties["nodes"]) {
      foreach ($node in $workflow.nodes) {
        Remove-PropertyIfExists -Object $node -Name "credentials"
        Scrub-Object -Value $node.parameters
      }
    }

    Scrub-Object -Value $workflow

    $json = $workflow | ConvertTo-Json -Depth 100
    $matchedPattern = Test-SuspiciousSecret -Raw $json
    if ($matchedPattern -and -not $AllowSuspiciousSecrets) {
      Write-Error "$($file.FullName): suspicious secret pattern remains after scrub: $matchedPattern"
      $failed = $true
      continue
    }

    $outputName = $file.BaseName + ".canonical.json"
    $outputPath = Join-Path $OutputDirectory $outputName
    $json | Set-Content -LiteralPath $outputPath -Encoding utf8
    Write-Host "Scrubbed $($file.Name) -> $outputPath"
  } catch {
    Write-Error "$($file.FullName): scrub failed. $($_.Exception.Message)"
    $failed = $true
  }
}

if ($failed) {
  exit 6
}

exit 0
