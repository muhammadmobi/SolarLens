@echo off
REM Double-click this when the dashboard says a SolisCloud login needs renewing.
REM
REM A SolisCloud login lasts seven days and cannot renew itself, so once a week
REM someone logs in again. This stops the hidden relay, updates the code, checks
REM the saved login in the background, opens a Chrome window only if a login is
REM needed, sends a reading, and restarts the relay.
REM
REM The window closes by itself when everything worked. It stays open when
REM something did not, so the message saying why can still be read.
REM
REM The -ExecutionPolicy Bypass is scoped to this one invocation; it does not
REM change any machine setting.

setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\renew-solis-login.ps1"
if errorlevel 1 (
  echo.
  echo  Something did not work - the message above says what.
  pause
  exit /b 1
)
echo.
echo  Closing in 5 seconds.
"%SystemRoot%\System32\timeout.exe" /t 5 >nul
exit /b 0
