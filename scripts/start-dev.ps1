# scripts/start-dev.ps1
# v1 - 23-09-2026 - Start the Bridge in TypeScript development mode

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
npm run dev
