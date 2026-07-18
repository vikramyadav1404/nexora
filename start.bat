@echo off
title Nexora - Starting...
color 0A
echo.
echo  ======================================================
echo     NEXORA - Community Platform
echo  ======================================================
echo.

cd /d "%~dp0"

echo  [1/2] Starting Backend (Express + Supabase)...
start "Nexora Backend" cmd /k "cd /d %~dp0server && echo Starting Nexora Backend... && npm run dev"
timeout /t 3 /nobreak >nul

echo  [2/2] Starting Frontend (React + Vite)...
start "Nexora Frontend" cmd /k "cd /d %~dp0client && echo Starting Nexora Frontend... && npm run dev"
timeout /t 4 /nobreak >nul

echo.
echo  ======================================================
echo   Nexora is starting up!
echo.
echo   Frontend:  http://localhost:5173
echo   Backend:   http://localhost:5000
echo   API Test:  http://localhost:5000/api/health
echo.
echo   Real mode: set SUPABASE keys + DEMO_MODE=false in server\.env
echo   Run SQL:   server\db\setup_step_a.sql in Supabase SQL Editor
echo   Verify:    cd server ^&^& npm run verify:supabase
echo  ======================================================
echo.
echo  Opening browser in 3 seconds...
timeout /t 3 /nobreak >nul
start http://localhost:5173
echo.
echo  Press any key to close this launcher...
pause >nul
