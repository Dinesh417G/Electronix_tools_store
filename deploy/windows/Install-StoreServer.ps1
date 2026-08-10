<#
.SYNOPSIS
    Install or upgrade ElectronIx Tool Store on a Windows server PC (M9).

.DESCRIPTION
    §3 puts the server PC inside the plant running Postgres and store-server.
    On Windows that means a service, so it survives a reboot and starts before
    anyone logs in — a store whose server only runs while somebody is logged
    into the console is a store that stops working at shift change.

    `store-server.exe` is an ordinary console program, not service-aware, so it
    is wrapped with WinSW (https://github.com/winsw/winsw, MIT) — the same shim
    ElectronIx DNC uses for its daemon, for the same reason. WinSW requires the
    wrapper exe and its XML to share a basename:

        store-server-service.exe   (a copy of WinSW)
        store-server-service.xml   (written by this script)

    Idempotent: safe to re-run. Re-running is how you upgrade a hand-copied
    build; for a released version use `store-cli update --apply` (OTA-SETUP.md).

    What it does NOT do: install or configure PostgreSQL. A tool crib's database
    should be set up deliberately, with a backup target and a password somebody
    chose, rather than by a script guessing.

.PARAMETER InstallDir
    Where the binaries live. Default C:\ElectronIx\ToolStore.

.PARAMETER WinSwPath
    Path to a WinSW executable. Download it once from the WinSW releases page
    and keep it beside this script; it is not vendored here because it is a
    third-party binary and vendoring one invites nobody ever updating it.

.EXAMPLE
    .\Install-StoreServer.ps1 -WinSwPath .\WinSW-x64.exe
#>

[CmdletBinding()]
param(
    [string]$InstallDir = 'C:\ElectronIx\ToolStore',
    [string]$WinSwPath,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ServiceName = 'ElectronIxToolStore'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this from an elevated PowerShell (Run as Administrator).'
    }
}

function Find-Binary([string]$Name) {
    # Accept a release zip (binaries beside this script) or a source checkout.
    $candidates = @(
        (Join-Path $Here $Name),
        (Join-Path $Here "..\$Name"),
        (Join-Path $Here "..\..\target\release\$Name")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw "Cannot find $Name. Build it (cargo build --release) or run this from the release zip."
}

Assert-Administrator

$serverBin = Find-Binary 'store-server.exe'
$cliBin    = Find-Binary 'store-cli.exe'

Write-Host '==> installing from'
Write-Host "    server: $serverBin"
Write-Host "    cli:    $cliBin"

# ── WinSW ───────────────────────────────────────────────────────────────
if (-not $WinSwPath) {
    $local = Get-ChildItem -Path $Here -Filter 'WinSW*.exe' -File -ErrorAction SilentlyContinue |
             Select-Object -First 1
    if ($local) { $WinSwPath = $local.FullName }
}
if (-not $WinSwPath -or -not (Test-Path -LiteralPath $WinSwPath)) {
    throw @'
WinSW not found. Download WinSW-x64.exe from
https://github.com/winsw/winsw/releases, put it beside this script, and re-run.
It is a service wrapper, not something we ship — keeping it separate means you
can update it without waiting for us.
'@
}

# ── Directories ─────────────────────────────────────────────────────────
$configDir = Join-Path $InstallDir 'config'
$backupDir = Join-Path $InstallDir 'backups'
foreach ($dir in @($InstallDir, $configDir, $backupDir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

# ── Stop before swapping ────────────────────────────────────────────────
#
# Replacing a binary under a live process is how you get a half-updated server
# nobody can explain. Windows will also simply refuse the copy.
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
$wasRunning = $false
if ($existing -and $existing.Status -eq 'Running') {
    Write-Host '==> stopping the service for the swap'
    Stop-Service -Name $ServiceName -Force
    $existing.WaitForStatus('Stopped', '00:00:30')
    $wasRunning = $true
}

# ── Binaries ────────────────────────────────────────────────────────────
$serverTarget = Join-Path $InstallDir 'store-server.exe'
if (Test-Path -LiteralPath $serverTarget) {
    # Keep the previous binary, exactly as the OTA updater does, so a rollback
    # is one rename either way.
    Move-Item -LiteralPath $serverTarget -Destination "$serverTarget.old" -Force
}
Copy-Item -LiteralPath $serverBin -Destination $serverTarget -Force
Copy-Item -LiteralPath $cliBin -Destination (Join-Path $InstallDir 'store-cli.exe') -Force

$wrapperExe = Join-Path $InstallDir 'store-server-service.exe'
$wrapperXml = Join-Path $InstallDir 'store-server-service.xml'
Copy-Item -LiteralPath $WinSwPath -Destination $wrapperExe -Force

# ── Configuration ───────────────────────────────────────────────────────
$envFile = Join-Path $configDir 'server.env'
$needsConfig = $false
if (-not (Test-Path -LiteralPath $envFile)) {
    Write-Host "==> writing $envFile"
    # A generated secret beats a placeholder somebody forgets to change.
    $bytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })

    @"
# ElectronIx Tool Store — server configuration.
#
# Changed anything here? Restart-Service $ServiceName

# Postgres. Create the database and role yourself; this file only points at it.
DATABASE_URL=postgres://electronix:CHANGE_ME@localhost/electronix_store

# What the door terminal pushes to, and what the tablets talk to. One port for
# both — the terminal is configured with a single server address.
STORE_LISTEN=0.0.0.0:8080

# Typed once on each phone or tablet during setup. Anyone with this can enrol a
# terminal, so treat it like a password.
STORE_ENROLMENT_SECRET=$secret

RUST_LOG=info,sqlx=warn
"@ | Set-Content -LiteralPath $envFile -Encoding UTF8

    # The enrolment secret lives here: Administrators and SYSTEM only.
    $acl = Get-Acl -LiteralPath $envFile
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($who in 'BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM') {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            $who, 'FullControl', 'Allow'))
    }
    Set-Acl -LiteralPath $envFile -AclObject $acl

    $needsConfig = $true
} else {
    Write-Host "==> keeping the existing $envFile"
}

# WinSW reads env vars from its XML, so the .env file is parsed into it here.
$envLines = Get-Content -LiteralPath $envFile |
    Where-Object { $_ -match '^\s*[A-Z_]+\s*=' } |
    ForEach-Object {
        $name, $value = $_ -split '=', 2
        "    <env name=""$($name.Trim())"" value=""$([System.Security.SecurityElement]::Escape($value.Trim()))"" />"
    }

@"
<service>
  <id>$ServiceName</id>
  <name>ElectronIx Tool Store</name>
  <description>Tool-crib server: ADMS door listener, REST/SSE API and the web terminal.</description>
  <executable>$serverTarget</executable>
  <workingdirectory>$InstallDir</workingdirectory>

$($envLines -join "`n")

  <!-- A tool crib that cannot record an issue is one nobody trusts, so it
       comes back rather than staying down. -->
  <onfailure action="restart" delay="5 sec" />
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <resetfailure>1 hour</resetfailure>

  <!-- Let in-flight requests finish. An ADMS push cut off mid-persist would be
       retried by the device (§9.1), but a clean stop is one fewer duplicate to
       reason about. -->
  <stoptimeout>30 sec</stoptimeout>

  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>

  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
</service>
"@ | Set-Content -LiteralPath $wrapperXml -Encoding UTF8

# ── Service ─────────────────────────────────────────────────────────────
if ($existing) {
    Write-Host '==> refreshing the service definition'
    & $wrapperExe uninstall | Out-Null
    Start-Sleep -Seconds 2
}
Write-Host '==> installing the service'
& $wrapperExe install
if ($LASTEXITCODE -ne 0) { throw "WinSW install failed with exit code $LASTEXITCODE" }

# ── Nightly backup (M9) ─────────────────────────────────────────────────
#
# A scheduled task rather than a second service: it runs once a night and exits,
# which is what Task Scheduler is for.
Write-Host '==> scheduling the nightly backup'
$taskName = 'ElectronIx Tool Store backup'
$action = New-ScheduledTaskAction `
    -Execute (Join-Path $InstallDir 'store-cli.exe') `
    -Argument "backup --out-dir `"$backupDir`" --keep 14" `
    -WorkingDirectory $InstallDir
# 02:15, not 02:00: every other nightly job on the machine fires on the hour.
$trigger = New-ScheduledTaskTrigger -Daily -At '02:15'
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null

# ── Start ───────────────────────────────────────────────────────────────
if ($needsConfig) {
    Write-Host ''
    Write-Host '==> Almost there.'
    Write-Host ''
    Write-Host "    Edit $envFile and set DATABASE_URL, then:"
    Write-Host ''
    Write-Host "        Start-Service $ServiceName"
    Write-Host ''
    Write-Host '    The server migrates the database on boot, so there is no separate step.'
} elseif (-not $NoStart -or $wasRunning) {
    Write-Host '==> starting the service'
    Start-Service -Name $ServiceName
    Start-Sleep -Seconds 3
    $svc = Get-Service -Name $ServiceName
    if ($svc.Status -ne 'Running') {
        throw "The service did not start. Check $InstallDir\store-server-service.wrapper.log and .err.log"
    }
    Write-Host '==> running'
}

Write-Host ''
Write-Host "Installed to $InstallDir"
Write-Host "  config   $envFile"
Write-Host "  backups  $backupDir (nightly at 02:15, kept 14 days)"
Write-Host ''
Write-Host 'Next:'
Write-Host '  Terminal   open http://<this-machine>:8080 on a phone and enrol it with'
Write-Host '             STORE_ENROLMENT_SECRET from the config file'
Write-Host '  Door       point the terminal ADMS server address at this machine, port 8080'
Write-Host "  Check      $InstallDir\store-cli.exe reconcile"
Write-Host "  Updates    $InstallDir\store-cli.exe update --check    (see OTA-SETUP.md)"
Write-Host "  Logs       $InstallDir\store-server-service.wrapper.log"
