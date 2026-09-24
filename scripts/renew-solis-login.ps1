# Renew this computer's SolisCloud login for the relay, and restart the relay.
#
# A SolisCloud web login lasts exactly seven days, and using it does not extend
# it. The login page carries hCaptcha, so the relay cannot renew it by itself:
# once a week a person has to log in again. This makes that one double-click.
#
#   1. Stops the hidden relay, so its browser profile is free.
#   2. Updates the code, when it can do so without touching local changes.
#   3. Checks the saved login in the background, with no window. If it still
#      works, a reading is sent and nothing appears. Only if SolisCloud wants a
#      login does a Chrome window open, and it waits for you to log in.
#   4. Starts the hidden relay again - unless you had disabled it on purpose.
#
# Usually run through renew-solis-login.cmd, from the SolarLens folder.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Task = 'SolarLens relay'

# Output helpers: a numbered step, a success, a warning, and a stop with a reason.
function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "    OK  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    !!  $t" -ForegroundColor Yellow }
function Die($t)  { Write-Host "`nSTOPPED: $t" -ForegroundColor Red; exit 1 }

# Run the relay for one cycle and return its exit code: 0 a reading went
# through, 3 SolisCloud wants a login, anything else another failure. Hidden
# unless -Visible. Alarm history and period totals are skipped - they add most
# of a minute, and the background relay started afterwards reads them anyway.
# setup-relay.ps1 carries the same function.
function Invoke-RelayOnce([switch] $Visible) {
  $env:RELAY_ONCE = '1'
  $env:RELAY_SKIP_EXTRAS = '1'
  $env:RELAY_HEADLESS = $(if ($Visible) { '0' } else { '1' })
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & node agent\solis-relay.mjs | Out-Host
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
    foreach ($v in 'RELAY_ONCE', 'RELAY_SKIP_EXTRAS', 'RELAY_HEADLESS') { Remove-Item "Env:\$v" -ErrorAction SilentlyContinue }
  }
}

Write-Host 'SolarLens: renew the SolisCloud login' -ForegroundColor White
Write-Host '--------------------------------------'
Set-Location $Root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die 'Node.js is not installed here. Run setup-relay.cmd first, which installs everything.'
}
if (-not (Test-Path (Join-Path $Root 'agent\solis-relay.mjs'))) {
  Die "This does not look like the SolarLens folder: $Root"
}

# --- 1. free the browser profile --------------------------------------------
Step 1 'Stopping the hidden relay'
$taskInfo = Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
$wasDisabled = $taskInfo -and $taskInfo.State -eq 'Disabled'
if ($taskInfo) { Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue }
# Stop the task first, then its wrapper, then node, then the relay's own Chrome:
# a Chrome still holding the profile would stop the visible run from starting.
foreach ($p in @(
  @{ Name = 'wscript.exe'; Match = '*relay-hidden.vbs*' },
  @{ Name = 'node.exe';    Match = '*solis-relay*' }
)) {
  Get-CimInstance Win32_Process -Filter "Name='$($p.Name)'" |
    Where-Object { $_.CommandLine -like $p.Match } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 2
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*relay-profile*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Ok 'Stopped'

# --- 2. update the code -----------------------------------------------------
Step 2 'Updating the relay code'
if (Get-Command git -ErrorAction SilentlyContinue) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $dirty = (& git status --porcelain 2>$null) -join ''
  if ($dirty) {
    Warn 'There are local changes in this folder - leaving the code as it is'
  } else {
    & git pull --ff-only 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok 'Up to date' }
    else {
      & git fetch origin 2>&1 | Out-Null
      & git reset --hard origin/main 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { Ok 'Checkout could not fast-forward - reset to match the published code' }
      else { Warn 'Could not update the code - carrying on with what is here' }
    }
  }
  $ErrorActionPreference = $prev
} else {
  Warn 'git is not installed - carrying on with the code already here'
}

# --- 3. the login itself ----------------------------------------------------
Step 3 'Checking the SolisCloud login'
# Hidden first. Most of the time the saved login still works, and then there is
# nothing for anyone to see or do; a window opens only when a login is needed.
$profileDir = if ($env:RELAY_PROFILE) { $env:RELAY_PROFILE } else { Join-Path $Root '.relay-profile' }
$code = -1
if (Test-Path (Join-Path $profileDir 'Default')) {
  Write-Host '    Checking in the background - no window unless SolisCloud wants a login.'
  $code = Invoke-RelayOnce
  if ($code -eq 0) { Ok 'The saved login still works, and a reading went through' }
  elseif ($code -eq 3) { Warn 'The saved login has expired' }
  else { Warn "The background check did not get through (exit $code) - trying again in a window" }
}
if ($code -ne 0) {
  Write-Host ''
  Write-Host '    A Chrome window opens on SolisCloud. Log in there if it asks.'
  Write-Host '    It closes by itself once a reading has been sent.' -ForegroundColor Yellow
  Write-Host ''
  if ((Invoke-RelayOnce -Visible) -ne 0) {
    Die 'No reading was sent, so the login is not renewed yet. Run this again and complete the login in the Chrome window.'
  }
  Ok 'Logged in, and a reading went through'
}

# --- 4. back to running hidden ----------------------------------------------
Step 4 'Starting the hidden relay'
if (-not $taskInfo) {
  Warn "There is no '$Task' task on this computer. Run setup-relay.cmd to install one."
} elseif ($wasDisabled) {
  Warn "The '$Task' task is disabled on this computer, so it was left off."
  Write-Host "    To run it again: Enable-ScheduledTask -TaskName '$Task'; Start-ScheduledTask -TaskName '$Task'"
} else {
  Start-ScheduledTask -TaskName $Task
  $running = 0
  foreach ($i in 1..15) {
    Start-Sleep -Seconds 2
    $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like '*solis-relay*' }).Count
    if ($running -gt 0) { break }
  }
  if ($running -gt 0) { Ok 'Relay is running again, hidden' }
  else { Warn "The task did not start the relay. Start it with: Start-ScheduledTask -TaskName '$Task'" }
}

Write-Host "`nDone. A login lasts seven days; the dashboard warns two days before it runs out." -ForegroundColor Green
# An explicit success code, so renew-solis-login.cmd can close its window.
exit 0
