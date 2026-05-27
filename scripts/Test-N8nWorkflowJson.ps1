param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Add-Failure {
  param(
    [System.Collections.Generic.List[string]]$Failures,
    [string]$Message
  )
  $Failures.Add($Message) | Out-Null
}

function Get-ConnectionTargets {
  param([object]$Value)

  $targets = New-Object System.Collections.Generic.List[string]

  function Visit {
    param([object]$Node)
    if ($null -eq $Node) {
      return
    }
    if ($Node -is [System.Collections.IEnumerable] -and $Node -isnot [string] -and $Node -isnot [pscustomobject]) {
      foreach ($item in $Node) {
        Visit -Node $item
      }
      return
    }
    if ($Node -is [pscustomobject]) {
      if ($null -ne $Node.PSObject.Properties["node"] -and -not [string]::IsNullOrWhiteSpace([string]$Node.node)) {
        $targets.Add([string]$Node.node) | Out-Null
      }
      foreach ($property in @($Node.PSObject.Properties)) {
        Visit -Node $property.Value
      }
    }
  }

  Visit -Node $Value
  return $targets
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
    "password",
    "token",
    "secret",
    "sessiontoken"
  )
  return $sensitive -contains $normalized
}

function Test-ValueIsScrubbedOrEmpty {
  param([object]$Value)
  if ($null -eq $Value) {
    return $true
  }
  if ($Value -is [string]) {
    return [string]::IsNullOrWhiteSpace($Value) -or $Value -eq "__SCRUBBED__"
  }
  return $false
}

function Test-StructuredSecrets {
  param(
    [object]$Value,
    [string]$FileName,
    [System.Collections.Generic.List[string]]$Failures
  )

  if ($null -eq $Value) {
    return
  }

  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string] -and $Value -isnot [pscustomobject]) {
    foreach ($item in $Value) {
      Test-StructuredSecrets -Value $item -FileName $FileName -Failures $Failures
    }
    return
  }

  if ($Value -is [pscustomobject]) {
    foreach ($forbidden in @("credentials", "usedCredentials")) {
      if ($null -ne $Value.PSObject.Properties[$forbidden]) {
        Add-Failure -Failures $Failures -Message "${FileName}: contains forbidden property '$forbidden'"
      }
    }

    $nameLikeProperty = @("name", "key", "headerName") | Where-Object {
      $null -ne $Value.PSObject.Properties[$_]
    } | Select-Object -First 1
    if ($nameLikeProperty) {
      $nameLikeValue = [string]$Value.PSObject.Properties[$nameLikeProperty].Value
      if ((Test-SensitiveName -Name $nameLikeValue) -and $null -ne $Value.PSObject.Properties["value"]) {
        if (-not (Test-ValueIsScrubbedOrEmpty -Value $Value.PSObject.Properties["value"].Value)) {
          Add-Failure -Failures $Failures -Message "${FileName}: sensitive '$nameLikeValue' value is not scrubbed"
        }
      }
    }

    foreach ($property in @($Value.PSObject.Properties)) {
      if ((Test-SensitiveName -Name $property.Name) -and -not (Test-ValueIsScrubbedOrEmpty -Value $property.Value)) {
        Add-Failure -Failures $Failures -Message "${FileName}: sensitive property '$($property.Name)' is not scrubbed"
      }
      Test-StructuredSecrets -Value $property.Value -FileName $FileName -Failures $Failures
    }
  }
}

if (-not (Test-Path -LiteralPath $Path)) {
  Write-Error "Path does not exist: $Path"
  exit 2
}

$resolved = Resolve-Path -LiteralPath $Path
$item = Get-Item -LiteralPath $resolved
$files = @(
  if ($item.PSIsContainer) {
    Get-ChildItem -LiteralPath $resolved -Filter *.json -File -Recurse
  } else {
    $item
  }
)

if ($files.Count -eq 0) {
  Write-Host "No workflow JSON files found."
  exit 0
}

$failures = New-Object System.Collections.Generic.List[string]
$secretPatterns = @(
  '"credentials"\s*:',
  '"usedCredentials"\s*:',
  'sk-[A-Za-z0-9_\-]{20,}',
  'Bearer\s+[A-Za-z0-9_\.\-/+=]{20,}',
  '(?i)"(authorization|cookie|x-api-key|apiKey|accessToken|refreshToken|clientSecret|client_secret|password|token|secret|sessionToken)"\s*:\s*"(?!__SCRUBBED__")',
  '[A-Za-z]:\\Users\\',
  '"\s*:\s*"/(Users|home|etc|var|tmp)/'
)

foreach ($file in $files) {
  $raw = Get-Content -LiteralPath $file.FullName -Raw
  try {
    $json = $raw | ConvertFrom-Json -Depth 100
  } catch {
    Add-Failure -Failures $failures -Message "$($file.FullName): invalid JSON"
    continue
  }

  if (-not $json.PSObject.Properties["name"] -or [string]::IsNullOrWhiteSpace([string]$json.name)) {
    Add-Failure -Failures $failures -Message "$($file.FullName): missing workflow name"
  }
  if (-not $json.PSObject.Properties["nodes"] -or $null -eq $json.nodes) {
    Add-Failure -Failures $failures -Message "$($file.FullName): missing nodes"
  }
  if (-not $json.PSObject.Properties["connections"] -or $null -eq $json.connections) {
    Add-Failure -Failures $failures -Message "$($file.FullName): missing connections"
  }

  if ($json.PSObject.Properties["nodes"] -and $json.nodes) {
    $nodeNames = @($json.nodes | ForEach-Object { [string]$_.name })
    $duplicates = $nodeNames | Group-Object | Where-Object { $_.Count -gt 1 }
    foreach ($duplicate in $duplicates) {
      Add-Failure -Failures $failures -Message "$($file.FullName): duplicate node name '$($duplicate.Name)'"
    }

    if ($json.PSObject.Properties["connections"] -and $json.connections) {
      foreach ($connectionProperty in @($json.connections.PSObject.Properties)) {
        $source = $connectionProperty.Name
        if ($nodeNames -notcontains $source) {
          Add-Failure -Failures $failures -Message "$($file.FullName): connection source '$source' does not match a node name"
        }
      }
      $targets = Get-ConnectionTargets -Value $json.connections
      foreach ($target in $targets) {
        if ($nodeNames -notcontains $target) {
          Add-Failure -Failures $failures -Message "$($file.FullName): connection target '$target' does not match a node name"
        }
      }
    }
  }

  Test-StructuredSecrets -Value $json -FileName $file.FullName -Failures $failures

  foreach ($pattern in $secretPatterns) {
    if ($raw -match $pattern) {
      Add-Failure -Failures $failures -Message "$($file.FullName): matched forbidden pattern '$pattern'"
    }
  }
}

if ($failures.Count -gt 0) {
  foreach ($failure in $failures) {
    Write-Error $failure
  }
  exit 1
}

Write-Host "Workflow JSON validation passed."
exit 0
