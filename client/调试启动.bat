@echo off
chcp 65001 >nul
echo === QuickShare 调试启动 ===
echo 关闭旧实例...
taskkill /f /im QuickShare.exe >nul 2>&1
for /f "tokens=*" %%i in ('dir /b "%~dp0dist\QuickShare-Portable-*.exe" ^| sort') do set LATEST=%%i
taskkill /f /im "%LATEST%" >nul 2>&1
timeout /t 1 /nobreak >nul
set QUICKSHARE_CDP=9222
echo 以调试模式启动 %LATEST%（本机回环调试口 9222）...
start "" "%~dp0dist\%LATEST%"
echo 已启动。日志：%%APPDATA%%\QuickShare\main.log
pause >nul
