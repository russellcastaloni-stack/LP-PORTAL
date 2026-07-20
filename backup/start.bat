@echo off
title Launchpad Portal
echo.
echo  ============================================
echo    Launchpad Portal - Starting up
echo  ============================================
echo.

REM ── Load .env file (kept for the pre-flight checks below; server.js also
REM    loads .env itself via dotenv, so this isn't required for the app to
REM    get its config, only for this script's own sanity checks) ───────────
set "ENVFILE=%~dp0.env"

if not exist "%ENVFILE%" (
    echo  [ERROR] .env file not found: %ENVFILE%
    pause
    exit /b 1
)

echo  [INFO] Loading .env...

for /f "usebackq tokens=1,* delims==" %%A in ("%ENVFILE%") do (
    if not "%%A"=="" (
        if not "%%A:~0,1%"=="#" (
            set "%%A=%%B"
        )
    )
)

REM ── Validate required vars ───────────────────────────────────────────────────
if "%ADMIN_PASSWORD%"=="" (
    echo  [ERROR] ADMIN_PASSWORD is not set in .env
    pause
    exit /b 1
)
if "%PIN_SALT%"=="" (
    echo  [ERROR] PIN_SALT is not set in .env
    pause
    exit /b 1
)

echo  [OK] Environment loaded.
echo.

REM ── Check Node.js ────────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js not found. Install from https://nodejs.org ^(v18+^)
    pause
    exit /b 1
)
for /f "tokens=*" %%V in ('node -v') do echo  [OK] Node.js %%V found

REM ── Check server.js ──────────────────────────────────────────────────────────
if not exist "%~dp0server.js" (
    echo  [ERROR] server.js not found in: %~dp0
    pause
    exit /b 1
)
echo  [OK] server.js found
echo.

REM ── Ensure pm2 is installed ───────────────────────────────────────────────────
REM pm2 is a process manager: it auto-restarts server.js/cloudflared if either
REM crashes, and (via pm2-windows-startup) auto-resurrects both after a
REM Windows reboot. This replaces the old "two cmd /k windows" setup, which
REM had no recovery if either process died or the machine restarted (audit
REM 2026-07 ops review).
where pm2 >nul 2>&1
if errorlevel 1 (
    echo  [INFO] pm2 not found — installing pm2 + pm2-windows-startup globally...
    echo  [INFO] ^(if this fails, re-run this script as Administrator^)
    call npm install -g pm2 pm2-windows-startup
    if errorlevel 1 (
        echo  [ERROR] Failed to install pm2. Re-run this script as Administrator.
        pause
        exit /b 1
    )
    call pm2-startup install
    echo  [OK] pm2 will now auto-launch saved processes after a Windows restart.
    echo.
)

cd /d "%~dp0"

REM ── [1/2] Start/restart Node server under pm2 ────────────────────────────────
echo  [1/2] Starting Node server under pm2...
call pm2 describe launchpad-portal >nul 2>&1
if errorlevel 1 (
    call pm2 start server.js --name launchpad-portal --max-restarts 50 --restart-delay 3000
) else (
    call pm2 restart launchpad-portal
)
echo  [OK] Node server running under pm2.
echo.

REM ── [2/2] Start/restart Cloudflare named tunnel under pm2 ────────────────────
echo  [2/2] Starting Cloudflare Tunnel under pm2...
call pm2 describe launchpad-tunnel >nul 2>&1
if errorlevel 1 (
    call pm2 start "%~dp0cloudflared-windows-386.exe" --name launchpad-tunnel -- tunnel --config "%~dp0config.yml" run launchpad-portal
) else (
    call pm2 restart launchpad-tunnel
)
echo  [OK] Cloudflare tunnel running under pm2.
echo.

REM Persist the process list so pm2-windows-startup can revive both of these
REM specific processes (with these exact args) after a reboot.
call pm2 save

echo  ============================================
echo   Portal: https://portal.launchpadph.com
echo  ============================================
echo.
echo  Both services are now managed by pm2:
echo    - Auto-restart on crash (up to 50 restarts, 3s apart)
echo    - Auto-resurrect on Windows reboot (via pm2-windows-startup)
echo.
echo  Useful commands (run from any cmd window):
echo    pm2 status         - check if both services are running
echo    pm2 logs           - view live logs from both
echo    pm2 restart all    - restart both services
echo    pm2 stop all       - stop both services
echo    pm2 monit          - live CPU/memory dashboard
echo.
pause
