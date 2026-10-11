@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Gemini Overlay einrichten

rem Prozessor erkennen (ARM64-Laptops wie Snapdragon brauchen eine eigene Variante)
set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=arm64"
echo Prozessor: %ARCH%

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js fehlt. Installiere Node.js LTS ueber winget ...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo.
    echo Bitte Node.js LTS von https://nodejs.org installieren und diese Datei erneut starten.
    pause
    exit /b 1
  )
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
)

echo.
echo [1/3] Lade Bausteine herunter (einmalig, ein paar Minuten) ...
if exist node_modules\electron\dist rmdir /s /q node_modules\electron\dist
call npm install --no-audit --no-fund --arch=%ARCH%
if errorlevel 1 goto fehler

echo.
echo [2/3] Baue GeminiOverlay.exe fuer %ARCH% ...
if exist dist rmdir /s /q dist
call npx electron-builder --win portable --%ARCH%
if errorlevel 1 goto fehler

set "EXE="
for %%F in (dist\GeminiOverlay-*-portable.exe) do set "EXE=%%F"
if not defined EXE goto fehler

echo.
echo [3/3] Kopiere nach %LOCALAPPDATA%\GeminiOverlay und starte ...
taskkill /im GeminiOverlay.exe /f >nul 2>nul
if not exist "%LOCALAPPDATA%\GeminiOverlay" mkdir "%LOCALAPPDATA%\GeminiOverlay"
copy /b /y "%EXE%" "%LOCALAPPDATA%\GeminiOverlay\GeminiOverlay.exe" >nul
if errorlevel 1 goto fehler
start "" "%LOCALAPPDATA%\GeminiOverlay\GeminiOverlay.exe"
echo.
echo Fertig. Gemini Overlay laeuft jetzt (Symbol unten rechts in der Taskleiste).
timeout /t 8
exit /b 0

:fehler
echo.
echo Da ist etwas schiefgegangen. Bitte einen Screenshot von diesem Fenster in den Chat schicken.
pause
exit /b 1
