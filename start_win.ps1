<#
.SYNOPSIS
    Single Windows entry point for SIN (:8000) and GAIA (:8001).

.DESCRIPTION
    Ensures the native C++ audio engine (engine/bin/sin_dsp.dll) is built, builds the
    SIN frontend into static/, starts SIN (:8000) and GAIA (:8001) using the project
    .venv, waits for health checks, and opens both in the default browser.
    Press Ctrl+C to stop both services cleanly.
#>

[CmdletBinding()]
param(
    [switch]$Reload,
    [switch]$NoBrowser,
    [switch]$RebuildEngine,
    [switch]$Stop
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
    throw "start_win.ps1 is for Windows. Use ./start_mac.sh on macOS/Linux."
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

    & $candidate -c "import fastapi, uvicorn, websockets, librosa, soundfile, pyrubberband, mutagen, sqlalchemy" 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "The project .venv is missing backend requirements. Run: .\.venv\Scripts\python.exe -m pip install -r requirements.txt"
    }

    return (Resolve-Path -LiteralPath $candidate).Path
}

function Resolve-Npm {
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npmCommand) {
        $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
    }
    if ($null -eq $npmCommand) {
        throw "npm is required to start the SIN frontend."
    }
    return $npmCommand.Source
}

function Normalize-ProcessPath {
    $entries = @(
        [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process).GetEnumerator() |
            Where-Object { [string]::Equals([string]$_.Key, "Path", [StringComparison]::OrdinalIgnoreCase) }
    )
    if ($entries.Count -le 1) { return }

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

function Ensure-NativeAudioEngine {
    $dllPath = Join-Path $ProjectRoot "engine\bin\sin_dsp.dll"
    $buildScript = Join-Path $ProjectRoot "tools\build-engine.ps1"
    $needsBuild = $RebuildEngine -or (-not (Test-Path -LiteralPath $dllPath -PathType Leaf))

    if (-not $needsBuild -and (Test-Path -LiteralPath $dllPath)) {
        $dllTime = (Get-Item -LiteralPath $dllPath).LastWriteTimeUtc
        $srcFiles = Get-ChildItem -Path (Join-Path $ProjectRoot "engine\include"), (Join-Path $ProjectRoot "engine\src") -File -ErrorAction SilentlyContinue
        foreach ($f in $srcFiles) {
            if ($f.LastWriteTimeUtc -gt $dllTime) {
                $needsBuild = $true
                break
            }
        }
    }

    if ($needsBuild -and (Test-Path -LiteralPath $buildScript -PathType Leaf)) {
        Write-Host "Building native real-time C++ audio engine (sin_dsp.dll)..."
        try {
            & $buildScript
        } catch {
            Write-Warning "Native sin_dsp.dll build failed ($($_.Exception.Message)). Falling back to offline Python previews."
        }
    }
}

function Test-TcpPort {
    param([Parameter(Mandatory = $true)][int]$Port)
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $pending = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(250)) { return $false }
        $client.EndConnect($pending)
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Stop-StaleSinGaiaOnPort {
    param([Parameter(Mandatory = $true)][int]$Port)

    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) { return }

    $pids = @($conns | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($procId in $pids) {
        $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
        $cmd = [string]($procInfo.CommandLine)
        $isSinOrGaia = ($cmd -match "run\.py" -or $cmd -match "gaia\.main:app" -or $cmd -match "uvicorn")
        if ($isSinOrGaia) {
            Write-Host "Stopping previous SIN/GAIA process on port $Port (PID $procId)..."
            Stop-ProcessTree -ProcessId $procId
        } else {
            throw "Port $Port is in use by another application (PID $procId, '$($procInfo.Name)'). Close it first."
        }
    }

    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Test-TcpPort -Port $Port)) { return }
        Start-Sleep -Milliseconds 150
    }
    throw "Port $Port did not release after stopping previous SIN/GAIA process."
}

function Assert-PortAvailable {
    param([Parameter(Mandatory = $true)][int]$Port)
    if (Test-TcpPort -Port $Port) {
        Stop-StaleSinGaiaOnPort -Port $Port
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
    param([Parameter(Mandatory = $true)][int]$ProcessId)
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
            if ($null -ne $service) { Show-ServiceLogs -Service $service }
            throw "$Name exited before becoming ready."
        }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri $Url
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { return }
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

    if ($Stop) {
        Stop-StaleSinGaiaOnPort -Port 8000
        Stop-StaleSinGaiaOnPort -Port 8001
        Write-Host "Stopped any running SIN (:8000) and GAIA (:8001) servers."
        exit 0
    }

    $python = Resolve-ProjectPython
    $npm = Resolve-Npm

    $pythonVersion = ((& $python --version 2>&1) -join " ").Trim()
    Write-Host "Python environment: $VenvRoot ($pythonVersion)"

    Assert-PortAvailable -Port 8000
    Assert-PortAvailable -Port 8001

    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "editor\node_modules"))) {
        throw "SIN frontend dependencies are missing. Run: npm --prefix editor install"
    }

    Ensure-NativeAudioEngine
    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null

    Write-Host "Building SIN for http://127.0.0.1:8000..."
    & $npm --silent --prefix editor run build -- --logLevel error
    if ($LASTEXITCODE -ne 0) {
        throw "SIN frontend build failed."
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

    $sinProcess = Start-ManagedProcess -Name "SIN on http://127.0.0.1:8000" -FilePath $python -ArgumentList $mainApiArguments -LogName "sin"
    $gaiaProcess = Start-ManagedProcess -Name "GAIA Library on http://127.0.0.1:8001" -FilePath $python -ArgumentList $gaiaArguments -LogName "gaia"

    if ($Reload) {
        Start-ManagedProcess -Name "SIN frontend build watcher" -FilePath $npm -ArgumentList @("--silent", "--prefix", "editor", "run", "build:watch", "--", "--logLevel", "error") -LogName "sin-build" | Out-Null
    }

    Wait-ForService -Name "SIN" -Url "http://127.0.0.1:8000/api/health" -Process $sinProcess
    Wait-ForService -Name "GAIA" -Url "http://127.0.0.1:8001/" -Process $gaiaProcess

    Write-Host ""
    Write-Host "SIN and GAIA are ready."
    Write-Host "Hot reload:   $Reload"
    Write-Host "SIN + API:    http://127.0.0.1:8000"
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
        Write-Host "Stopping SIN and GAIA..."
        foreach ($started in $StartedProcesses) {
            Stop-ProcessTree -ProcessId $started.Process.Id
        }
    }
    if ($null -eq $PreviousVirtualEnv) { Remove-Item Env:VIRTUAL_ENV -ErrorAction SilentlyContinue } else { $env:VIRTUAL_ENV = $PreviousVirtualEnv }
    if ($null -eq $PreviousPythonNoUserSite) { Remove-Item Env:PYTHONNOUSERSITE -ErrorAction SilentlyContinue } else { $env:PYTHONNOUSERSITE = $PreviousPythonNoUserSite }
    if ($null -eq $PreviousPythonHome) { Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue } else { $env:PYTHONHOME = $PreviousPythonHome }
}

exit $LauncherExitCode
