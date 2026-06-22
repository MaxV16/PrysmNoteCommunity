# Prysm Note Setup Script — run once to prepare environment

Write-Host "=== Prysm Note Setup ===" -ForegroundColor Cyan

$rootDir = Split-Path -Parent $PSScriptRoot
Set-Location $rootDir

# 1. Install backend dependencies
Write-Host "[1/3] Setting up backend..." -ForegroundColor Yellow
Set-Location apps/backend
pip install -e . 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  pip install failed — run manually: pip install -e apps/backend" -ForegroundColor Red
} else {
    Write-Host "  Done" -ForegroundColor Green
}
Set-Location $rootDir

# 2. Install frontend dependencies
Write-Host "[2/3] Installing frontend dependencies..." -ForegroundColor Yellow
npm install 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  npm install failed — run manually: cd apps/frontend && npm install" -ForegroundColor Red
} else {
    Write-Host "  Done" -ForegroundColor Green
}

# 3. Check .env
Write-Host "[3/3] Checking configuration..." -ForegroundColor Yellow
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Host "  Created .env from .env.example — edit it with your secrets before running." -ForegroundColor Yellow
    } else {
        Write-Host "  .env and .env.example both missing — create .env manually." -ForegroundColor Red
    }
} else {
    Write-Host "  .env exists" -ForegroundColor Green
}

Write-Host "`n=== Setup Complete ===" -ForegroundColor Cyan
Write-Host "Start the app:" -ForegroundColor Green
Write-Host "  docker-compose up               (full stack, recommended)" -ForegroundColor White
Write-Host "  scripts\launch.ps1              (local dev, requires PostgreSQL)" -ForegroundColor White
Write-Host "  scripts\launch.ps1 -Docker      (docker alias)" -ForegroundColor White
