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
  [switch] $NoTask,
  # Use the Chrome you already have open, with the logins already in it,
  # instead of the agent running a second one of its own.
  [switch] $UseMyChrome,
  [int]    $DebugPort = 9222
)

$ErrorActionPreference = 'Stop'
$Repo = 'https://github.com/muhammadmobi/SolarLens.git'

# Run an external program without PowerShell mistaking its chatter for failure.
#
# git and npm write ordinary progress to stderr - "Cloning into ...", npm's
# notices - and Windows PowerShell turns any stderr from a native command into
# an ErrorRecord. With ErrorActionPreference = Stop that aborts the script on a
# command that actually succeeded, which is exactly how the first version of
# this file failed at the clone step. So: drop to Continue first, collect both
# streams, and judge the outcome by the exit code - the only thing here that
# means anything - printing what was said only when that code is non-zero.
function Invoke-Native {
  # Not $Args: that is an automatic variable in PowerShell, and using the name
  # here silently breaks the splat below. It cost a debugging round to find.
  param([string] $Exe, [string[]] $CmdArgs, [string] $What)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Exe @CmdArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
      # Show what it actually said. "failed (exit 1)" on its own is useless to
      # whoever has to fix it.
      Write-Host "    ---- $Exe output ----" -ForegroundColor DarkGray
      $output | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
      throw "$What failed (exit $LASTEXITCODE)"
    }
  } finally { $ErrorActionPreference = $prev }
}

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
    Invoke-Native 'winget' @('install','--id',$tool.Pkg,'-e','--accept-source-agreements','--accept-package-agreements') "installing $($tool.Name)"
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

# Chrome installs per-machine or per-user depending on who ran the installer,
# so look in all three places rather than assuming Program Files.
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($chrome) { Ok "Google Chrome found ($chrome)" }
else {
  $chrome = 'chrome.exe'
  Warn 'Chrome is not in any of the usual places - set CHROME_PATH in .dev.vars if the relay cannot find it'
}

# --- 2. the code -----------------------------------------------------------
Step 2 "Getting the code into $InstallDir"

if ((Test-Path $InstallDir) -and -not (Test-Path (Join-Path $InstallDir '.git')) -and
    @(Get-ChildItem $InstallDir -Force -ErrorAction SilentlyContinue).Count -gt 0) {
  Die "$InstallDir exists but is not a git checkout. Delete or rename it, then run this again."
}

if (Test-Path (Join-Path $InstallDir '.git')) {
  Push-Location $InstallDir
  try { Invoke-Native 'git' @('pull','--ff-only') 'git pull'; Ok 'Repository already present - updated' }
  catch { Warn "Could not update the checkout ($_) - carrying on with what is there" }
  finally { Pop-Location }
} else {
  $parent = Split-Path $InstallDir -Parent
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  Invoke-Native 'git' @('clone','--quiet',$Repo,$InstallDir) 'git clone'
  if (-not (Test-Path (Join-Path $InstallDir '.git'))) { Die "Clone reported success but $InstallDir has no .git - check the path is writable." }
  Ok 'Cloned'
}

Push-Location $InstallDir
try {
  Step 3 'Installing dependencies (this takes a minute)'
  Invoke-Native 'npm' @('install','--no-audit','--no-fund','--loglevel=error') 'npm install'
  if (-not (Test-Path (Join-Path $InstallDir 'node_modules\playwright-core'))) {
    Die 'npm install finished but playwright-core is missing - run "npm install" here by hand to see why.'
  }
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
  if ($UseMyChrome) {
    $lines += '# Attach to the Chrome you already have open rather than running one.'
    $lines += "RELAY_CDP=http://127.0.0.1:$DebugPort"
  } else {
    $lines += '# 1 hides the relay browser. Set 0 and run by hand if you ever need to log in again.'
    $lines += 'RELAY_HEADLESS=0'
  }
  foreach ($k in $existing.Keys) {
    if ($k -notin @('SOLARLENS_URL','INGEST_TOKEN','SOLIS_PLANT_IDS','RELAY_HEADLESS','RELAY_CDP')) {
      $lines += "$k=$($existing[$k])"
    }
  }
  Set-Content -Path $devVars -Value $lines -Encoding utf8
  Ok '.dev.vars written'

  # --- 5. the browser ------------------------------------------------------
  if ($UseMyChrome) {
    Step 5 'Using the Chrome you already have open'

    $reachable = $false
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:$DebugPort/json/version" -UseBasicParsing -TimeoutSec 4 | Out-Null
      $reachable = $true
    } catch { }

    if ($reachable) {
      Ok "Found a Chrome listening on port $DebugPort - the relay will use it, with your own SolisCloud login"
    } else {
      Warn "No Chrome is listening on port $DebugPort."
      Write-Host ''
      Write-Host '    Chrome only accepts outside control if it was STARTED with a debugging'
      Write-Host '    port; the flag cannot be switched on afterwards. So you have to close'
      Write-Host '    Chrome completely - every window - and start it like this:'
      Write-Host ''
      Write-Host "      & '$chrome' --remote-debugging-port=$DebugPort" -ForegroundColor Yellow
      Write-Host ''
      Write-Host '    Worth knowing before you do: that port lets any program on this machine'
      Write-Host '    drive your browser and everything it is signed in to. The relay also'
      Write-Host '    stops working whenever Chrome is closed. Running it in its own hidden'
      Write-Host '    browser (the default, without -UseMyChrome) has neither drawback.'
      Write-Host ''
      Warn 'Set up anyway - start Chrome that way and the relay will connect on its next cycle.'
    }
  } else {
    Step 5 'Signing in to SolisCloud'

    $profileDir = Join-Path $InstallDir '.relay-profile'
    if (Test-Path (Join-Path $profileDir 'Default')) {
      Ok 'A saved session already exists - skipping the login step'
    } else {
      Write-Host '    A Chrome window will open on SolisCloud. Sign in there.'
      Write-Host ''
      Write-Host '    It is a browser of its own, not the one you use. Chrome will not let'
      Write-Host '    two programs share one profile, so the agent cannot borrow the session'
      Write-Host '    in your everyday browser. You sign in here once; after this it runs'
      Write-Host '    hidden and you never see it again.'
      Write-Host ''
      Write-Host '    Nothing to press afterwards - it closes itself once the first'
      Write-Host '    reading has been sent.' -ForegroundColor Yellow
      Write-Host ''

      # RELAY_ONCE so it exits by itself. The old instruction was "press Ctrl+C
      # when it says pushed", which on Windows raises "Terminate batch job
      # (Y/N)?" inside the .cmd wrapper and leaves setup stopped half-way.
      $env:RELAY_ONCE = '1'
      try { npm run relay:solis } finally { Remove-Item Env:\RELAY_ONCE -ErrorAction SilentlyContinue }
      if ($LASTEXITCODE -ne 0) {
        Die 'The first reading was not sent - the SolisCloud sign-in did not complete. Run this again.'
      }
      Ok 'Signed in, and the first reading is through'
    }

    # Hide it from now on.
    (Get-Content $devVars) -replace '^RELAY_HEADLESS=0$', 'RELAY_HEADLESS=1' |
      Set-Content $devVars -Encoding utf8
    Ok 'Relay set to run hidden from now on'
  }

  # --- 6. start it on every logon -----------------------------------------
  if ($NoTask) {
    Warn 'Skipping the scheduled task (-NoTask). Start it yourself with: npm run relay:solis'
  } else {
    Step 6 'Starting the relay automatically at logon'

    $node = (Get-Command node).Source
    $me   = "$env:COMPUTERNAME\$env:USERNAME"

    # Started through a one-line WSH launcher rather than directly, because
    # node.exe is a console application: run it from the task and a black
    # terminal appears at every logon and stays for as long as the relay does.
    # Task Scheduler's "Hidden" setting does not touch that - it hides the task
    # from the Task Scheduler list - and the principal that would (S4U, off the
    # interactive desktop) needs an elevated prompt this installer does not ask
    # for. See scripts\relay-hidden.vbs.
    $vbs = Join-Path $InstallDir 'scripts\relay-hidden.vbs'
    if (Test-Path $vbs) {
      $action = New-ScheduledTaskAction -Execute 'wscript.exe' `
                  -Argument "//nologo `"$vbs`" `"$node`"" -WorkingDirectory $InstallDir
    } else {
      Warn 'relay-hidden.vbs is missing - the relay will run in a visible console window'
      $action = New-ScheduledTaskAction -Execute $node -Argument 'agent\solis-relay.mjs' -WorkingDirectory $InstallDir
    }
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
