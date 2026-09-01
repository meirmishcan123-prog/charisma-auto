#!/bin/bash
cd "$(dirname "$0")"
echo "============================================"
echo "   Roblox Tree Chopping Macro - Auto Setup"
echo "============================================"
if ! command -v python3 >/dev/null 2>&1; then
  echo "[!] Python 3 is not installed."
  echo "    Install it from https://www.python.org/downloads/ and run again."
  read -n1 -p "Press any key to close..."
  exit 1
fi
echo "Installing required libraries (first run only)..."
python3 -m pip install --quiet --upgrade pip
python3 -m pip install --quiet -r requirements.txt
echo ""
echo "NOTE (Mac): the first time, macOS will ask for permission."
echo "Go to  System Settings > Privacy & Security > Accessibility"
echo "and allow 'Terminal' so the macro can control the mouse."
echo ""
echo "Ready! Click the Roblox window, press F6 to start, F8 to quit."
echo ""
python3 tree_macro.py
read -n1 -p "Macro closed. Press any key to close..."
