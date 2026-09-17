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
REM
REM Everything after setlocal sits in one parenthesised block on purpose. cmd
REM reads a batch file a line at a time while it runs, and the script below
REM updates the code - this file included. A file replaced underneath a running
REM batch carries on from the same byte offset in the new text, which in a test
REM ran half a line as a command. A block is read whole before any of it runs.

setlocal
(
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
)
