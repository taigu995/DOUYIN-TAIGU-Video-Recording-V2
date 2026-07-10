@echo off
chcp 65001 >nul
title 修复 bitbrowser 协议弹窗

echo ============================================
echo  修复 "需要使用新应用以打开此bitbrowser链接" 弹窗
echo ============================================
echo.

:: 检查管理员权限
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [错误] 请以管理员身份运行此脚本！
    echo 右键点击此文件 -^> 以管理员身份运行
    pause
    exit /b 1
)

echo [1/4] 删除注册表中的 bitbrowser 协议...
reg delete "HKEY_CURRENT_USER\Software\Classes\bitbrowser" /f >nul 2>&1
reg delete "HKEY_LOCAL_MACHINE\Software\Classes\bitbrowser" /f >nul 2>&1
echo       完成

echo [2/4] 检查启动文件夹...
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "FOUND_STARTUP=0"
for %%f in ("%STARTUP%\*bitbrowser*") do (
    echo       发现: %%f
    del "%%f" /f >nul 2>&1
    echo       已删除
    set "FOUND_STARTUP=1"
)
if "%FOUND_STARTUP%"=="0" echo       未发现 bitbrowser 相关启动项

echo [3/4] 检查系统启动文件夹...
set "SYS_STARTUP=%ProgramData%\Microsoft\Windows\Start Menu\Programs\Startup"
set "FOUND_SYS_STARTUP=0"
for %%f in ("%SYS_STARTUP%\*bitbrowser*") do (
    echo       发现: %%f
    del "%%f" /f >nul 2>&1
    echo       已删除
    set "FOUND_SYS_STARTUP=1"
)
if "%FOUND_SYS_STARTUP%"=="0" echo       未发现 bitbrowser 相关启动项

echo [4/4] 检查计划任务...
set "FOUND_TASK=0"
for /f "tokens=1" %%t in ('schtasks /query /fo LIST 2^>nul ^| findstr /i "bitbrowser"') do (
    echo       发现任务: %%t
    schtasks /delete /tn "%%t" /f >nul 2>&1
    echo       已删除
    set "FOUND_TASK=1"
)
if "%FOUND_TASK%"=="0" echo       未发现 bitbrowser 相关计划任务

echo.
echo ============================================
echo  修复完成！请重启电脑使更改生效。
echo ============================================
echo.
pause
