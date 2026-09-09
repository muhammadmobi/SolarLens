<#
  Builds a personalised, double-clickable installer for a second machine.

  setup-relay.cmd already automates the install, but it stops three times to
  ask for the Worker URL, the ingest token and the plant ids - which means
  carrying those values to the other machine and typing them correctly. This
  reads them out of the .dev.vars here and bakes them into a single .cmd file
  you copy across and double-click.

  The generated file CONTAINS YOUR INGEST TOKEN in plain text. That token only
  permits pushing readings - it cannot read your dashboard and cannot reach
  your Cloudflare account - but treat the file as a key all the same: carry it
  on a USB stick rather than emailing it, and delete it from both machines
  afterwards. It is written outside the repository on purpose.

  One step still needs a person at the other end: signing in to SolisCloud.
  The whole point of the relay is that it drives a logged-in browser session,
  and no script can type a password into a login form on your behalf.

  Usage:
    .\scripts\make-laptop-installer.ps1
    .\scripts\make-laptop-installer.ps1 -OutFile D:\usb\setup-solarlens.cmd
#>
[CmdletBinding()]
param(
  [string] $OutFile
)

$ErrorActionPreference = 'Stop'

function Ok($t)   { Write-Host "    OK  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    !!  $t" -ForegroundColor Yellow }
function Die($t)  { Write-Host "    XX  $t" -ForegroundColor Red; exit 1 }

$root    = Split-Path $PSScriptRoot -Parent
$devVars = Join-Path $root '.dev.vars'
if (-not (Test-Path $devVars)) { Die "No .dev.vars at $devVars - run this on the machine that already works." }

$vars = @{}
Get-Content $devVars | ForEach-Object {
  if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $vars[$matches[1]] = $matches[2].Trim() }
}

$url    = $vars['SOLARLENS_URL']
$token  = $vars['INGEST_TOKEN']
$plants = $vars['SOLIS_PLANT_IDS']

if (-not $url)   { Die 'SOLARLENS_URL is not set in .dev.vars.' }
if (-not $token) { Die 'INGEST_TOKEN is not set in .dev.vars.' }
if ($token -eq 'RECOVER-ME' -or $url -eq 'RECOVER-ME') {
  Die 'INGEST_TOKEN still reads RECOVER-ME. Run scripts\rotate-tokens.ps1 -Ingest first.'
}

# A stray quote or percent sign in a value would break the batch file it is
# pasted into. These are generated tokens and ids, so it should never happen -
# but "should never" is how broken installers get shipped.
foreach ($pair in @(@('SOLARLENS_URL', $url), @('INGEST_TOKEN', $token), @('SOLIS_PLANT_IDS', $plants))) {
  if ($pair[1] -match "['`"%&|<>^]") { Die "$($pair[0]) contains a character that cannot be embedded safely. Set it on the other machine by hand instead." }
}

if (-not $OutFile) {
  $OutFile = Join-Path ([Environment]::GetFolderPath('Desktop')) 'setup-solarlens-relay.cmd'
}

$plantArg = if ($plants) { " -PlantIds '$plants'" } else { '' }
$raw  = 'https://raw.githubusercontent.com/muhammadmobi/SolarLens/main/scripts/setup-relay.ps1'
$repo = 'https://github.com/muhammadmobi/SolarLens.git'
$dir  = 'C:\source\SolarLens'   # matches setup-relay.ps1's own default

# Three ways to reach the code, tried in order of reliability.
#
# The first version only knew the third: fetch one file from
# raw.githubusercontent.com. That host answered 503 ten times in a row on the
# machine this was meant to set up, and the installer had nothing else to try -
# it gave up on a repository that was perfectly reachable, because it was
# asking the wrong server for it. github.com was answering 200 throughout.
#
#   1. A checkout already here      - use it, and git pull if that works.
#   2. git clone from github.com    - a different host, and the one that stayed
#                                     up all day while the CDN did not.
#   3. The single file over HTTPS   - last resort, for a machine with no git.
$fetch = @"
`$ErrorActionPreference='Continue';
`$dir='$dir'; `$s=Join-Path `$dir 'scripts\setup-relay.ps1';
`$git=[bool](Get-Command git -ErrorAction SilentlyContinue);
if (Test-Path `$s) {
  Write-Host '  Already installed here - checking for updates';
  if (`$git) { Push-Location `$dir; git pull --ff-only | Out-Null;
    if (`$LASTEXITCODE -eq 0) { Write-Host '  Up to date' } else { Write-Host '  Could not update - using the copy already here' };
    Pop-Location }
} elseif (`$git) {
  Write-Host '  Getting the code from github.com';
  git clone --quiet '$repo' `$dir | Out-Null;
  if (Test-Path `$s) { Write-Host '  Done' }
}
if (-not (Test-Path `$s)) {
  Write-Host '  No git here - trying a direct download instead';
  `$f=Join-Path `$env:TEMP 'solarlens-setup-relay.ps1';
  foreach (`$i in 1..4) { try { Invoke-WebRequest '$raw' -OutFile `$f -UseBasicParsing -TimeoutSec 25; break } catch { Write-Host ('  GitHub file server not responding (' + `$i + ' of 4)') -ForegroundColor DarkGray; Start-Sleep -Seconds 5 } };
  if (Test-Path `$f) { `$s=`$f }
}
if (-not (Test-Path `$s)) {
  Write-Host '';
  Write-Host 'Could not get the setup files.' -ForegroundColor Red;
  if (-not `$git) { Write-Host 'Git is not installed here, and the GitHub file server is not responding.' -ForegroundColor Yellow; Write-Host 'Install Git from https://git-scm.com/download/win and run this file again - it only needs github.com after that.' -ForegroundColor Yellow }
  else { Write-Host 'github.com could not be reached. Check the internet connection and try again.' -ForegroundColor Yellow };
  exit 1
}
& `$s -InstallDir `$dir -WorkerUrl '$url' -IngestToken '$token'$plantArg
"@ -replace "`r?`n", ' '

# Written as one PowerShell -Command line so the file stays a plain .cmd that
# Windows will run on a double-click. Values are in single quotes: PowerShell
# does not expand anything inside those, so a token cannot be mangled.
$body = @"
@echo off
REM ---------------------------------------------------------------------
REM  SolarLens relay - one-click setup for a second machine.
REM
REM  Generated by scripts\make-laptop-installer.ps1. This file contains an
REM  ingest token: treat it as a key, and delete it once the setup is done.
REM
REM  It installs whatever is missing (Node, Git, Chrome), fetches the code,
REM  and registers the relay to start at every logon. The only thing it will
REM  ask you for is your SolisCloud login, in the browser window it opens.
REM ---------------------------------------------------------------------

echo.
echo  Setting up the SolarLens relay on this machine.
echo  Nothing to type until a Chrome window opens on the SolisCloud login.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$fetch"

if errorlevel 1 (
  echo.
  echo  Setup did not finish. The message above says why.
  echo.
  pause
  exit /b 1
)

echo.
echo  Finished. The relay is running hidden and will start itself at every logon.
echo  You can delete this file now.
echo.
echo  Closing in 20 seconds - press a key to close it sooner.
timeout /t 20
exit /b 0
"@

Set-Content -Path $OutFile -Value $body -Encoding ascii
Ok "Written to $OutFile"

Write-Host ''
Write-Host '  Copy that file to the other laptop and double-click it.' -ForegroundColor Cyan
Write-Host '  It will ask you for nothing except the SolisCloud login in the browser.'
Write-Host ''
Warn 'It contains your ingest token. Carry it on a USB stick, not by email, and delete it afterwards.'
