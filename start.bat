@echo off
title Prysm Note
cd /d "%~dp0"

echo === Prysm Note ===
echo.

where docker-compose >nul 2>nul
if %ERRORLEVEL% equ 0 (
    docker info >nul 2>nul
    if %ERRORLEVEL% equ 0 goto docker_path
)

echo Starting local dev servers...
echo.

python --version >nul 2>nul
if %ERRORLEVEL% neq 0 echo ERROR: Python not found && pause && exit /b 1

node --version >nul 2>nul
if %ERRORLEVEL% neq 0 echo ERROR: Node.js not found && pause && exit /b 1

if not exist "node_modules" (
    echo Installing backend dependencies...
    pushd apps\backend
    pip install -e .
    popd
    if %ERRORLEVEL% neq 0 echo WARNING: pip install failed
    echo Installing frontend dependencies...
    npm install
)

if not exist ".env" (
    if exist ".env.example" (
        copy .env.example .env >nul
        echo Created .env from .env.example
    )
)

echo Starting backend (port 8000)...
start "Prysm Backend" cmd /c "cd /d apps\backend && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"
timeout /t 3 /nobreak >nul

echo Starting frontend (port 3000)...
start "Prysm Frontend" cmd /c "cd /d apps\frontend && npm run dev"

echo.
echo Waiting for frontend to be ready...
:wait_frontend
curl -s -o NUL http://localhost:3000 2>nul
if %ERRORLEVEL% neq 0 (
    timeout /t 2 /nobreak >nul
    goto wait_frontend
)

start http://localhost:3000
echo.
echo Backend and frontend starting in separate windows.
echo Close those windows to stop the servers.
echo.
pause
exit /b 0

:docker_path
echo Starting with Docker Compose...
if not exist ".env" (
    if exist ".env.example" (
        copy .env.example .env >nul
        echo Created .env from .env.example
    )
)
start "Prysm Docker" cmd /c "docker-compose up"

echo Waiting for services to be ready...
:wait_docker
curl -s -o NUL http://localhost:3000 2>nul
if %ERRORLEVEL% neq 0 (
    timeout /t 2 /nobreak >nul
    goto wait_docker
)

start http://localhost:3000
echo.
echo Docker Compose starting in a separate window.
echo Close the Docker window to stop the services.
echo.
