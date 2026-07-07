@echo off
title MarketPulse Launcher
cd /d "%~dp0"

REM --- start the data server in its own minimized window ---
start "MarketPulse Server" /min cmd /c "node server.js"

REM --- wait until the server is actually listening on port 5173 ---
:waitloop
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('localhost',5173);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
if errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto waitloop
)

REM --- server is up: open the app and close this launcher ---
start "" http://localhost:5173
exit
