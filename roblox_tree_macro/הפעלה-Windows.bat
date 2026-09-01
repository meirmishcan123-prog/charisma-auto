@echo off
chcp 65001 >nul
title Roblox Tree Macro
cd /d "%~dp0"
echo ============================================
echo    Roblox Tree Chopping Macro - Auto Setup
echo ============================================
echo.

where py >nul 2>nul
if %errorlevel%==0 (set PY=py) else (set PY=python)

%PY% --version >nul 2>nul
if not %errorlevel%==0 (
  echo [!] Python is NOT installed on this computer.
  echo.
  echo     1^) Open: https://www.python.org/downloads/
  echo     2^) Download and run the installer.
  echo     3^) IMPORTANT: tick "Add python.exe to PATH" then Install.
  echo     4^) Run this file again.
  echo.
  pause
  exit /b
)

echo Installing the required libraries (first run only)...
%PY% -m pip install --quiet --upgrade pip
%PY% -m pip install --quiet -r requirements.txt

echo.
echo ============================================
echo  Ready!  Now:
echo   1. Click on the Roblox window to focus it.
echo   2. Press  F6  to START chopping.
echo   3. Press  F6  again to PAUSE, or  F8  to QUIT.
echo   (Emergency stop: slam the mouse to the top-left corner.)
echo ============================================
echo.
%PY% tree_macro.py
echo.
echo Macro closed. You can close this window.
pause
