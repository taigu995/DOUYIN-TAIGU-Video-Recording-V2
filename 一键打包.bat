@echo off
chcp 65001 >nul 2>&1
title 抖音直播录制工具 - 一键打包
color 0A

echo ============================================
echo   抖音直播录制工具 - 一键打包脚本
echo   流媒体直录 + 评论区弹幕拼接
echo ============================================
echo.

:: 检查 Node.js
echo [1/5] 检查 Node.js ...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js！
    echo 请先安装 Node.js (v18+): https://nodejs.org/
    echo 安装完成后重新运行此脚本。
    pause
    exit /b 1
)
for /f "tokens=1 delims=v" %%a in ('node -v') do set NODE_VER=%%a
echo       Node.js 已安装: %NODE_VER%

:: 检查 pnpm
echo [2/5] 检查 pnpm ...
where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    echo       pnpm 未安装，正在安装...
    npm install -g pnpm
    if %errorlevel% neq 0 (
        echo [错误] pnpm 安装失败，请手动安装: npm install -g pnpm
        pause
        exit /b 1
    )
)
echo       pnpm 已就绪

:: 安装依赖
echo [3/5] 安装项目依赖 (首次可能需要几分钟) ...
call pnpm install
if %errorlevel% neq 0 (
    echo [错误] 依赖安装失败！
    pause
    exit /b 1
)
echo       依赖安装完成

:: 打包
echo [4/5] 开始打包 Windows EXE ...
echo       这可能需要 5-10 分钟，请耐心等待...
echo.
call npx electron-builder --win --x64
if %errorlevel% neq 0 (
    echo.
    echo [错误] 打包失败！请检查上方错误信息。
    echo 常见问题:
    echo   1. 网络问题: 检查是否能访问 GitHub
    echo   2. 杀毒软件: 临时关闭杀毒软件重试
    echo   3. 磁盘空间: 确保有 2GB 以上可用空间
    pause
    exit /b 1
)

:: 完成
echo.
echo [5/5] 打包完成！
echo ============================================
echo.

:: 显示输出文件
if exist "dist\*.exe" (
    echo 安装包位置:
    dir /b dist\*.exe 2>nul
    echo.
    echo 正在打开输出目录...
    start explorer "%~dp0dist"
) else if exist "dist\win-unpacked" (
    echo 程序位置: dist\win-unpacked\
    echo 运行: dist\win-unpacked\DouyinLiveRecorder.exe
    echo.
    echo 正在打开输出目录...
    start explorer "%~dp0dist\win-unpacked"
)

echo.
echo ============================================
echo   打包成功！
echo ============================================
pause
