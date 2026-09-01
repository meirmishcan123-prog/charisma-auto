#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Roblox Tree-Chopping Macro  –  seek & chop
==========================================

חוצבים עץ ע"י עמידה קרוב אליו. לכן המקרו:
  1. סורק את המסך כל רגע ומזהה איפה יש עצים (לפי הצבע).
  2. בוחר את העץ הקרוב ביותר לדמות.
  3. מזיז את הדמות (W/A/S/D) לכיוון העץ עד שהיא לידו.
  4. עומד לידו רגע כדי לחצוב, ואז ממשיך לעץ הבא. חוזר חלילה.

המקשים נשלחים בשיטת scancode (SendInput) – מה שרובלוקס מזהה.

מקשי קיצור:
    F6 – התחל / עצור        F8 – יציאה

הפעלה:
    python tree_macro.py                    # מצב seek (חכם) – ברירת מחדל
    python tree_macro.py --char 960,620     # מיקום הדמות על המסך (אם צריך לכוון)
    python tree_macro.py --reach 80         # מרחק בפיקסלים שנחשב "ליד העץ"
    python tree_macro.py --mode patrol      # גיבוי: הליכה עיוורת בריבוע
"""

import argparse
import ctypes
import math
import random
import sys
import threading
import time

try:
    from pynput import keyboard
except ImportError:
    sys.exit("חסרה ספריה: pynput.  התקן:  pip install pynput mss numpy")

try:
    import numpy as np
    from mss import mss
except ImportError:
    sys.exit("חסרות ספריות: numpy / mss.  התקן:  pip install pynput mss numpy")

if sys.platform != "win32":
    sys.exit("המקרו בנוי ל-Windows (רובלוקס PC).")


# --------------------------------------------------------------------------- #
#  שליחת מקשים בשיטת scancode – מה שרובלוקס מזהה                                #
# --------------------------------------------------------------------------- #
user32 = ctypes.windll.user32
PUL = ctypes.POINTER(ctypes.c_ulong)
KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008
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
    flags = KEYEVENTF_SCANCODE | (KEYEVENTF_EXTENDEDKEY if extended else 0)
    if keyup:
        flags |= KEYEVENTF_KEYUP
    ki = _KeyBdInput(0, scan & 0xFF, flags, 0, ctypes.pointer(ctypes.c_ulong(0)))
    inp = _Input(INPUT_KEYBOARD, _InputUnion(ki=ki))
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(inp))


def vk_to_scan(vk):
    return user32.MapVirtualKeyW(vk, 0)


# W/A/S/D scancodes (not extended)
KEY = {
    "up":    (vk_to_scan(ord("W")), False),
    "left":  (vk_to_scan(ord("A")), False),
    "down":  (vk_to_scan(ord("S")), False),
    "right": (vk_to_scan(ord("D")), False),
}
_HELD = set()


def set_key(direction, down):
    scan, ext = KEY[direction]
    if down and direction not in _HELD:
        _send(scan, ext, keyup=False)
        _HELD.add(direction)
    elif not down and direction in _HELD:
        _send(scan, ext, keyup=True)
        _HELD.discard(direction)


def release_all_keys():
    for d in list(_HELD):
        set_key(d, False)


# --------------------------------------------------------------------------- #
#  זיהוי עצים לפי צבע                                                          #
# --------------------------------------------------------------------------- #
def tree_color_mask(r, g, b):
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    saturated = (mx - mn) > 45
    green = (g > 110) & (g - r > 28) & (g - b > 28)
    yellow = (r > 175) & (g > 155) & (b < 140) & (r - b > 80) & (g - b > 55)
    orange = (r > 195) & (g > 85) & (g < 180) & (b < 115) & (r - g > 55) & (g - b > 25)
    pink = ((r > 185) & (b > 155) & (r - g > 28) & (b - g > 10) & (r - b > -25) & (r - b < 75))
    cyan = ((g > 170) & (b > 170) & (g - r > 35) & (b - r > 35) & (np.abs(g - b) < 45))
    return (green | yellow | orange | pink | cyan) & saturated


def find_trees(region):
    """מחזיר רשימת מרכזי-עצים (x,y) בקואורדינטות מסך, ממוין מהגדול לקטן."""
    with mss() as sct:
        raw = np.array(sct.grab(region))
    b = raw[:, :, 0].astype(np.int16)
    g = raw[:, :, 1].astype(np.int16)
    r = raw[:, :, 2].astype(np.int16)
    mask = tree_color_mask(r, g, b)
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return []
    cell = 46
    buckets = {}
    for x, y in zip(xs, ys):
        k = (x // cell, y // cell)
        acc = buckets.setdefault(k, [0, 0, 0])
        acc[0] += x; acc[1] += y; acc[2] += 1
    out = []
    for sx, sy, c in buckets.values():
        if c < 55:
            continue
        out.append((region["left"] + sx // c, region["top"] + sy // c, c))
    out.sort(key=lambda t: t[2], reverse=True)
    return [(x, y) for x, y, _ in out]


# --------------------------------------------------------------------------- #
#  לוגיקת seek – ללכת לעץ הקרוב ולעמוד לידו                                     #
# --------------------------------------------------------------------------- #
class MacroState:
    def __init__(self):
        self.running = False
        self.alive = True


def steer_towards(char, tree, deadzone):
    """מחליט אילו מקשים ללחוץ כדי להתקדם מהדמות לכיוון העץ."""
    dx = tree[0] - char[0]
    dy = tree[1] - char[1]
    set_key("up",    dy < -deadzone)   # עץ מעל הדמות → קדימה (W)
    set_key("down",  dy >  deadzone)   # עץ מתחת → אחורה (S)
    set_key("left",  dx < -deadzone)   # עץ משמאל → A
    set_key("right", dx >  deadzone)   # עץ מימין → D


def run_seek(state, char, reach, region):
    print(f"[seek] דמות ב-{char}, סורק עצים ומתקרב (reach={reach}px).")
    chop_until = 0.0
    while state.alive:
        if not state.running:
            release_all_keys(); time.sleep(0.05); continue

        trees = find_trees(region)
        if not trees:
            release_all_keys(); time.sleep(0.15); continue

        # העץ הקרוב ביותר לדמות
        nearest = min(trees, key=lambda t: math.hypot(t[0] - char[0], t[1] - char[1]))
        dist = math.hypot(nearest[0] - char[0], nearest[1] - char[1])

        if dist <= reach:
            # ליד העץ – עומדים רגע וחוצבים
            release_all_keys()
            time.sleep(0.5)
        else:
            steer_towards(char, nearest, deadzone=max(20, reach // 3))
            time.sleep(0.12)   # פסיעה קצרה ואז סורקים שוב (הגה סגור)
    release_all_keys()


def run_patrol(state, step, region=None):
    order = ["up", "right", "down", "left"]
    print(f"[patrol] הליכה עיוורת בריבוע, {step}s לכל כיוון.")
    idx = 0
    while state.alive:
        if not state.running:
            release_all_keys(); time.sleep(0.05); continue
        release_all_keys()
        set_key(order[idx % 4], True)
        t_end = time.time() + step
        while time.time() < t_end and state.running and state.alive:
            time.sleep(0.02)
        idx += 1
    release_all_keys()


# --------------------------------------------------------------------------- #
def parse_char(arg):
    if arg:
        x, y = arg.split(",")
        return (int(x), int(y))
    w = user32.GetSystemMetrics(0)
    h = user32.GetSystemMetrics(1)
    return (w // 2, int(h * 0.56))   # ניחוש טוב: מרכז, מעט מתחת לאמצע


def field_region():
    w = user32.GetSystemMetrics(0)
    h = user32.GetSystemMetrics(1)
    left = int(w * 0.13); right = int(w * 0.22)
    top = int(h * 0.08); bottom = int(h * 0.13)
    return {"left": left, "top": top, "width": w - left - right, "height": h - top - bottom}


def build_listener(state):
    def on_press(key):
        if key == keyboard.Key.f6:
            state.running = not state.running
            print("▶️  פועל! מחפש עצים וחוצב." if state.running else "⏸️  נעצר.")
            if not state.running:
                release_all_keys()
        elif key == keyboard.Key.f8:
            print("👋 יוצא...")
            state.running = False; state.alive = False
            release_all_keys()
            return False
    return keyboard.Listener(on_press=on_press)


def main():
    p = argparse.ArgumentParser(description="מקרו רובלוקס: מזהה עצים והולך לחצוב.")
    p.add_argument("--mode", choices=["seek", "patrol"], default="seek")
    p.add_argument("--char", type=str, default=None, help="מיקום הדמות על המסך x,y")
    p.add_argument("--reach", type=int, default=85, help="מרחק שנחשב ליד העץ (px)")
    p.add_argument("--step", type=float, default=0.6, help="patrol: שניות לכל כיוון")
    p.add_argument("--start", action="store_true")
    args = p.parse_args()

    char = parse_char(args.char)
    region = field_region()
    state = MacroState(); state.running = args.start

    print("=" * 58)
    print("  Roblox Tree Macro  –  seek & chop")
    print("=" * 58)
    print(f"  מצב: {args.mode}   דמות: {char}   reach: {args.reach}px")
    print("  F6 = התחל/עצור      F8 = יציאה")
    print("=" * 58)
    print("  1) פתח את רובלוקס ולחץ עליו שיהיה בפוקוס.")
    print("  2) לחץ F6. הדמות תלך לעצים ותחצוב.")
    print("  אם היא הולכת לכיוון הלא נכון – סובב את המצלמה שהדמות")
    print("  תסתכל 'למעלה' על המסך, או כוונן --char.")
    print("=" * 58)

    if args.mode == "patrol":
        worker = threading.Thread(target=run_patrol, args=(state, args.step, region), daemon=True)
    else:
        worker = threading.Thread(target=run_seek, args=(state, char, args.reach, region), daemon=True)
    worker.start()

    listener = build_listener(state)
    listener.start()
    try:
        listener.join()
    except KeyboardInterrupt:
        state.alive = False
        release_all_keys()


if __name__ == "__main__":
    main()
