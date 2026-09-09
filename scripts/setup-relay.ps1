# One-shot setup for the SolisCloud relay on a new Windows machine.
#
# SolisCloud signs every request with a secret buried in its own JavaScript, so
# there is no token a server can replay: the only way to read it is a real
# browser driving a real session. This script sets that browser up as a
# background service on whatever machine you run it on.
#
# It is safe to run twice. Everything it does is checked first, so a second run
# repairs whatever is missing and leaves the rest alone.
#
#   powershell -ExecutionPolicy Bypass -File setup-relay.ps1
#
# Nothing secret is stored in this file. It asks for the ingest token when it
# needs one, and writes it only to .dev.vars, which git ignores.

[CmdletBinding()]
param(
  [string] $InstallDir = 'C:\source\SolarLens',
  [string] $WorkerUrl  = '',
  [string] $IngestToken = '',
  [string] $PlantIds   = '',
  [switch] $NoTask
)

$ErrorActionPreference = 'Stop'
$Repo = 'https://github.com/muhammadmobi/SolarLens.git'

function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "    OK  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    !!  $t" -ForegroundColor Yellow }
function Die($t)  { Write-Host "`nSTOPPED: $t" -ForegroundColor Red; exit 1 }

Write-Host "SolarLens relay setup" -ForegroundColor White
Write-Host "---------------------"

# --- 1. the things this cannot install for you -----------------------------
Step 1 'Checking prerequisites'

foreach ($tool in @(
  @{ Name = 'node'; Pkg = 'OpenJS.NodeJS.LTS'; Site = 'https://nodejs.org' },
  @{ Name = 'git';  Pkg = 'Git.Git';           Site = 'https://git-scm.com' }
)) {
  if (Get-Command $tool.Name -ErrorAction SilentlyContinue) {
    Ok "$($tool.Name) $(& $tool.Name --version 2>&1 | Select-Object -First 1)"
    continue
  }
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Warn "$($tool.Name) missing - installing with winget"
    winget install --id $tool.Pkg -e --accept-source-agreements --accept-package-agreements | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command $tool.Name -ErrorAction SilentlyContinue)) {
      Die "$($tool.Name) installed but not on PATH yet. Close this window, open a new one, and run the script again."
    }
    Ok "$($tool.Name) installed"
  } else {
    Die "$($tool.Name) is not installed and winget is unavailable. Install it from $($tool.Site), then run this again."
  }
}

$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (Test-Path $chrome) { Ok 'Google Chrome found' }
else { Warn 'Chrome not at the default path - set CHROME_PATH in .dev.vars if the relay cannot find it' }

# --- 2. the code -----------------------------------------------------------
Step 2 "Getting the code into $InstallDir"

if (Test-Path (Join-Path $InstallDir '.git')) {
  Push-Location $InstallDir
  git pull --ff-only 2>&1 | Out-Null
  Pop-Location
  Ok 'Repository already present - updated'
} else {
  $parent = Split-Path $InstallDir -Parent
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  git clone $Repo $InstallDir 2>&1 | Out-Null
  Ok 'Cloned'
}

Push-Location $InstallDir
try {
  Step 3 'Installing dependencies (this takes a minute)'
  npm install --no-audit --no-fund 2>&1 | Out-Null
  Ok 'Dependencies installed'

  # --- 4. settings --------------------------------------------------------
  Step 4 'Configuring'

  $devVars = Join-Path $InstallDir '.dev.vars'
  $existing = @{}
  if (Test-Path $devVars) {
    Get-Content $devVars | ForEach-Object {
      if ($_ -match '^([A-Z0-9_]+)=(.*)$') { $existing[$matches[1]] = $matches[2] }
    }
    Ok 'Found an existing .dev.vars - keeping what is already set'
  }

  if (-not $WorkerUrl)   { $WorkerUrl   = $existing['SOLARLENS_URL'] }
  if (-not $IngestToken) { $IngestToken = $existing['INGEST_TOKEN'] }
  if (-not $PlantIds)    { $PlantIds    = $existing['SOLIS_PLANT_IDS'] }

  if (-not $WorkerUrl) {
    $WorkerUrl = Read-Host '    Worker URL (e.g. https://solar-lens.<you>.workers.dev)'
  }
  if (-not $IngestToken) {
    Write-Host '    The ingest token is the INGEST_TOKEN line from the .dev.vars on your'
    Write-Host '    other machine. It only permits pushing readings - it cannot read your'
    Write-Host '    dashboard or reach your Cloudflare account.'
    $IngestToken = Read-Host '    INGEST_TOKEN'
  }
  if (-not $IngestToken) { Die 'No ingest token given; the relay cannot push without one.' }
  if (-not $PlantIds) {
    Write-Host '    Which SolisCloud plant to relay. Leave blank for every plant the'
    Write-Host '    account can see - set it if the account has plants shared into it.'
    $PlantIds = Read-Host '    SOLIS_PLANT_IDS (optional)'
  }

  # Headed for now: the first run needs a visible window to log in through.
  $lines = @(
    '# Written by scripts/setup-relay.ps1. Gitignored - keep it that way.',
    "SOLARLENS_URL=$WorkerUrl",
    "INGEST_TOKEN=$IngestToken"
  )
  if ($PlantIds) { $lines += "SOLIS_PLANT_IDS=$PlantIds" }
  $lines += '# 1 hides the relay browser. Set 0 and run by hand if you ever need to log in again.'
  $lines += 'RELAY_HEADLESS=0'
  foreach ($k in $existing.Keys) {
    if ($k -notin @('SOLARLENS_URL','INGEST_TOKEN','SOLIS_PLANT_IDS','RELAY_HEADLESS')) {
      $lines += "$k=$($existing[$k])"
    }
  }
  Set-Content -Path $devVars -Value $lines -Encoding utf8
  Ok '.dev.vars written'

  # --- 5. the one part a person has to do ---------------------------------
  Step 5 'Signing in to SolisCloud'

  $profileDir = Join-Path $InstallDir '.relay-profile'
  if (Test-Path (Join-Path $profileDir 'Default')) {
    Ok 'A saved session already exists - skipping the login step'
  } else {
    Write-Host '    A Chrome window will open on SolisCloud. Sign in there.'
    Write-Host '    The session is saved locally, so this happens once.'
    Write-Host '    When the window shows your plant and the console says "pushed",'
    Write-Host '    press Ctrl+C in this window to continue.' -ForegroundColor Yellow
    Write-Host ''
    npm run relay:solis
  }

  # Hide it from now on.
  (Get-Content $devVars) -replace '^RELAY_HEADLESS=0$', 'RELAY_HEADLESS=1' |
    Set-Content $devVars -Encoding utf8
  Ok 'Relay set to run hidden from now on'

  # --- 6. start it on every logon -----------------------------------------
  if ($NoTask) {
    Warn 'Skipping the scheduled task (-NoTask). Start it yourself with: npm run relay:solis'
  } else {
    Step 6 'Starting the relay automatically at logon'

    $node = (Get-Command node).Source
    $me   = "$env:COMPUTERNAME\$env:USERNAME"
    $action  = New-ScheduledTaskAction -Execute $node -Argument 'agent\solis-relay.mjs' -WorkingDirectory $InstallDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
    $set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2) `
                 -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
    $princ   = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName 'SolarLens relay' -Action $action -Trigger $trigger `
      -Settings $set -Principal $princ -Force `
      -Description 'Relays SolisCloud readings to the SolarLens Worker. Runs hidden.' | Out-Null
    Ok 'Scheduled task "SolarLens relay" registered'

    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like '*solis-relay*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-ScheduledTask -TaskName 'SolarLens relay'
    Start-Sleep -Seconds 10
    $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like '*solis-relay*' }).Count
    if ($running -gt 0) { Ok 'Relay is running now, hidden, and will start itself at every logon' }
    else { Warn 'The task did not start the relay - open Task Scheduler and look at "SolarLens relay"' }
  }

  Write-Host "`nDone." -ForegroundColor Green
  Write-Host "  The relay pushes SolisCloud readings every 5 minutes while this machine is on."
  Write-Host "  It is fine to run this on more than one machine: duplicate readings are"
  Write-Host "  discarded, and whichever machine is awake backfills whatever the others missed."
  Write-Host "  To stop it:   Stop-ScheduledTask -TaskName 'SolarLens relay'"
  Write-Host "  To remove it: Unregister-ScheduledTask -TaskName 'SolarLens relay' -Confirm:`$false"
}
finally { Pop-Location }
