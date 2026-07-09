param([string]$FoundryDataPath = "$env:LOCALAPPDATA\FoundryVTT")

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $repoRoot "module.json"
$moduleId = (Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json).id

if ([string]::IsNullOrWhiteSpace($moduleId)) {
    throw "module.json does not contain a valid module id."
}

$modulesPath = Join-Path $FoundryDataPath "Data\modules"
if (-not (Test-Path -LiteralPath $modulesPath -PathType Container)) {
    throw "Foundry modules directory not found at '$modulesPath'. Pass -FoundryDataPath pointing at your Foundry user data folder."
}

$target = Join-Path $modulesPath $moduleId
if (Test-Path -LiteralPath $target) {
    $item = Get-Item -LiteralPath $target -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
        throw "Target already exists and is not a junction: '$target'"
    }

    Remove-Item -LiteralPath $target -Force
}

New-Item -ItemType Junction -Path $target -Value $repoRoot | Out-Null
Write-Output "Created junction: $target"
