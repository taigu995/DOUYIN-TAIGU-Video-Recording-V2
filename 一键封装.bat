@echo off
:: ============================================================
::  Douyin Live Recorder - One-click Build Launcher
::  This BAT only launches the PowerShell build script
:: ============================================================

:: Check PowerShell availability
where powershell >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] PowerShell not found! Windows 10+ includes PowerShell by default.
    echo Please update your system.
    pause
    exit /b 1
)

:: Get script directory
set "SCRIPT_DIR=%~dp0"

:: Launch PowerShell build script with execution policy bypass
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%build.ps1"

:: If PowerShell script fails, pause to show error
if %ERRORLEVEL% neq 0 (
    echo.
    echo Build failed. Check build_log.txt for details.
    pause
)
