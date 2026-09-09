@echo off
chcp 65001 >nul
title 抖音直播录制工具V2 - 环境准备
echo ===============================================
echo   抖音直播录制工具V2 - 环境准备工具
echo   本脚本将自动安装 Node.js 和 pnpm 环境
echo ===============================================
echo.

rem 检查 Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [提示] 未检测到 Node.js，请手动下载安装：
    echo   https://nodejs.org/zh-cn/download  （选择 LTS 版本，勾选"安装 npm"）
    echo.
    echo 安装完成后，重新运行本脚本即可。
    pause
    exit /b 1
)

echo [√] Node.js 已安装：node %~dp0
for /f "delims=" %%v in ('node -v') do echo      当前版本 %%v

rem 检查 pnpm
where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo [*] 未检测到 pnpm，正在安装 (npm install -g pnpm)...
    call npm install -g pnpm
    if %errorlevel% neq 0 (
        echo [失败] pnpm 安装失败，请检查网络。
        pause
        exit /b 1
    )
)

for /f "delims=" %%v in ('pnpm -v') do echo [√] pnpm 已安装，版本 %%v

echo.
echo ===============================================
echo   环境准备完成！
echo   接下来请运行:  build.bat   进行一键打包
echo   或运行:        pnpm run dev     启动开发调试
echo ===============================================
pause