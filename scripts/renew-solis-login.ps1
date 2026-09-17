# Renew this computer's SolisCloud login for the relay, and restart the relay.
#
# A SolisCloud web login lasts exactly seven days, and using it does not extend
# it. The login page carries hCaptcha, so the relay cannot renew it by itself:
# once a week a person has to log in again. This makes that one double-click.
#
#   1. Stops the hidden relay, so its browser profile is free.
#   2. Updates the code, when it can do so without touching local changes.
#   3. Runs the relay once in a visible window. If the saved login still works it
#      sends a reading and closes by itself; if not, it waits for you to log in.
#   4. Starts the hidden relay again - unless you had disabled it on purpose.
#
# Usually run through renew-solis-login.cmd, from the SolarLens folder.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Task = 'SolarLens relay'

function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "    OK  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    !!  $t" -ForegroundColor Yellow }
function Die($t)  { Write-Host "`nSTOPPED: $t" -ForegroundColor Red; exit 1 }

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
Write-Host '    A Chrome window opens. If SolisCloud asks you to log in, log in there.'
Write-Host '    If it does not ask, the saved login still works.'
Write-Host '    Either way it closes by itself once a reading has been sent.' -ForegroundColor Yellow
Write-Host ''
$env:RELAY_HEADLESS = '0'
$env:RELAY_ONCE = '1'
try { & node agent\solis-relay.mjs }
finally {
  Remove-Item Env:\RELAY_HEADLESS -ErrorAction SilentlyContinue
  Remove-Item Env:\RELAY_ONCE -ErrorAction SilentlyContinue
}
if ($LASTEXITCODE -ne 0) {
  Die 'No reading was sent, so the login is not renewed yet. Run this again and complete the login in the Chrome window.'
}
Ok 'Logged in, and a reading went through'

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

Write-Host "`nDone. The new login lasts seven days; the dashboard warns two days before it runs out." -ForegroundColor Green
