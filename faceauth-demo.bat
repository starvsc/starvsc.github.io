@echo off
chcp 65001 >nul
title FaceAuth Demo Tunnel (HTTPS)
echo ============================================================
echo   FaceAuth Demo  -  Windows side launcher (HTTPS)
echo   usage : faceauth-demo.bat [Ubuntu-IP]
echo   default IP : 192.168.161.128
echo   Prereq: in Ubuntu run:  bash ~/faceauth_web/server/start.sh
echo   Note : self-signed cert - browser asks once, click
echo          Advanced -^> Proceed to localhost
echo ============================================================
set IP=192.168.161.128
if not "%~1"=="" set IP=%~1
echo.
echo   Open in browser : https://localhost:8000
echo   Tunnel to       : zero@%IP%  (-L 8000:127.0.0.1:8000)
echo.
start "" "https://localhost:8000"
echo   Connecting SSH ... enter Ubuntu password when asked.
echo   Keep this window open while using the page.
echo.
ssh -N -L 8000:127.0.0.1:8000 zero@%IP%
echo.
echo   Tunnel closed. Press any key to exit.
pause >nul
