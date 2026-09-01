#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Roblox Tree-Chopping Macro (WASD auto-movement, Roblox-compatible input)
========================================================================

חוצבים עצים ע"י התקרבות אליהם, לכן המקרו מזיז את הדמות אוטומטית בשדה בעזרת
מקשי התנועה W/A/S/D כדי לעבור בין כל העצים ולחצוב אותם.

חשוב: רובלוקס מתעלם ממקשים "וירטואליים" רגילים, לכן כאן שולחים את המקשים
בשיטת *scancode* דרך SendInput של Windows – זו השיטה שרובלוקס מזהה.

מקשי קיצור:
    F6 – התחל / עצור        F8 – יציאה

הפעלה:
    python tree_macro.py                 # patrol (תבנית ריבוע) – ברירת מחדל
    python tree_macro.py --mode random   # הליכה אקראית
    python tree_macro.py --step 0.7      # שניות להחזיק כל כיוון
    python tree_macro.py --keys arrows   # חיצים במקום WASD
"""

import argparse
import ctypes
import random
import sys
import threading
import time

try:
    from pynput import keyboard
except ImportError:
    sys.exit("חסרה ספריה: pynput.  התקן עם:  pip install pynput")


# --------------------------------------------------------------------------- #
#  שליחת מקשים דרך SendInput עם scancode – מה שרובלוקס מזהה                     #
# --------------------------------------------------------------------------- #
if sys.platform != "win32":
    sys.exit("המקרו הזה בנוי ל-Windows (רובלוקס PC). הרץ אותו על מחשב Windows.")

user32 = ctypes.windll.user32
PUL = ctypes.POINTER(ctypes.c_ulong)

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008
MAPVK_VK_TO_VSC = 0
INPUT_KEYBOARD = 1


class _KeyBdInput(ctypes.Structure):
    _fields_ = [("wVk", ctypes.c_ushort), ("wScan", ctypes.c_ushort),
                ("dwFlags", ctypes.c_ulong), ("time", ctypes.c_ulong),
                ("dwExtraInfo", PUL)]


class _MouseInput(ctypes.Structure):
    _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long),
                ("mouseData", ctypes.c_ulong), ("dwFlags", ctypes.c_ulong),
                ("time", ctypes.c_ulong), ("dwExtraInfo", PUL)]


class _HardwareInput(ctypes.Structure):
    _fields_ = [("uMsg", ctypes.c_ulong), ("wParamL", ctypes.c_short),
                ("wParamH", ctypes.c_ushort)]


class _InputUnion(ctypes.Union):
    _fields_ = [("ki", _KeyBdInput), ("mi", _MouseInput), ("hi", _HardwareInput)]


class _Input(ctypes.Structure):
    _fields_ = [("type", ctypes.c_ulong), ("u", _InputUnion)]


def _send(scan, extended, keyup):
    flags = KEYEVENTF_SCANCODE
    if extended:
        flags |= KEYEVENTF_EXTENDEDKEY
    if keyup:
        flags |= KEYEVENTF_KEYUP
    ki = _KeyBdInput(0, scan & 0xFF, flags, 0, ctypes.pointer(ctypes.c_ulong(0)))
    inp = _Input(INPUT_KEYBOARD, _InputUnion(ki=ki))
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(inp))


def vk_to_scan(vk):
    return user32.MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)


# vk codes: letters = ord(upper); arrows are extended keys.
VK_ARROWS = {"up": 0x26, "left": 0x25, "down": 0x28, "right": 0x27}


def make_keymap(spec):
    """מחזיר מיפוי כיוון -> (scancode, extended)."""
    spec = spec.strip().lower()
    if spec in ("arrows", "arrow"):
        return {d: (vk_to_scan(vk), True) for d, vk in VK_ARROWS.items()}
    if len(spec) != 4:
        spec = "wasd"
    up, left, down, right = spec[0], spec[1], spec[2], spec[3]
    order = {"up": up, "left": left, "down": down, "right": right}
    return {d: (vk_to_scan(ord(ch.upper())), False) for d, ch in order.items()}


class MacroState:
    def __init__(self):
        self.running = False
        self.alive = True


def hold(combo, duration, state):
    """לוחץ ומחזיק כיוון (או שניים לאלכסון) למשך duration, עם בדיקת עצירה."""
    for scan, ext in combo:
        _send(scan, ext, keyup=False)
    t_end = time.time() + duration
    try:
        while time.time() < t_end:
            if not state.running or not state.alive:
                break
            time.sleep(0.02)
    finally:
        for scan, ext in combo:
            _send(scan, ext, keyup=True)


def run_patrol(state, step, km):
    order = [(km["up"],), (km["right"],), (km["down"],), (km["left"],)]
    print(f"[patrol] מסתובב בתבנית ריבוע, {step}s לכל כיוון.")
    idx = 0
    while state.alive:
        if not state.running:
            time.sleep(0.05); continue
        hold(order[idx % 4], step, state)
        idx += 1


def run_random(state, step, km):
    singles = [(km["up"],), (km["down"],), (km["left"],), (km["right"],)]
    diagonals = [(km["up"], km["left"]), (km["up"], km["right"]),
                 (km["down"], km["left"]), (km["down"], km["right"])]
    print(f"[random] הליכה אקראית, ~{step}s לכל צעד.")
    while state.alive:
        if not state.running:
            time.sleep(0.05); continue
        combo = random.choice(diagonals) if random.random() < 0.4 else random.choice(singles)
        hold(combo, step * random.uniform(0.6, 1.4), state)


def build_listener(state):
    def on_press(key):
        if key == keyboard.Key.f6:
            state.running = not state.running
            print("▶️  זז! הדמות מסתובבת בשדה." if state.running else "⏸️  נעצר.")
        elif key == keyboard.Key.f8:
            print("👋 יוצא...")
            state.running = False
            state.alive = False
            return False
    return keyboard.Listener(on_press=on_press)


def main():
    p = argparse.ArgumentParser(description="מקרו רובלוקס: תנועה אוטומטית (WASD) לחציבת עצים.")
    p.add_argument("--mode", choices=["patrol", "random"], default="patrol")
    p.add_argument("--step", type=float, default=0.7)
    p.add_argument("--keys", type=str, default="wasd")
    p.add_argument("--start", action="store_true")
    args = p.parse_args()

    km = make_keymap(args.keys)
    state = MacroState()
    state.running = args.start

    print("=" * 56)
    print("  Roblox Tree Macro  –  תנועה אוטומטית (scancode)")
    print("=" * 56)
    print(f"  מצב: {args.mode}   |   קצב: {args.step}s לכל כיוון")
    print("  F6 = התחל/עצור      F8 = יציאה")
    print("=" * 56)
    print("  1) פתח את רובלוקס ולחץ עליו שיהיה בפוקוס.")
    print("  2) לחץ F6. הדמות אמורה להתחיל לזוז.")
    print("=" * 56)

    target = run_random if args.mode == "random" else run_patrol
    threading.Thread(target=target, args=(state, args.step, km), daemon=True).start()

    listener = build_listener(state)
    listener.start()
    try:
        listener.join()
    except KeyboardInterrupt:
        state.alive = False


if __name__ == "__main__":
    main()
