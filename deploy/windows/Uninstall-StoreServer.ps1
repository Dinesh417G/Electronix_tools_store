<#
.SYNOPSIS
    Remove the ElectronIx Tool Store service from a Windows server PC.

.DESCRIPTION
    Deliberately leaves the database, the config and the backups alone.
    Removing the software is not the same decision as destroying the shop's
    inventory history, and a script that conflates them is one that will
    eventually be run in a hurry.
#>

[CmdletBinding()]
param([string]$InstallDir = 'C:\ElectronIx\ToolStore')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ServiceName = 'ElectronIxToolStore'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell (Run as Administrator).'
}

$wrapper = Join-Path $InstallDir 'store-server-service.exe'

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-Host '==> stopping and removing the service'
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $wrapper) {
        & $wrapper uninstall | Out-Null
    } else {
        sc.exe delete $ServiceName | Out-Null
    }
}

Write-Host '==> removing the scheduled backup'
Unregister-ScheduledTask -TaskName 'ElectronIx Tool Store backup' `
    -Confirm:$false -ErrorAction SilentlyContinue

Write-Host '==> removing binaries'
foreach ($name in 'store-server.exe', 'store-server.exe.old', 'store-cli.exe',
                  'store-server-service.exe', 'store-server-service.xml') {
    Remove-Item -LiteralPath (Join-Path $InstallDir $name) -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Removed the service and its binaries.'
Write-Host ''
Write-Host 'Left alone, on purpose:'
Write-Host "  $InstallDir\config    (your enrolment secret and database URL)"
Write-Host "  $InstallDir\backups   (the shop's inventory history)"
Write-Host '  the PostgreSQL database itself'
Write-Host ''
Write-Host 'Delete those by hand if you really mean to. Take a final backup first:'
Write-Host "  $InstallDir\store-cli.exe backup --out-dir C:\final-backup"
