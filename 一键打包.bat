@echo off
chcp 65001 >nul 2>&1
title DouyinLiveRecorder - Build
color 0A

echo ============================================
echo   DouyinLiveRecorder - One-click Build
echo   Stream recording + Comment overlay
echo ============================================
echo.

:: Step 1: Check Node.js
echo [1/5] Checking Node.js ...
where node >nul 2>&1
if %errorlevel% neq 0 goto :no_node
for /f "tokens=1 delims=v" %%a in ('node -v') do set NODE_VER=%%a
echo       Node.js %NODE_VER% found
goto :check_pnpm

:no_node
echo [ERROR] Node.js not found!
echo Please install Node.js v18+: https://nodejs.org/
pause
exit /b 1

:: Step 2: Check pnpm
:check_pnpm
echo [2/5] Checking pnpm ...
where pnpm >nul 2>&1
if %errorlevel% neq 0 goto :install_pnpm
echo       pnpm found
goto :install_deps

:install_pnpm
echo       Installing pnpm ...
call npm install -g pnpm
if %errorlevel% neq 0 (
    echo [ERROR] pnpm install failed. Please run: npm install -g pnpm
    pause
    exit /b 1
)
:: Refresh PATH - add npm global bin to PATH
for /f "tokens=*" %%i in ('npm config get prefix') do set "PATH=%%i;%PATH%"
echo       pnpm installed

:: Step 3: Install dependencies
:install_deps
echo [3/5] Installing dependencies ...
call npx pnpm install
if %errorlevel% neq 0 (
    echo [ERROR] Dependencies install failed!
    pause
    exit /b 1
)
echo       Dependencies installed

:: Step 4: Build
echo [4/5] Building Windows EXE ...
echo       This may take 5-10 minutes, please wait...
echo.
call npx electron-builder --win --x64
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Build failed! Check errors above.
    echo Common issues:
    echo   1. Network: Check GitHub access
    echo   2. Antivirus: Temporarily disable and retry
    echo   3. Disk space: Need 2GB+ free space
    pause
    exit /b 1
)

:: Step 5: Done
echo.
echo [5/5] Build complete!
echo ============================================
echo.

if exist "dist\win-unpacked\DouyinLiveRecorder.exe" (
    echo Output: dist\win-unpacked\
    echo Run: dist\win-unpacked\DouyinLiveRecorder.exe
    echo.
    echo Opening output folder...
    start explorer "%~dp0dist\win-unpacked"
    goto :done
)

if exist "dist\*.exe" (
    echo Installer:
    dir /b dist\*.exe 2>nul
    echo.
    echo Opening output folder...
    start explorer "%~dp0dist"
    goto :done
)

echo [WARN] No output found. Check build errors.
goto :done

:done
echo.
echo ============================================
echo   Build finished!
echo ============================================
pause
