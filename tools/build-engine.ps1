<#
.SYNOPSIS
    Builds the native libsin_dsp shared library (engine/bin/sin_dsp.dll) and C++ tests on Windows using MSVC + CMake + Ninja.
#>
[CmdletBinding()]
param(
    [switch]$RunTests
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$EngineDir   = Join-Path $ProjectRoot "engine"
$BuildDir    = Join-Path $EngineDir "build\release"

# Locate Visual Studio vcvars64.bat via vswhere
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) {
    throw "Visual Studio Installer (vswhere.exe) not found. Install Visual Studio C++ Build Tools."
}
$vsInstall = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ([string]::IsNullOrWhiteSpace($vsInstall)) {
    throw "MSVC x64 C++ Build Tools not found via vswhere."
}
$vcvars = Join-Path $vsInstall "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path -LiteralPath $vcvars)) {
    throw "vcvars64.bat not found at $vcvars"
}

$cmake = (Get-Command cmake -ErrorAction SilentlyContinue).Source
if (-not $cmake) { throw "cmake not found on PATH." }
$ninja = (Get-Command ninja -ErrorAction SilentlyContinue).Source

$generatorArgs = if ($ninja) { '-G Ninja' } else { '-G "Visual Studio 17 2022" -A x64' }
$testCmd = if ($RunTests) { " && ctest --test-dir `"$BuildDir`" --output-on-failure" } else { "" }

$cmdLine = "call `"$vcvars`" >nul && `"$cmake`" -S `"$EngineDir`" -B `"$BuildDir`" $generatorArgs -DCMAKE_BUILD_TYPE=Release && `"$cmake`" --build `"$BuildDir`" --config Release$testCmd"

Write-Host "Building native sin_dsp.dll..."
& cmd.exe /c $cmdLine
if ($LASTEXITCODE -ne 0) {
    throw "Native sin_dsp build failed with exit code $LASTEXITCODE."
}
Write-Host "Built: $(Join-Path $EngineDir 'bin\sin_dsp.dll')"
