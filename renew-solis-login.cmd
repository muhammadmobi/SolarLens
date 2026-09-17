@echo off
REM Double-click this when the dashboard says a SolisCloud login needs renewing.
REM
REM A SolisCloud login lasts seven days and cannot renew itself, so once a week
REM someone logs in again. This stops the hidden relay, updates the code, opens
REM a Chrome window for the login, sends a reading, and restarts the relay.
REM
REM The -ExecutionPolicy Bypass is scoped to this one invocation; it does not
REM change any machine setting.

setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\renew-solis-login.ps1"
echo.
pause
