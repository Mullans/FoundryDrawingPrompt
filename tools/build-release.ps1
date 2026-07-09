param(
    [string] $OutDir = "dist"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-ModuleRoot {
    return (Resolve-Path -LiteralPath (Join-Path -Path $PSScriptRoot -ChildPath "..")).Path
}

function New-CleanDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }

    New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Copy-ReleaseContent {
    param(
        [Parameter(Mandatory = $true)]
        [string] $ModuleRoot,

        [Parameter(Mandatory = $true)]
        [string] $StageRoot
    )

    $requiredItems = @(
        "module.json",
        "scripts",
        "styles",
        "templates",
        "lang",
        "README.md"
    )

    foreach ($item in $requiredItems) {
        $source = Join-Path -Path $ModuleRoot -ChildPath $item
        if (-not (Test-Path -LiteralPath $source)) {
            throw "Required release item not found: $item"
        }

        Copy-Item -LiteralPath $source -Destination $StageRoot -Recurse
    }

    $licensePath = Join-Path -Path $ModuleRoot -ChildPath "LICENSE"
    if (Test-Path -LiteralPath $licensePath) {
        Copy-Item -LiteralPath $licensePath -Destination $StageRoot
    }

    Get-ChildItem -LiteralPath $StageRoot -Recurse -Force -File -Filter ".gitkeep" | Remove-Item -Force
}

function New-ReleaseArchive {
    param(
        [Parameter(Mandatory = $true)]
        [string] $StageRoot,

        [Parameter(Mandatory = $true)]
        [string] $ZipPath
    )

    if (Test-Path -LiteralPath $ZipPath) {
        Remove-Item -LiteralPath $ZipPath -Force
    }

    $archiveInput = Join-Path -Path $StageRoot -ChildPath "*"
    Compress-Archive -Path $archiveInput -DestinationPath $ZipPath -CompressionLevel Optimal
}

$moduleRoot = Resolve-ModuleRoot
$resolvedOutDir = if ([System.IO.Path]::IsPathRooted($OutDir)) {
    $OutDir
}
else {
    Join-Path -Path $moduleRoot -ChildPath $OutDir
}

New-Item -ItemType Directory -Path $resolvedOutDir -Force | Out-Null

$stageRoot = Join-Path -Path $resolvedOutDir -ChildPath "_release-stage"
$zipPath = Join-Path -Path $resolvedOutDir -ChildPath "module.zip"

try {
    New-CleanDirectory -Path $stageRoot
    Copy-ReleaseContent -ModuleRoot $moduleRoot -StageRoot $stageRoot
    New-ReleaseArchive -StageRoot $stageRoot -ZipPath $zipPath
    Write-Output $zipPath
}
finally {
    if (Test-Path -LiteralPath $stageRoot) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}
