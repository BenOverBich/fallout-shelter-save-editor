@echo off
rem Local launcher: builds the app when the code changed, serves it on this PC only,
rem and opens it in the browser. Nothing leaves the machine. Close this window to stop.
setlocal
title Fallout Shelter Save Editor (close this window to stop)
cd /d "%~dp0"
set "PORT=4317"

if not exist node_modules (
  echo Installing dependencies, first run only...
  call corepack pnpm install --frozen-lockfile || goto :fail
)

rem Rebuild only when the checked-out commit differs from the one dist was built from.
set "REV=unknown"
for /f %%i in ('git rev-parse HEAD 2^>nul') do set "REV=%%i"
set "BUILT="
if exist "dist\.built-rev" set /p BUILT=<"dist\.built-rev"
if not exist "dist\index.html" set "BUILT="
if not "%BUILT%"=="%REV%" (
  echo Building the app...
  call corepack pnpm run build || goto :fail
  >"dist\.built-rev" echo %REV%
)

echo Serving on http://localhost:%PORT%  (this PC only)
call corepack pnpm exec vite preview --host 127.0.0.1 --port %PORT% --strictPort --open
rem Reaching here straight away means the port is taken: the app is already running.
start "" "http://localhost:%PORT%"
exit /b 0

:fail
echo.
echo Something went wrong starting the editor. The message above says what.
pause
exit /b 1
