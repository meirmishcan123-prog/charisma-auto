#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Roblox Tree-Chopping Macro (WASD roaming)
=========================================

במשחק חוצבים עצים ע"י תנועה של הדמות לתוך/ליד העצים (המשחק חוצב אוטומטית את
העץ שנמצאים לידו). לכן המקרו הזה *מזיז את הדמות אוטומטית בשדה* בעזרת מקשי
התנועה W / A / S / D, כך שהיא מסתובבת בין כל העצים וחוצבת אותם ברצף.

שני מצבי תנועה:
  patrol  – סיבוב בתבנית קבועה (ריבוע): קדימה, ימינה, אחורה, שמאלה... חוזר
            חלילה. מסודר ומכסה את השדה.
  random  – הליכה אקראית: בכל צעד כיוון אקראי (כולל אלכסונים). מכסה שטח יפה
            ולא נתקע.

מקשי קיצור בזמן ריצה:
    F6  – התחל / עצור את המקרו
    F8  – יציאה מהתוכנה

הפעלה:
    python tree_macro.py                 # ברירת מחדל: patrol
    python tree_macro.py --mode random   # הליכה אקראית
    python tree_macro.py --step 0.7      # כמה שניות להחזיק כל כיוון
    python tree_macro.py --keys wasd     # מקשי התנועה (ברירת מחדל w/a/s/d)

חשוב: פתח את חלון רובלוקס והבא אותו לפוקוס לפני שלוחצים F6.
"""

import argparse
import random
import sys
import threading
import time

try:
    from pynput import keyboard
    from pynput.keyboard import Controller, Key, KeyCode
except ImportError:
    sys.exit("חסרה ספריה: pynput.  התקן עם:  pip install pynput")


class MacroState:
    def __init__(self):
        self.running = False
        self.alive = True


def _release_all(kb, keys):
    for k in keys:
        try:
            kb.release(k)
        except Exception:
            pass


def hold(kb, keys, duration, state):
    """לוחץ ומחזיק צירוף מקשים למשך duration שניות, עם בדיקת עצירה."""
    for k in keys:
        kb.press(k)
    t_end = time.time() + duration
    while time.time() < t_end:
        if not state.running or not state.alive:
            break
        time.sleep(0.02)
    _release_all(kb, keys)


def run_patrol(state, step, kmap):
    """תבנית ריבוע: קדימה, ימינה, אחורה, שמאלה – חוזר חלילה."""
    kb = Controller()
    order = [(kmap["up"],), (kmap["right"],), (kmap["down"],), (kmap["left"],)]
    print(f"[patrol] מסתובב בשדה בתבנית ריבוע, {step}s לכל כיוון.")
    idx = 0
    while state.alive:
        if not state.running:
            time.sleep(0.05)
            continue
        hold(kb, order[idx % 4], step, state)
        idx += 1


def run_random(state, step, kmap):
    """הליכה אקראית: כיוון אקראי בכל צעד, לפעמים אלכסון."""
    kb = Controller()
    singles = [kmap["up"], kmap["down"], kmap["left"], kmap["right"]]
    diagonals = [
        (kmap["up"], kmap["left"]), (kmap["up"], kmap["right"]),
        (kmap["down"], kmap["left"]), (kmap["down"], kmap["right"]),
    ]
    print(f"[random] הליכה אקראית בשדה, ~{step}s לכל צעד.")
    while state.alive:
        if not state.running:
            time.sleep(0.05)
            continue
        if random.random() < 0.4:
            keys = random.choice(diagonals)
        else:
            keys = (random.choice(singles),)
        dur = step * random.uniform(0.6, 1.4)
        hold(kb, keys, dur, state)


def parse_keys(spec):
    """ממיר מחרוזת כמו 'wasd' למיפוי כיוונים. סדר: up,left,down,right."""
    spec = spec.strip().lower()
    if len(spec) == 4:
        up, left, down, right = spec[0], spec[1], spec[2], spec[3]
    else:
        up, left, down, right = "w", "a", "s", "d"

    def mk(ch):
        if ch == "up":
            return Key.up
        if ch == "down":
            return Key.down
        if ch == "left":
            return Key.left
        if ch == "right":
            return Key.right
        return KeyCode.from_char(ch)

    return {"up": mk(up), "left": mk(left), "down": mk(down), "right": mk(right)}


def build_listener(state):
    def on_press(key):
        if key == keyboard.Key.f6:
            state.running = not state.running
            print("▶️  זז! המקרו מסתובב בשדה." if state.running
                  else "⏸️  נעצר.")
        elif key == keyboard.Key.f8:
            print("👋 יוצא...")
            state.running = False
            state.alive = False
            return False
    return keyboard.Listener(on_press=on_press)


def main():
    p = argparse.ArgumentParser(description="מקרו רובלוקס: תנועה אוטומטית עם WASD לחציבת עצים.")
    p.add_argument("--mode", choices=["patrol", "random"], default="patrol",
                   help="patrol = תבנית ריבוע. random = הליכה אקראית.")
    p.add_argument("--step", type=float, default=0.7,
                   help="שניות להחזיק כל כיוון תנועה. ברירת מחדל 0.7.")
    p.add_argument("--keys", type=str, default="wasd",
                   help="מקשי התנועה בסדר up,left,down,right. ברירת מחדל wasd. "
                        "אפשר גם 'arrows' לחיצים.")
    p.add_argument("--start", action="store_true", help="התחל מיד בלי F6.")
    args = p.parse_args()

    if args.keys.strip().lower() in ("arrows", "arrow"):
        kmap = {"up": Key.up, "left": Key.left, "down": Key.down, "right": Key.right}
    else:
        kmap = parse_keys(args.keys)

    state = MacroState()
    state.running = args.start

    print("=" * 56)
    print("  Roblox Tree Macro  –  תנועה אוטומטית (WASD)")
    print("=" * 56)
    print(f"  מצב:   {args.mode}   |   קצב: {args.step}s לכל כיוון")
    print("-" * 56)
    print("  F6 = התחל/עצור      F8 = יציאה")
    print("=" * 56)
    print("  פתח את רובלוקס, לחץ עליו שיהיה בפוקוס, ואז לחץ F6.")
    print("=" * 56)

    target = run_random if args.mode == "random" else run_patrol
    worker = threading.Thread(target=target, args=(state, args.step, kmap), daemon=True)
    worker.start()

    listener = build_listener(state)
    listener.start()
    try:
        listener.join()
    except KeyboardInterrupt:
        state.alive = False


if __name__ == "__main__":
    main()
