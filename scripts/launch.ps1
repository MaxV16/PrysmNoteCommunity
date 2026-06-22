# Prysm Note Launcher
# Starts both backend (uvicorn) and frontend (next dev) for local development.
# Requires PostgreSQL 16 + pgvector running on localhost:5432.

param(
    [switch]$Docker
)

Write-Host "=== Prysm Note Launcher ===" -ForegroundColor Cyan

$rootDir = Split-Path -Parent $PSScriptRoot
Set-Location $rootDir

if ($Docker) {
    Write-Host "Starting via Docker Compose..." -ForegroundColor Yellow
    docker-compose up
    return
}

# Check prerequisites
$hasPython = python --version 2>$null
if (-not $hasPython) {
    Write-Host "ERROR: Python not found. Install Python 3.11+." -ForegroundColor Red
    exit 1
}

$hasNode = node --version 2>$null
if (-not $hasNode) {
    Write-Host "ERROR: Node.js not found. Install Node.js 20+." -ForegroundColor Red
    exit 1
}

Write-Host "  Python: $(python --version)" -ForegroundColor Green
Write-Host "  Node:   $(node --version)" -ForegroundColor Green

# Start backend
Write-Host "`nStarting backend (port 8000)..." -ForegroundColor Yellow
$backendJob = Start-Job -ScriptBlock {
    param($dir)
    Set-Location "$dir/apps/backend"
    uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
} -ArgumentList $rootDir

Start-Sleep -Seconds 3

# Start frontend
Write-Host "Starting frontend (port 3000)..." -ForegroundColor Yellow
$frontendJob = Start-Job -ScriptBlock {
    param($dir)
    Set-Location "$dir/apps/frontend"
    npm run dev
} -ArgumentList $rootDir

Write-Host "`n=== Prysm Note is starting ===" -ForegroundColor Cyan
Write-Host "  Frontend: http://localhost:3000" -ForegroundColor Green
Write-Host "  Backend:  http://localhost:8000/api/health" -ForegroundColor Green
Write-Host "  API docs: http://localhost:8000/docs" -ForegroundColor Green
Write-Host "`nPress Ctrl+C to stop all services." -ForegroundColor Yellow

try {
    while ($true) { Start-Sleep -Seconds 1 }
} finally {
    Write-Host "`nShutting down..." -ForegroundColor Yellow
    if ($backendJob) { Stop-Job $backendJob -ErrorAction SilentlyContinue; Remove-Job $backendJob -ErrorAction SilentlyContinue }
    if ($frontendJob) { Stop-Job $frontendJob -ErrorAction SilentlyContinue; Remove-Job $frontendJob -ErrorAction SilentlyContinue }
    Write-Host "Done." -ForegroundColor Green
}
