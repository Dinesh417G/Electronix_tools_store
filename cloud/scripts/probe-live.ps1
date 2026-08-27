<#
  Runs scripts/probe-live.mts against the LIVE deployment, which needs a
  Supabase connection string the owner alone holds. Runnable from anywhere;
  it resolves the app directory from its own path.

  Run this in YOUR OWN terminal. The password prompt is interactive and
  non-echoing: nothing typed here reaches shell history, the process list,
  or a transcript.

  Read-only by default. It still writes two rows to the production database —
  an inactive `tablets` row and a 30-minute `api_tokens` row that the probe
  revokes when it finishes — because §11 auth is on every endpoint being
  measured and STORE_ENROLMENT_SECRET is stored Sensitive and cannot be read
  back.

    .\scripts\probe-live.ps1                 # read only, 5 rounds
    .\scripts\probe-live.ps1 -Rounds 10
    .\scripts\probe-live.ps1 -Write          # adds ONE real ATTLOG push (§9's budget)

  -Write leaves a punch and an offered session on production. That session
  expires unclaimed after 90 s (§10). It does not claim or issue, so it writes
  no ledger rows.
#>

[CmdletBinding()]
param(
  [string]$Base   = "https://electronix-tool-crib.vercel.app",
  [int]   $Rounds = 5,
  [switch]$Write
)

$ErrorActionPreference = "Stop"
# Resolve the app directory from this script, not from where it was invoked.
Set-Location (Join-Path $PSScriptRoot "..")

# Supabase project ref carried by the USER, port 6543. The direct
# db.<ref>.supabase.co:5432 string fails auth against Supavisor, and the error
# names plain "postgres" either way — it does not tell you which one you used.
$PoolerUser = "postgres.hhpmwnmubibracnwsmos"
$PoolerHost = "aws-0-ap-south-1.pooler.supabase.com"

$sec = Read-Host "Supabase database password" -AsSecureString
if ($sec.Length -eq 0) { Write-Error "no password entered"; exit 1 }

$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
  # Percent-encode: a '%' in the password is the documented "URI malformed"
  # trap, and EscapeDataString handles the '%' itself, which hand-encoding
  # usually does not.
  $enc = [uri]::EscapeDataString($pw)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$env:DATABASE_URL = "postgresql://${PoolerUser}:${enc}@${PoolerHost}:6543/postgres"
Remove-Variable pw, enc, sec, bstr -ErrorAction SilentlyContinue

$probeArgs = @("--base", $Base, "--rounds", $Rounds)
if ($Write) {
  Write-Host ""
  Write-Host "  -Write will push one real ATTLOG record to $Base." -ForegroundColor Yellow
  Write-Host "  It leaves a punch row and an offered session on production." -ForegroundColor Yellow
  $ok = Read-Host "  Type 'yes' to continue"
  if ($ok -ne "yes") { Remove-Item Env:DATABASE_URL; Write-Host "aborted."; exit 1 }
  $probeArgs += "--write"
}

try {
  npm run probe -- @probeArgs
  $code = $LASTEXITCODE
} finally {
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  Write-Host "`n  DATABASE_URL cleared from this shell."
}

exit $code
