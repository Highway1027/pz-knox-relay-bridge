# scripts/build.ps1
# v1 - 23-09-2026 - Build and test the Bridge

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
npm test
