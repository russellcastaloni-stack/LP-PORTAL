@echo off
setlocal EnableExtensions DisableDelayedExpansion

REM ── Re-launch inside a persistent, ELEVATED cmd /k window if double-clicked ──
REM   pm2's global install step below needs admin rights on a fresh machine,
REM   and a freshly-edited PATH isn't always picked up by non-elevated
REM   sessions until sign-out/reboot — launching elevated from the start
REM   avoids both. This triggers one UAC prompt on every launch.
REM   Using a throwaway VBS ShellExecute instead of PowerShell -ArgumentList:
REM   PowerShell's argument array mangled this exact path ("C:\1. LP
REM   PORTAL\root" has a space right after "1."), silently truncating it to
REM   "C:\1." — VBS passes the whole "/k ... --launched" as one string, which
REM   cmd.exe then parses normally, quotes and all.
if "%~1"=="--launched" goto :checkAdmin
set "ELEVATE_VBS=%temp%\lp_elevate_%RANDOM%.vbs"
echo On Error Resume Next > "%ELEVATE_VBS%"
echo Set UAC = CreateObject("Shell.Application") >> "%ELEVATE_VBS%"
echo UAC.ShellExecute "cmd.exe", "/k ""%~f0"" --launched", "", "runas", 1 >> "%ELEVATE_VBS%"
REM   On Error Resume Next above: if the UAC prompt gets cancelled/denied,
REM   ShellExecute raises a VBS runtime error — without this, cscript pops
REM   up its own error dialog, which is more confusing than just quietly
REM   doing nothing (the original non-elevated window already closed either
REM   way, so denying just means no window opens — same as changing your
REM   mind and closing the prompt).
cscript //nologo "%ELEVATE_VBS%"
del "%ELEVATE_VBS%" >nul 2>&1
exit /b

:checkAdmin
net session >nul 2>&1
if not "%errorlevel%"=="0" (
    echo  [ERROR] Not running as Administrator, and elevation failed or was
    echo          cancelled. Right-click the startup script and choose
    echo          "Run as administrator" instead.
    goto :done
)

:main
title Launchpad Portal
echo.
echo  ============================================
echo    Launchpad Portal - Starting up
echo  ============================================
echo.

REM ── Load .env (only extract the two vars this script needs for checks) ────────
set "ENVFILE=%~dp0.env"
if not exist "%ENVFILE%" (
    echo  [ERROR] .env file not found: %ENVFILE%
    goto :done
)

echo  [INFO] Loading .env...

REM    Read line-by-line with findstr to avoid cmd special-char issues.
REM    We only need ADMIN_PASSWORD and PIN_SALT for the pre-flight check;
REM    server.js loads the full .env itself via dotenv.
for /f "usebackq delims=" %%L in (`findstr /b "ADMIN_PASSWORD= PIN_SALT=" "%ENVFILE%"`) do (
    set "LINE=%%L"
    call :parseline "%%L"
)
goto :afterparse

:parseline
REM    Split on first = only, discard everything after for safety
set "_raw=%~1"
for /f "tokens=1,2* delims==" %%K in ("%_raw%") do (
    if "%%K"=="ADMIN_PASSWORD" set "ADMIN_PASSWORD=%%L"
    if "%%K"=="PIN_SALT"       set "PIN_SALT=%%L"
)
exit /b

:afterparse

REM ── Validate required vars ────────────────────────────────────────────────────
if "%ADMIN_PASSWORD%"=="" (
    echo  [ERROR] ADMIN_PASSWORD not set in .env
    goto :done
)
if "%PIN_SALT%"=="" (
    echo  [ERROR] PIN_SALT not set in .env
    goto :done
)
echo  [OK] Environment loaded.
echo.

REM ── Check Node.js ────────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js not found. Install from https://nodejs.org
    goto :done
)
for /f "tokens=*" %%V in ('node -v') do echo  [OK] Node.js %%V found

REM ── Check server.js ──────────────────────────────────────────────────────────
if not exist "%~dp0server.js" (
    echo  [ERROR] server.js not found in %~dp0
    goto :done
)
echo  [OK] server.js found
echo.

REM ── Resolve npm global bin folder ────────────────────────────────────────────
for /f "tokens=*" %%P in ('npm config get prefix') do set "NPM_PREFIX=%%P"
set "PM2_EXE=%NPM_PREFIX%\pm2.cmd"

REM ── Make `pm2` work from any terminal, no PATH edits needed ─────────────────
REM   A per-user PATH edit only takes effect for brand-new sessions (sign-out
REM   or reboot) — it does nothing for an already-running Explorer session,
REM   which is what every new cmd window inherits its environment from. That
REM   caching is what's been blocking `pm2` from being recognized even after
REM   editing PATH. C:\Windows has none of that problem — it's on every
REM   process's PATH unconditionally from boot — so a tiny forwarding file
REM   dropped there makes `pm2 ...` work immediately, in any window, with no
REM   sign-out/reboot ever needed. Rewritten on every launch so it always
REM   points at the current NPM_PREFIX.
echo @echo off > "%WINDIR%\pm2.bat"
echo call "%PM2_EXE%" %%* >> "%WINDIR%\pm2.bat"

REM ── Install pm2 if missing ───────────────────────────────────────────────────
if not exist "%PM2_EXE%" (
    echo  [INFO] pm2 not found - installing globally...
    echo  [INFO] Re-run as Administrator if this step fails.
    call npm install -g pm2 pm2-windows-startup
    if errorlevel 1 (
        echo  [ERROR] npm install failed. Re-run as Administrator.
        goto :done
    )
    echo  [OK] pm2 installed.
    call "%NPM_PREFIX%\pm2-windows-startup.cmd" install
    echo  [OK] pm2 registered for auto-start on Windows reboot.
    echo.
)

cd /d "%~dp0"

REM ── [1/2] Node server ────────────────────────────────────────────────────────
echo  [1/2] Starting Node server under pm2...
call "%PM2_EXE%" describe launchpad-portal >nul 2>&1
if errorlevel 1 (
    call "%PM2_EXE%" start server.js --name launchpad-portal --max-restarts 50 --restart-delay 3000
) else (
    call "%PM2_EXE%" restart launchpad-portal
)
echo  [OK] Node server running.
echo.

REM ── [2/2] Cloudflare tunnel ──────────────────────────────────────────────────
echo  [2/2] Starting Cloudflare Tunnel under pm2...
call "%PM2_EXE%" describe launchpad-tunnel >nul 2>&1
if errorlevel 1 (
    call "%PM2_EXE%" start "%~dp0cloudflared-windows-386.exe" --name launchpad-tunnel -- tunnel --config "%~dp0config.yml" run launchpad-portal
) else (
    call "%PM2_EXE%" restart launchpad-tunnel
)
echo  [OK] Cloudflare tunnel running.
echo.

call "%PM2_EXE%" save

echo  ============================================
echo   Portal: https://portal.launchpadph.com
echo  ============================================
echo.
echo  Both services managed by pm2:
echo    - Auto-restart on crash  (up to 50x, 3s apart)
echo    - Auto-resurrect on reboot
echo.
echo  Useful commands:
echo    pm2 status      - check both services
echo    pm2 logs        - live logs
echo    pm2 restart all - restart both
echo    pm2 stop all    - stop both
echo    pm2 monit       - CPU/memory dashboard
echo.

:done
echo  Window will stay open. Type EXIT to close.
endlocal
