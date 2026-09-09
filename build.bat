@echo off
chcp 65001 >nul
title 抖音直播录制工具V2 - 一键打包 (NSIS 安装包)
echo ===============================================
echo   抖音直播录制工具V2 - 一键打包
echo ===============================================
echo.

rem 检查 pnpm 是否安装
where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 pnpm，正在尝试通过 npm 安装...
    call npm install -g pnpm
    if %errorlevel% neq 0 (
        echo [失败] pnpm 安装失败，请先安装 Node.js (https://nodejs.org) 后重试。
        pause
        exit /b 1
    )
)

echo [1/3] 安装依赖 (pnpm install)...
call pnpm install
if %errorlevel% neq 0 (
    echo [失败] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
)

echo.
echo [2/3] Windows 构建已准备，检查 electron 环境...
echo.

echo [3/3] 开始打包 NSIS 安装包 (pnpm run build)...
call pnpm run build
if %errorlevel% neq 0 (
    echo [失败] 打包失败，请检查上方错误信息。
    pause
    exit /b 1
)

echo.
echo ===============================================
echo   打包成功！安装包位于 dist\ 目录下：
echo     dist\抖音直播录制工具V2-Setup-1.0.0.exe
echo ===============================================
pause