@echo off
setlocal
cd /d "%~dp0"
title IRIDE + GAIA

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all-dev.ps1" %*
set "launcher_exit=%ERRORLEVEL%"

if not "%launcher_exit%"=="0" (
  echo.
  echo IRIDE + GAIA did not start cleanly. Review the message above and .runtime logs.
  pause
)

endlocal & exit /b %launcher_exit%
