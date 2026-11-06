@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title Kagemiyura
set "KAGEMIYURA_ROOT=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1"
if errorlevel 1 (
  echo.
  echo Kagemiyura: launch failed. See data\logs\launcher.log
  if not defined KAGEMIYURA_NO_PAUSE pause
  exit /b 1
)
exit /b 0
