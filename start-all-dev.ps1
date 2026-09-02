<#
.SYNOPSIS
    Starts IRIDE and GAIA using the project virtual environment.

.DESCRIPTION
    IRIDE is compiled into static/ and served by its API on port 8000. GAIA is
    served on port 8001. Stable mode is the default. Pass -Reload explicitly to
    enable Uvicorn reloaders and the IRIDE build watcher.

    Child services run hidden and write logs under .runtime/. The launcher opens
    both browser pages after their health checks pass and owns every child process
    so Ctrl+C stops the complete stack.
#>

[CmdletBinding()]
param(
    [switch]$Reload,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$VenvRoot = Join-Path $ProjectRoot ".venv"
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$StartedProcesses = @()
$LauncherExitCode = 0
$PreviousVirtualEnv = $env:VIRTUAL_ENV
$PreviousPythonNoUserSite = $env:PYTHONNOUSERSITE
$PreviousPythonHome = $env:PYTHONHOME

if (-not $IsWindows -and $env:OS -ne "Windows_NT") {
    throw "start-all-dev.ps1 is intended for Windows. Use start-all.sh on Linux/macOS."
}

function Resolve-ProjectPython {
    $candidate = Join-Path $VenvRoot "Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "The project virtual environment is missing: $candidate"
    }

    $actualPrefix = & $candidate -c "import pathlib, sys; print(pathlib.Path(sys.prefix).resolve())" 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($actualPrefix)) {
        throw "The project .venv Python launcher is stale or cannot run. Recreate .venv before launching."
    }

    $resolvedPrefix = (Resolve-Path -LiteralPath $actualPrefix.Trim()).Path
    if (-not [string]::Equals($resolvedPrefix, $VenvRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing Python outside the project .venv. Expected '$VenvRoot', got '$resolvedPrefix'."
    }

    & $candidate -c "import fastapi, uvicorn, librosa, soundfile, pyrubberband, mutagen, sqlalchemy" 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "The project .venv is missing backend requirements. Install requirements.txt into .venv."
    }

    return (Resolve-Path -LiteralPath $candidate).Path
}

function Resolve-Npm {
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npmCommand) {
        $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
    }

    if ($null -eq $npmCommand) {
        throw "npm is required to start the IRIDE frontend."
    }

    return $npmCommand.Source
}

function Normalize-ProcessPath {
    # Some Windows shells hand PowerShell both `Path` and `PATH`. PowerShell's
    # Start-Process treats those as duplicate keys and refuses to launch a child.
    $entries = @(
        [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process).GetEnumerator() |
            Where-Object { [string]::Equals([string]$_.Key, "Path", [StringComparison]::OrdinalIgnoreCase) }
    )
    if ($entries.Count -le 1) {
        return
    }

    $segments = @(
        $entries |
            ForEach-Object { [string]$_.Value -split ";" } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Select-Object -Unique
    )
    foreach ($entry in $entries) {
        [Environment]::SetEnvironmentVariable([string]$entry.Key, $null, [EnvironmentVariableTarget]::Process)
    }
    [Environment]::SetEnvironmentVariable("Path", ($segments -join ";"), [EnvironmentVariableTarget]::Process)
}

function Test-TcpPort {
    param([Parameter(Mandatory = $true)][int]$Port)

    $client = [Net.Sockets.TcpClient]::new()
    try {
        $pending = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(250)) {
            return $false
        }
        $client.EndConnect($pending)
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Assert-PortAvailable {
    param([Parameter(Mandatory = $true)][int]$Port)

    if (Test-TcpPort -Port $Port) {
        throw "Port $Port is already in use. Close the existing IRIDE/GAIA launcher before starting another copy."
    }
}

function Start-ManagedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$LogName
    )

    $stdoutPath = Join-Path $RuntimeRoot "$LogName.log"
    $stderrPath = Join-Path $RuntimeRoot "$LogName.error.log"
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue

    Write-Host "Starting $Name..."
    $process = Start-Process `
        -FilePath $FilePath `
        -ArgumentList $ArgumentList `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru

    $script:StartedProcesses += [pscustomobject]@{
        Name = $Name
        Process = $process
        Stdout = $stdoutPath
        Stderr = $stderrPath
    }

    return $process
}

function Stop-ProcessTree {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId
    )

    if ($null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
        & taskkill.exe /PID $ProcessId /T /F 1>$null 2>$null
    }
}

function Show-ServiceLogs {
    param([Parameter(Mandatory = $true)]$Service)

    foreach ($path in @($Service.Stdout, $Service.Stderr)) {
        if (Test-Path -LiteralPath $path) {
            Write-Host ""
            Write-Host "--- $path ---"
            Get-Content -LiteralPath $path -Tail 30
        }
    }
}

function Wait-ForService {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)]$Process
    )

    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        if ($Process.HasExited) {
            $service = $StartedProcesses | Where-Object { $_.Process.Id -eq $Process.Id } | Select-Object -First 1
            if ($null -ne $service) {
                Show-ServiceLogs -Service $service
            }
            throw "$Name exited before becoming ready."
        }

        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri $Url
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
                return
            }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }

    throw "$Name did not become ready within 30 seconds. See logs in $RuntimeRoot."
}

try {
    Normalize-ProcessPath
    $env:VIRTUAL_ENV = $VenvRoot
    $env:PYTHONNOUSERSITE = "1"
    Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue

    $python = Resolve-ProjectPython
    $npm = Resolve-Npm

    $pythonVersion = ((& $python --version 2>&1) -join " ").Trim()
    Write-Host "Python environment: $VenvRoot ($pythonVersion)"

    Assert-PortAvailable -Port 8000
    Assert-PortAvailable -Port 8001

    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "iride\node_modules"))) {
        throw "IRIDE frontend dependencies are missing. Run: npm --prefix iride install"
    }

    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null

    Write-Host "Building IRIDE for http://127.0.0.1:8000..."
    & $npm --silent --prefix iride run build -- --logLevel error
    if ($LASTEXITCODE -ne 0) {
        throw "IRIDE frontend build failed."
    }

    $mainApiArguments = @("run.py", "--no-reload", "--log-level", "info")
    $gaiaArguments = @(
        "-m", "uvicorn", "gaia.main:app",
        "--host", "127.0.0.1",
        "--port", "8001",
        "--log-level", "info"
    )

    if ($Reload) {
        $mainApiArguments = @("run.py", "--log-level", "info")
        $gaiaArguments += "--reload"
    }

    $irideProcess = Start-ManagedProcess `
        -Name "IRIDE on http://127.0.0.1:8000" `
        -FilePath $python `
        -ArgumentList $mainApiArguments `
        -LogName "iride"

    $gaiaProcess = Start-ManagedProcess `
        -Name "GAIA Library on http://127.0.0.1:8001" `
        -FilePath $python `
        -ArgumentList $gaiaArguments `
        -LogName "gaia"

    if ($Reload) {
        Start-ManagedProcess `
            -Name "IRIDE frontend build watcher" `
            -FilePath $npm `
            -ArgumentList @("--silent", "--prefix", "iride", "run", "build:watch", "--", "--logLevel", "error") `
            -LogName "iride-build" | Out-Null
    }

    Wait-ForService -Name "IRIDE" -Url "http://127.0.0.1:8000/api/health" -Process $irideProcess
    Wait-ForService -Name "GAIA" -Url "http://127.0.0.1:8001/" -Process $gaiaProcess

    Write-Host ""
    Write-Host "IRIDE and GAIA are ready."
    Write-Host "Hot reload: $Reload"
    Write-Host "IRIDE + API:  http://127.0.0.1:8000"
    Write-Host "GAIA Manager: http://127.0.0.1:8001"
    Write-Host "Logs:         $RuntimeRoot"
    Write-Host "Press Ctrl+C to stop both services."
    Write-Host ""

    if (-not $NoBrowser) {
        Start-Process "http://127.0.0.1:8000"
        Start-Process "http://127.0.0.1:8001"
    }

    while ($true) {
        foreach ($service in $StartedProcesses) {
            if ($service.Process.HasExited) {
                Show-ServiceLogs -Service $service
                throw "$($service.Name) stopped unexpectedly."
            }
        }

        Start-Sleep -Seconds 1
    }
} catch {
    $LauncherExitCode = 1
    Write-Host ""
    Write-Host "Launcher error: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    if ($StartedProcesses.Count -gt 0) {
        Write-Host ""
        Write-Host "Stopping IRIDE and GAIA..."
        foreach ($started in $StartedProcesses) {
            Stop-ProcessTree -ProcessId $started.Process.Id
        }
    }

    if ($null -eq $PreviousVirtualEnv) { Remove-Item Env:VIRTUAL_ENV -ErrorAction SilentlyContinue } else { $env:VIRTUAL_ENV = $PreviousVirtualEnv }
    if ($null -eq $PreviousPythonNoUserSite) { Remove-Item Env:PYTHONNOUSERSITE -ErrorAction SilentlyContinue } else { $env:PYTHONNOUSERSITE = $PreviousPythonNoUserSite }
    if ($null -eq $PreviousPythonHome) { Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue } else { $env:PYTHONHOME = $PreviousPythonHome }
}

exit $LauncherExitCode
