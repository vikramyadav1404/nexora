@echo off
title Nexora v1.0
cd /d "%~dp0"

echo.
echo  ========================================
echo   Nexora - starting backend + frontend
echo  ========================================
echo.

if not exist "server\node_modules\" (
  echo Installing server packages...
  cd server && call npm install && cd ..
)
if not exist "client\node_modules\" (
  echo Installing client packages...
  cd client && call npm install && cd ..
)

echo Starting API on http://127.0.0.1:5000 ...
start "Nexora-API" cmd /k "cd /d %~dp0server && node index.js"

timeout /t 2 /nobreak >nul

echo Starting UI on http://127.0.0.1:5173 ...
start "Nexora-UI" cmd /k "cd /d %~dp0client && npx vite --host 127.0.0.1 --port 5173"

echo.
echo  Open:  http://127.0.0.1:5173
echo.
echo  Demo login (if DEMO_MODE / no Supabase keys):
echo    demo@nexora.com  /  demo1234
echo.
echo  Real backend: set SUPABASE keys + DEMO_MODE=false in server\.env
echo  See: STEP_A_SUPABASE.md  and  V1_COMPLETE.md
echo.
pause
