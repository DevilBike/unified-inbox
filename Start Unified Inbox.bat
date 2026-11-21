@echo off
title Unified Inbox
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Unified Inbox needs Node.js. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
rem Put a "Unified Inbox" shortcut on the desktop the first time.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Join-Path ([Environment]::GetFolderPath('Desktop')) 'Unified Inbox.lnk'; if(!(Test-Path $p)){$s=(New-Object -ComObject WScript.Shell).CreateShortcut($p);$s.TargetPath='%~f0';$s.WorkingDirectory='%~dp0';$s.WindowStyle=7;$s.IconLocation='%~dp0icons\icon.ico';$s.Description='Clean up your inboxes';$s.Save()}" >nul 2>nul
set UNIFIED_INBOX_LAUNCHER=1
set OPEN=--open
:run
node server.mjs %OPEN%
if "%errorlevel%"=="75" (
  set OPEN=
  goto run
)
echo.
echo Unified Inbox has stopped.
pause
