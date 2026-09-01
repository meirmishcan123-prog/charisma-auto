@echo off
chcp 65001 >nul
title Roblox Tree Macro - Preview
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (set PY=py) else (set PY=python)
%PY% -m pip install --quiet -r requirements.txt
echo Taking a preview screenshot with detected trees marked...
%PY% tree_macro.py --preview
echo.
echo Open the file  tree_macro_preview.png  in this folder to see what was detected.
pause
