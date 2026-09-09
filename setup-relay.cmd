@echo off
REM Double-click this to set up the SolisCloud relay on a Windows machine.
REM
REM It only launches the PowerShell script beside it, which does the work:
REM installs what is missing, fetches the code, asks for the ingest token,
REM walks you through one SolisCloud login, and registers the relay to start
REM itself at every logon.
REM
REM The -ExecutionPolicy Bypass is scoped to this one invocation; it does not
REM change any machine setting.

setlocal
set "HERE=%~dp0"

if exist "%HERE%scripts\setup-relay.ps1" (
  REM Running from inside a checkout.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%scripts\setup-relay.ps1" %*
) else (
  REM Copied somewhere on its own: fetch the script straight from the repo.
  echo Fetching the setup script from GitHub...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$u='https://raw.githubusercontent.com/muhammadmobi/SolarLens/main/scripts/setup-relay.ps1';" ^
    "$f=Join-Path $env:TEMP 'solarlens-setup-relay.ps1';" ^
    "try { Invoke-WebRequest -Uri $u -OutFile $f -UseBasicParsing } catch { Write-Host 'Could not download the setup script. Check your internet connection.' -ForegroundColor Red; exit 1 };" ^
    "& $f %*"
)

echo.
pause
