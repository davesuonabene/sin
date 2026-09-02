<#
.SYNOPSIS
Downloads the official Rubber Band 4.0 Windows CLI into this checkout's .venv.

.DESCRIPTION
The Python package in requirements.txt supplies the bridge; Rubber Band itself
is a native GPL tool. Keeping it below .venv/tools prevents a global PATH or
machine-level dependency. Use SIN_RUBBERBAND_EXECUTABLE to override it.
#>

[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$TargetRoot = Join-Path $ProjectRoot ".venv\tools\rubberband"
$TargetExecutable = Join-Path $TargetRoot "rubberband.exe"
$ReleaseUrl = "https://breakfastquay.com/files/releases/rubberband-4.0.0-gpl-executable-windows.zip"

if ((Test-Path -LiteralPath $TargetExecutable -PathType Leaf) -and -not $Force) {
    & $TargetExecutable --version
    Write-Host "Rubber Band is already installed at $TargetExecutable"
    exit 0
}

$TemporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("sin-rubberband-" + [guid]::NewGuid().ToString("N"))
$ArchivePath = Join-Path $TemporaryRoot "rubberband-4.0.0.zip"
try {
    New-Item -ItemType Directory -Path $TemporaryRoot | Out-Null
    Invoke-WebRequest -Uri $ReleaseUrl -OutFile $ArchivePath
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $TemporaryRoot
    $Executable = Get-ChildItem -LiteralPath $TemporaryRoot -Recurse -Filter "rubberband.exe" | Select-Object -First 1
    if ($null -eq $Executable) {
        throw "The official Rubber Band archive did not contain rubberband.exe."
    }

    if (Test-Path -LiteralPath $TargetRoot) {
        Remove-Item -LiteralPath $TargetRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $Executable.DirectoryName -Force |
        Copy-Item -Destination $TargetRoot -Recurse -Force
    & (Join-Path $TargetRoot "rubberband.exe") --version
} finally {
    if (Test-Path -LiteralPath $TemporaryRoot) {
        Remove-Item -LiteralPath $TemporaryRoot -Recurse -Force
    }
}
