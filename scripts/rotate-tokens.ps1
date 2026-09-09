<#
  Replaces API_TOKEN and/or INGEST_TOKEN with fresh random values, in both
  places they have to match: the Cloudflare secret the Worker checks against,
  and the local .dev.vars the relay and `npm run dev` read.

  Use it when a token has leaked, or when the local copy has been lost - the
  Worker will not hand a secret back, so a lost token can only be replaced.

  What each one costs you:

    -Ingest   The relay stops being able to push until it is restarted with
              the new value. This script restarts it for you.

    -Api      Every browser that has the dashboard unlocked is signed out,
              because the cookie is the token. Each device needs
              /auth?t=<new value> opened once more.

  Examples:
    .\scripts\rotate-tokens.ps1 -Ingest
    .\scripts\rotate-tokens.ps1 -Api -Ingest
#>
[CmdletBinding()]
param(
  [switch] $Api,
  [switch] $Ingest
)

$ErrorActionPreference = 'Stop'

function Ok($t)   { Write-Host "    OK  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    !!  $t" -ForegroundColor Yellow }
function Die($t)  { Write-Host "    XX  $t" -ForegroundColor Red; exit 1 }

if (-not $Api -and -not $Ingest) {
  Die 'Nothing to do. Pass -Api, -Ingest, or both.'
}

$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
  $devVars = Join-Path $root '.dev.vars'
  if (-not (Test-Path $devVars)) { Die "No .dev.vars at $devVars" }

  # A URL-safe 256-bit value: it travels in a query string on the /auth link,
  # so it must survive being pasted into an address bar unescaped.
  #
  # Create().GetBytes(), not the tidier RandomNumberGenerator::Fill(Span): Fill
  # exists only on .NET Core, and Windows PowerShell 5.1 - still the default
  # shell on Windows - runs on .NET Framework, where it is simply absent.
  function New-Token {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  }

  $names = @()
  if ($Api)    { $names += 'API_TOKEN' }
  if ($Ingest) { $names += 'INGEST_TOKEN' }

  foreach ($name in $names) {
    Write-Host "`nRotating $name" -ForegroundColor Cyan
    $value = New-Token

    # Cloudflare first. If this fails the old token stays valid everywhere,
    # which is the safe way round: a .dev.vars updated ahead of a failed
    # secret put would leave the relay pushing a token the Worker rejects.
    #
    # ErrorActionPreference drops to Continue for the call: wrangler prints its
    # banner and progress to stderr, and Windows PowerShell turns any stderr
    # from a native command into an ErrorRecord, which under Stop would abort
    # this script on a command that had just succeeded. The exit code is the
    # only thing here that actually reports the outcome.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $value | npx wrangler secret put $name --config .wrangler.local.jsonc }
    finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) { Die "Could not set the Cloudflare secret $name - nothing was changed locally." }
    Ok 'Cloudflare secret updated'

    $lines = Get-Content $devVars
    if ($lines -match "^$name=") {
      $lines = $lines -replace "^$name=.*$", "$name=$value"
    } else {
      $lines += "$name=$value"
    }
    Set-Content -Path $devVars -Value $lines -Encoding utf8
    Ok '.dev.vars updated'
  }

  if ($Ingest) {
    Write-Host "`nRestarting the relay so it picks up the new ingest token" -ForegroundColor Cyan
    $task = Get-ScheduledTask -TaskName 'SolarLens relay' -ErrorAction SilentlyContinue
    if ($task) {
      Stop-ScheduledTask -TaskName 'SolarLens relay' -ErrorAction SilentlyContinue
      Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*solis-relay*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-ScheduledTask -TaskName 'SolarLens relay'
      Start-Sleep -Seconds 10
      $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*solis-relay*' }).Count
      if ($running -gt 0) { Ok 'Relay restarted' }
      else { Warn 'The relay did not come back - start it with: npm run relay:solis' }
    } else {
      Warn 'No "SolarLens relay" scheduled task here - restart the relay yourself: npm run relay:solis'
    }
  }

  if ($Api) {
    # Both read from .dev.vars rather than being written into this file: the
    # repository is public, and a deployment URL is as personal as a token.
    $token = (Get-Content $devVars | Where-Object { $_ -like 'API_TOKEN=*' }) -replace '^API_TOKEN=', ''
    $url   = ((Get-Content $devVars | Where-Object { $_ -like 'SOLARLENS_URL=*' }) -replace '^SOLARLENS_URL=', '').TrimEnd('/')
    Write-Host "`nEvery device is now signed out. To unlock one, open this on it once:" -ForegroundColor Cyan
    Write-Host "  $url/auth?t=$token" -ForegroundColor Yellow
    Write-Host '  (the link contains the token - do not post it anywhere)'
  }

  Write-Host "`nDone." -ForegroundColor Green
}
finally { Pop-Location }
