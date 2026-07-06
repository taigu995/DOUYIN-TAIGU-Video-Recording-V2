@echo off
chcp 65001 >nul 2>&1
echo ============================================
echo   修复 bitbrowser 协议弹窗
echo ============================================
echo.
echo 正在清除 bitbrowser 协议注册表项...
echo.

reg delete "HKCU\Software\Classes\bitbrowser" /f 2>nul
if %errorlevel%==0 (
    echo [成功] 已删除当前用户的 bitbrowser 协议
) else (
    echo [跳过] 当前用户无 bitbrowser 协议注册
)

reg delete "HKLM\Software\Classes\bitbrowser" /f 2>nul
if %errorlevel%==0 (
    echo [成功] 已删除系统级的 bitbrowser 协议
) else (
    echo [跳过] 系统级无 bitbrowser 协议注册
)

echo.
echo ============================================
echo   修复完成！弹窗将不再出现。
echo ============================================
echo.
pause
