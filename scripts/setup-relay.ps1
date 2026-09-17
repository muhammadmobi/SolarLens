# One-shot setup for the SolisCloud relay on a new Windows machine.
#
# SolisCloud signs every request with a secret buried in its own JavaScript, so
# there is no token a server can replay: the only way to read it is a real
# browser driving a real session. This script sets that browser up as a
# background service on whatever machine you run it on.
#
# It is safe to run twice. Everything it does is checked first, so a second run
# repairs whatever is missing and leaves the rest alone: Node, Git and Chrome
# are installed only when absent, dependencies only when they changed, and a
# browser window appears only when SolisCloud needs someone to log in.
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

# Stop a relay this machine is already running, and the Chrome it drives.
#
# Chrome lets one program at a time use a profile. When a relay already runs
# here, the login check below would start a second one on the same profile: the
# new one kills the hidden relay's browser to get in, and the hidden relay kills
# the new one's on its next cycle - mid-login if you are still typing. Stop the
# task first, then its wrapper, then node, then the relay's Chrome. Killing only
# node.exe leaves the wscript wrapper alive, Task Scheduler still counts the task
# as running, and Start-ScheduledTask on an already-running task does nothing.
function Stop-HiddenRelay {
  Stop-ScheduledTask -TaskName 'SolarLens relay' -ErrorAction SilentlyContinue
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
  Start-Sleep -Seconds 1
}

# Run the relay for one cycle and return its exit code: 0 a reading went
# through, 3 SolisCloud wants a login, anything else another failure. Hidden
# unless -Visible. Alarm history and period totals are skipped - they add most
# of a minute, and the background relay started afterwards reads them anyway.
# renew-solis-login.ps1 carries the same function.
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

# Chrome installs per-machine or per-user depending on who ran the installer,
# so look in all three places rather than assuming Program Files.
function Find-Chrome {
  @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

Write-Host "SolarLens relay setup" -ForegroundColor White
Write-Host "---------------------"

# --- 1. prerequisites: install what is missing, skip what is there ---------
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

# The relay drives Google Chrome itself, so a machine without it cannot relay.
# winget's Chrome installer may ask for administrator approval; if that is
# declined the setup carries on, in case CHROME_PATH points somewhere unusual.
$chrome = Find-Chrome
if ($chrome) { Ok "Google Chrome found ($chrome)" }
elseif (Get-Command winget -ErrorAction SilentlyContinue) {
  Warn 'Google Chrome missing - installing with winget (Windows may ask for approval)'
  try {
    Invoke-Native 'winget' @('install','--id','Google.Chrome','-e','--accept-source-agreements','--accept-package-agreements') 'installing Google Chrome'
  } catch { Warn "$_" }
  $chrome = Find-Chrome
  if ($chrome) { Ok "Google Chrome installed ($chrome)" }
  else {
    $chrome = 'chrome.exe'
    Warn 'Chrome did not install - install it from https://www.google.com/chrome and run this again, or set CHROME_PATH in .dev.vars'
  }
} else {
  $chrome = 'chrome.exe'
  Warn 'Chrome is not installed and winget is unavailable - install it from https://www.google.com/chrome, or set CHROME_PATH in .dev.vars'
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
  catch {
    # A fast-forward is not always possible, and that is expected rather than
    # exceptional: a checkout left on a branch that was later squash-merged, or
    # holding any commit that never reached main in that form, has diverged from
    # the published branch. Such a checkout can never fast-forward, and would sit
    # on stale code indefinitely while reporting only a warning - which is how a
    # machine ended up running a month-old installer.
    #
    # Resetting is the right answer for a deployment checkout nobody edits, and
    # the wrong one for a working copy, so it happens only when git itself
    # confirms there is nothing local to lose.
    $dirty = (& git status --porcelain) -join ''
    if ($dirty) {
      Warn "Could not update ($_), and there are local changes here - leaving them alone"
    } else {
      try {
        Invoke-Native 'git' @('fetch','origin') 'git fetch'
        Invoke-Native 'git' @('reset','--hard','origin/main') 'git reset'
        Ok 'Checkout had diverged from the published history - reset to match it'
      } catch { Warn "Could not reset the checkout ($_) - carrying on with what is there" }
    }
  }
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
  Step 3 'Checking dependencies'
  # npm keeps its own record of what it installed, node_modules\.package-lock.json.
  # When that is at least as new as package-lock.json, nothing has changed since
  # the last install and a minute of npm can be skipped. A git pull that brings a
  # new package-lock.json makes it newer, and the install runs.
  $lockFile  = Join-Path $InstallDir 'package-lock.json'
  $installed = Join-Path $InstallDir 'node_modules\.package-lock.json'
  $upToDate  = (Test-Path (Join-Path $InstallDir 'node_modules\playwright-core')) -and
               (Test-Path $installed) -and (Test-Path $lockFile) -and
               ((Get-Item $installed).LastWriteTimeUtc -ge (Get-Item $lockFile).LastWriteTimeUtc)
  if ($upToDate) {
    Ok 'Dependencies already up to date - skipped'
  } else {
    Write-Host '    Installing (this takes a minute)'
    Invoke-Native 'npm' @('install','--no-audit','--no-fund','--loglevel=error') 'npm install'
    if (-not (Test-Path (Join-Path $InstallDir 'node_modules\playwright-core'))) {
      Die 'npm install finished but playwright-core is missing - run "npm install" here by hand to see why.'
    }
    Ok 'Dependencies installed'
  }

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
    # Hidden from the start. The login check below sets RELAY_HEADLESS for its
    # own runs, and the background task forces it to 1, so this line only
    # matters to someone running the relay by hand.
    $lines += '# 1 hides the relay browser. renew-solis-login.cmd opens a window when a login is needed.'
    $lines += 'RELAY_HEADLESS=1'
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

    # A saved session is not a working one: a SolisCloud login lasts seven days
    # and cannot renew itself, so a re-run checks it rather than trusting that a
    # profile folder exists. The check runs hidden first. When the saved login
    # works, which is the usual case on a re-run, no window appears at all;
    # 2.4.0 opened one every time, which on a machine that needed nothing looked
    # like something going wrong. A window opens only when a login is needed.
    Stop-HiddenRelay

    $profileDir = if ($env:RELAY_PROFILE) { $env:RELAY_PROFILE } else { Join-Path $InstallDir '.relay-profile' }
    $hadSession = Test-Path (Join-Path $profileDir 'Default')
    $code = -1
    if ($hadSession) {
      Write-Host '    Checking the saved SolisCloud login in the background - no window'
      Write-Host '    unless SolisCloud wants you to log in.'
      $code = Invoke-RelayOnce
      if ($code -eq 0) { Ok 'The saved SolisCloud login works, and a reading is through' }
      elseif ($code -eq 3) { Warn 'The saved SolisCloud login has expired' }
      else { Warn "The background check did not get through (exit $code) - trying again in a window" }
    }
    if ($code -ne 0) {
      Write-Host ''
      Write-Host '    A Chrome window opens on SolisCloud. Log in there if it asks.'
      if (-not $hadSession) {
        Write-Host ''
        Write-Host '    It is a browser of its own, not the one you use. Chrome will not let'
        Write-Host '    two programs share one profile, so the agent cannot borrow the session'
        Write-Host '    in your everyday browser. You log in here once a week; the rest of the'
        Write-Host '    time it runs hidden.'
      }
      Write-Host ''
      Write-Host '    Nothing to press afterwards - the window closes itself once a reading'
      Write-Host '    has been sent.' -ForegroundColor Yellow
      Write-Host ''
      # RELAY_ONCE, inside Invoke-RelayOnce, makes it exit by itself. The old
      # instruction was "press Ctrl+C when it says pushed", which on Windows raises
      # "Terminate batch job (Y/N)?" and leaves setup stopped half-way.
      if ((Invoke-RelayOnce -Visible) -ne 0) {
        Die 'No reading was sent - the SolisCloud login did not complete. Run this again.'
      }
      Ok 'Logged in, and a reading is through'
    }
  }

  # --- 6. start it on every logon -----------------------------------------
  # A task someone disabled is a relay paused on purpose. Re-registering it
  # would switch it back on, so it is left exactly as it is.
  $pausedTask = Get-ScheduledTask -TaskName 'SolarLens relay' -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq 'Disabled' }
  if ($NoTask) {
    Warn 'Skipping the scheduled task (-NoTask). Start it yourself with: npm run relay:solis'
  } elseif ($pausedTask) {
    Step 6 'Starting the relay automatically at logon'
    Warn "The 'SolarLens relay' task is disabled on this computer, so it was left off."
    Write-Host "    To run it again: Enable-ScheduledTask -TaskName 'SolarLens relay'; Start-ScheduledTask -TaskName 'SolarLens relay'"
  } else {
    Step 6 'Starting the relay automatically at logon'

    $node = (Get-Command node).Source

    # Ask Windows who is running this rather than assembling a name from
    # COMPUTERNAME and USERNAME. That composition is only right on a machine
    # whose accounts are local: a domain or Entra-joined laptop resolves its
    # user as DOMAIN\name or AzureAD\name, and registration fails with "No
    # mapping between account names and security IDs was done" - which is
    # exactly what happened on the first work laptop this was run on.
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

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
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2) `
             -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable

    # Two ways to name the account, tried in order. The first pins the task to
    # this user; the second omits the principal entirely and lets Task
    # Scheduler use whoever registered it, which needs no name to resolve at
    # all. The fallback exists because account naming is the part of this that
    # varies between a home machine and a managed one.
    $attempts = @(
      @{ What = "for $me";                  User = $me },
      @{ What = 'for the current user';     User = $null }
    )

    $registered = $false
    foreach ($a in $attempts) {
      try {
        $p = @{
          TaskName = 'SolarLens relay'; Action = $action; Settings = $set; Force = $true
          Description = 'Relays SolisCloud readings to the SolarLens Worker. Runs hidden.'
          Trigger = if ($a.User) { New-ScheduledTaskTrigger -AtLogOn -User $a.User }
                    else         { New-ScheduledTaskTrigger -AtLogOn }
        }
        if ($a.User) {
          $p.Principal = New-ScheduledTaskPrincipal -UserId $a.User -LogonType Interactive -RunLevel Limited
        }
        Register-ScheduledTask @p -ErrorAction Stop | Out-Null
      } catch {
        Warn "Could not register the task $($a.What): $($_.Exception.Message.Split([char]10)[0])"
        continue
      }
      # Register-ScheduledTask has reported success here while leaving no task
      # behind, so the only trustworthy answer comes from asking for it back.
      if (Get-ScheduledTask -TaskName 'SolarLens relay' -ErrorAction SilentlyContinue) {
        $registered = $true
        Ok "Scheduled task `"SolarLens relay`" registered $($a.What)"
        break
      }
      Warn "The task did not exist after registering it $($a.What)"
    }
    if (-not $registered) {
      Die "Could not register the scheduled task. The relay is installed and works if you start it by hand (npm run relay:solis in $InstallDir), but it will not start itself at logon."
    }

    # A relay started by -UseMyChrome, or by hand, may still be running. Start
    # only after stopping it: Start-ScheduledTask on a task that is already
    # running does nothing at all, and the wrapper then notices its child is
    # gone and exits, leaving the task Ready and no relay.
    Stop-HiddenRelay

    Start-ScheduledTask -TaskName 'SolarLens relay'
    # Poll rather than sleep once: wscript has to start, then node, then
    # Playwright has to find Chrome, and on a cold machine ten seconds is not
    # always enough to see any of it.
    $running = 0
    foreach ($i in 1..15) {
      Start-Sleep -Seconds 2
      $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*solis-relay*' }).Count
      if ($running -gt 0) { break }
    }
    if ($running -gt 0) { Ok 'Relay is running now, hidden, and will start itself at every logon' }
    else {
      $code = (Get-ScheduledTaskInfo -TaskName 'SolarLens relay' -ErrorAction SilentlyContinue).LastTaskResult
      $hex = '0x{0:X}' -f $code
      Die "The task was registered but did not start the relay (last result $hex). Open Task Scheduler, find `"SolarLens relay`" and run it by hand to see what it says."
    }
  }

  Write-Host "`nDone." -ForegroundColor Green
  Write-Host "  The relay pushes SolisCloud readings every 5 minutes while this machine is on."
  Write-Host "  It is fine to run this on more than one machine: duplicate readings are"
  Write-Host "  discarded, and whichever machine is awake backfills whatever the others missed."
  Write-Host "  To stop it:   Stop-ScheduledTask -TaskName 'SolarLens relay'"
  Write-Host "  To remove it: Unregister-ScheduledTask -TaskName 'SolarLens relay' -Confirm:`$false"
}
finally { Pop-Location }
# An explicit success code, so the .cmd that ran this can close its window.
exit 0
