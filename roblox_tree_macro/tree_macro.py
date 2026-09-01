#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Roblox Tree-Chopping Macro
==========================

מקרו שחוצב עצים אוטומטית במשחקי "טאפ / חציבה" ברובלוקס (כמו Tree Tapping / Wood
Cutting Simulator). התוכנה עובדת בשתי שיטות:

1. מצב זיהוי צבע (detect)  – סורק את המסך, מזהה את העצים לפי הצבע הירוק/צהוב
   ולוחץ עליהם אוטומטית. שיטה חכמה שלוחצת ישירות על העצים.

2. מצב לחיצה מהירה (spam) – פשוט לוחץ במהירות במיקום קבוע על המסך
   (למשל מרכז המגרש או כפתור ה-Auto). הכי אמין, לא תלוי בזיהוי.

מקשי קיצור בזמן ריצה:
    F6  – התחל / עצור את המקרו (Start / Stop)
    F7  – סמן מיקום לחיצה (רק במצב spam) – הזז את העכבר ולחץ F7
    F8  – יציאה מלאה מהתוכנה (Quit)

הפעלה:
    python tree_macro.py                 # מצב ברירת מחדל (detect)
    python tree_macro.py --mode spam     # מצב לחיצה מהירה
    python tree_macro.py --cps 12        # 12 לחיצות בשנייה

הערה חשובה: הפעל את חלון רובלוקס והבא אותו לפוקוס לפני שמתחילים.
המקרו הוא כלי אוטומציה מקומי בלבד; אין כאן שום שינוי או פריצה של המשחק.
"""

import argparse
import sys
import time
import threading

# --- ייבוא ספריות עם הודעות שגיאה ידידותיות ---------------------------------
try:
    import pyautogui
except ImportError:
    sys.exit("חסרה ספריה: pyautogui.  התקן עם:  pip install -r requirements.txt")

try:
    from pynput import keyboard
except ImportError:
    sys.exit("חסרה ספריה: pynput.  התקן עם:  pip install -r requirements.txt")

# mss + numpy דרושים רק למצב הזיהוי (detect). לא נכשל אם חסרים ומשתמשים ב-spam.
try:
    import numpy as np
    from mss import mss
    _HAS_VISION = True
except ImportError:
    _HAS_VISION = False


# הגדרות בטיחות של pyautogui
pyautogui.FAILSAFE = True   # הזז עכבר לפינה השמאלית העליונה כדי לעצור חירום
pyautogui.PAUSE = 0.0       # לא נרצה השהיות מובנות – אנחנו שולטים בקצב


class MacroState:
    """מצב משותף בין הת'רדים (המאזין למקלדת + לולאת המקרו)."""

    def __init__(self):
        self.running = False       # האם המקרו פעיל כרגע
        self.alive = True          # האם התוכנה כולה עדיין רצה
        self.spam_pos = None       # (x, y) של מיקום לחיצה במצב spam
        self.lock = threading.Lock()


def human_readable_pos(pos):
    return f"({pos[0]}, {pos[1]})" if pos else "לא נקבע"


# --------------------------------------------------------------------------- #
#  מצב זיהוי צבע – מזהה עצים ולוחץ עליהם                                        #
# --------------------------------------------------------------------------- #
def tree_color_mask(r, g, b):
    """
    מקבל ערוצי R/G/B (מערכי numpy) ומחזיר מסכה בוליאנית של פיקסלים שנראים
    כמו עצים. הגוונים כוילו לפי צילומי המסך של המשחק:

      • עצים ירוקים  – ירוק-דשא רווי: הירוק שולט על האדום והכחול.
      • עצים צהובים  – צהוב-זהוב בהיר: אדום+ירוק גבוהים, כחול נמוך.
      • עצים כתומים  – כתום רווי: אדום גבוה, ירוק בינוני, כחול נמוך.
      • עצים ורודים  – ורוד פריחה: אדום וכחול גבוהים, ירוק הוא הנמוך ביותר.
      • עצים תכולים  – ציאן/תכלת: ירוק וכחול גבוהים וקרובים, אדום נמוך.

    בנוסף מסננים החוצה:
      • שלג / לבן / אפור UI – רוויה נמוכה מדי (ההפרש בין הערוץ החזק לחלש קטן).
      • קרח כחול, קרקע חומה, גזע העץ ודמות – לא עומדים ביחסי הצבע.
    """
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)

    # לא-לבן/לא-שלג/לא-אפור: חייבת להיות רוויה מינימלית של הצבע.
    saturated = (mx - mn) > 45

    # עץ ירוק: ירוק הוא הערוץ הדומיננטי, במרחק ברור מאדום ומכחול.
    green = (g > 110) & (g - r > 28) & (g - b > 28)

    # עץ צהוב: אדום וירוק גבוהים וקרובים, כחול נמוך משמעותית.
    yellow = (r > 175) & (g > 155) & (b < 140) & (r - b > 80) & (g - b > 55)

    # עץ כתום: אדום גבוה מאוד, ירוק בינוני (נמוך מצהוב), כחול נמוך.
    # r-g גדול מבדיל אותו מצהוב, ו-r גבוה + b נמוך מבדילים מקרקע חומה.
    orange = (r > 195) & (g > 85) & (g < 180) & (b < 115) & \
             (r - g > 55) & (g - b > 25)

    # עץ ורוד (פריחת דובדבן): אדום וכחול גבוהים, ירוק הנמוך ביותר,
    # ואדום גדול-או-שווה לכחול (ורוד, לא סגול/כחול).
    pink = ((r > 185) & (b > 155) & (r - g > 28) & (b - g > 10) &
            (r - b > -25) & (r - b < 75))

    # עץ תכול (ציאן): ירוק וכחול גבוהים וקרובים זה לזה, אדום נמוך.
    # ההגבלה |g-b|<45 מפרידה בין ציאן מאוזן לבין קרח כחול-דומיננטי.
    cyan = ((g > 170) & (b > 170) & (g - r > 35) & (b - r > 35) &
            (np.abs(g - b) < 45))

    return (green | yellow | orange | pink | cyan) & saturated


def _grab_region(region):
    with mss() as sct:
        raw = np.array(sct.grab(region))  # BGRA
    b = raw[:, :, 0].astype(np.int16)
    g = raw[:, :, 1].astype(np.int16)
    r = raw[:, :, 2].astype(np.int16)
    return r, g, b, raw


def find_tree_targets(region, min_area=60):
    """
    מצלם את אזור המסך ומחזיר רשימת נקודות (x, y) של אשכולות פיקסלים שנראים
    כמו עצים, ממוינות מהאשכול הגדול לקטן.

    region – dict עם top/left/width/height (פורמט של mss).
    """
    r, g, b, _ = _grab_region(region)
    mask = tree_color_mask(r, g, b)

    ys, xs = np.where(mask)
    if len(xs) == 0:
        return []

    # אשכול פשוט: מחלקים את הפיקסלים לתאי רשת ומאתרים מרכזים.
    cell = 40  # גודל תא בפיקסלים
    buckets = {}
    for x, y in zip(xs, ys):
        key = (x // cell, y // cell)
        acc = buckets.setdefault(key, [0, 0, 0])
        acc[0] += x
        acc[1] += y
        acc[2] += 1

    targets = []
    for (sx, sy, count) in buckets.values():
        if count < min_area:
            continue
        cx = region["left"] + sx // count
        cy = region["top"] + sy // count
        targets.append((cx, cy, count))

    targets.sort(key=lambda t: t[2], reverse=True)
    return [(x, y) for (x, y, _c) in targets]


def run_detect_loop(state, cps, region):
    interval = 1.0 / max(cps, 1)
    print(f"[detect] סורק עצים באזור {region} בקצב ~{cps} לחיצות/שנייה.")
    while state.alive:
        if not state.running:
            time.sleep(0.05)
            continue

        targets = find_tree_targets(region)
        if not targets:
            # לא נמצאו עצים – לחיצה במרכז האזור כגיבוי
            cx = region["left"] + region["width"] // 2
            cy = region["top"] + region["height"] // 2
            targets = [(cx, cy)]

        for (x, y) in targets:
            if not state.running or not state.alive:
                break
            try:
                pyautogui.click(x, y)
            except pyautogui.FailSafeException:
                print("[detect] הופעל FailSafe (עכבר בפינה) – עוצר.")
                state.running = False
                break
            time.sleep(interval)


# --------------------------------------------------------------------------- #
#  מצב לחיצה מהירה – לוחץ במיקום קבוע                                           #
# --------------------------------------------------------------------------- #
def run_spam_loop(state, cps):
    interval = 1.0 / max(cps, 1)
    print(f"[spam] מצב לחיצה מהירה בקצב ~{cps} לחיצות/שנייה.")
    while state.alive:
        if not state.running:
            time.sleep(0.05)
            continue

        with state.lock:
            pos = state.spam_pos

        try:
            if pos:
                pyautogui.click(pos[0], pos[1])
            else:
                pyautogui.click()  # לוחץ במיקום הנוכחי של העכבר
        except pyautogui.FailSafeException:
            print("[spam] הופעל FailSafe (עכבר בפינה) – עוצר.")
            state.running = False
            continue
        time.sleep(interval)


# --------------------------------------------------------------------------- #
#  מאזין למקלדת – מקשי הקיצור הגלובליים                                         #
# --------------------------------------------------------------------------- #
def build_hotkey_listener(state, mode):
    def on_press(key):
        if key == keyboard.Key.f6:
            state.running = not state.running
            print("▶️  המקרו הופעל." if state.running else "⏸️  המקרו הושהה.")
        elif key == keyboard.Key.f7 and mode == "spam":
            x, y = pyautogui.position()
            with state.lock:
                state.spam_pos = (x, y)
            print(f"📍 נקבע מיקום לחיצה: ({x}, {y})")
        elif key == keyboard.Key.f8:
            print("👋 יוצא מהתוכנה...")
            state.running = False
            state.alive = False
            return False  # עוצר את המאזין

    return keyboard.Listener(on_press=on_press)


def parse_region(arg):
    """
    מפרש 'left,top,width,height' לפורמט של mss.

    ללא ארגומנט מחזיר אזור ברירת מחדל שמכסה את מגרש המשחק בלבד ומתעלם מפאנלי
    ה-UI: מחתך שוליים באחוזים (עמיד לכל רזולוציה) – 13% שמאל, 22% ימין (הטבלה
    והכפתורים הצבעוניים), 8% למעלה (פס הרמה) ו-13% למטה (כפתורי Auto והקלפים).
    כך המקרו לא לוחץ בטעות על כפתורי ה-UI הירוקים/צהובים.
    """
    if not arg:
        w, h = pyautogui.size()
        left = int(w * 0.13)
        right = int(w * 0.22)
        top = int(h * 0.08)
        bottom = int(h * 0.13)
        return {"left": left, "top": top,
                "width": w - left - right, "height": h - top - bottom}
    parts = [int(p) for p in arg.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("region חייב להיות: left,top,width,height")
    return {"left": parts[0], "top": parts[1], "width": parts[2], "height": parts[3]}


def save_preview(region, out_path="tree_macro_preview.png"):
    """
    מצלם את אזור הסריקה, מסמן באדום כל עץ שזוהה, ושומר לתמונה כדי שאפשר יהיה
    לוודא שהזיהוי מדויק. שימושי לכיוונון הצבעים.
    """
    r, g, b, raw = _grab_region(region)
    mask = tree_color_mask(r, g, b)
    img = raw.copy()
    # הבהרת הפיקסלים שזוהו (צובע אותם באדום בולט)
    img[mask, 0] = 40    # B
    img[mask, 1] = 40    # G
    img[mask, 2] = 255   # R

    targets = find_tree_targets(region)
    # מסמן ריבוע סביב כל מרכז עץ שזוהה
    for (cx, cy) in targets:
        px = cx - region["left"]
        py = cy - region["top"]
        for d in range(-9, 10):
            for (ax, ay) in [(px + d, py - 9), (px + d, py + 9),
                             (px - 9, py + d), (px + 9, py + d)]:
                if 0 <= ay < img.shape[0] and 0 <= ax < img.shape[1]:
                    img[ay, ax, :3] = (255, 255, 0)  # מסגרת ציאן/צהוב

    try:
        from mss.tools import to_png
        # img הוא BGRA (הפורמט של mss) – to_png מצפה בדיוק לזה.
        to_png(img.astype("uint8").tobytes(), (img.shape[1], img.shape[0]),
               output=out_path)
    except Exception:
        try:
            from PIL import Image
            Image.fromarray(img[:, :, :3][:, :, ::-1].astype("uint8")).save(out_path)
        except Exception as e:
            print(f"לא ניתן לשמור תצוגה מקדימה: {e}")
            return None, len(targets)
    return out_path, len(targets)


def main():
    parser = argparse.ArgumentParser(
        description="מקרו רובלוקס לחציבת עצים אוטומטית.")
    parser.add_argument("--mode", choices=["detect", "spam"], default="detect",
                        help="detect = זיהוי עצים לפי צבע ולחיצה עליהם. "
                             "spam = לחיצה מהירה במיקום קבוע.")
    parser.add_argument("--cps", type=float, default=10.0,
                        help="לחיצות בשנייה (clicks per second). ברירת מחדל 10.")
    parser.add_argument("--region", type=str, default=None,
                        help="אזור סריקה למצב detect: left,top,width,height. "
                             "ברירת מחדל: מגרש המשחק בלבד (מתעלם מפאנלי ה-UI).")
    parser.add_argument("--start", action="store_true",
                        help="התחל את המקרו מיד בלי להמתין ל-F6.")
    parser.add_argument("--preview", action="store_true",
                        help="מצלם את אזור הסריקה, מסמן את העצים שזוהו, שומר "
                             "לתמונה tree_macro_preview.png ויוצא. לבדיקת הזיהוי.")
    args = parser.parse_args()

    if (args.mode == "detect" or args.preview) and not _HAS_VISION:
        sys.exit("מצב detect/preview דורש numpy ו-mss.  התקן:  pip install -r requirements.txt\n"
                 "או השתמש במצב הפשוט:  python tree_macro.py --mode spam")

    if args.preview:
        region = parse_region(args.region)
        print(f"מצלם תצוגה מקדימה של האזור {region} ...")
        result = save_preview(region)
        if result and result[0]:
            print(f"✅ נשמר: {result[0]}  |  זוהו {result[1]} עצים.")
            print("   פתח את התמונה: הריבועים = עצים שזוהו, אדום = פיקסלי-עץ.")
            print("   אם משהו לא מדויק, כוונן את הצבעים ב-tree_color_mask().")
        return

    state = MacroState()
    state.running = args.start

    print("=" * 58)
    print("  Roblox Tree-Chopping Macro")
    print("=" * 58)
    print(f"  מצב:            {args.mode}")
    print(f"  קצב לחיצות:     {args.cps}/שנייה")
    print("-" * 58)
    print("  F6 = התחל/עצור   |   F8 = יציאה")
    if args.mode == "spam":
        print("  F7 = קבע מיקום לחיצה (הזז עכבר ולחץ F7)")
    print("=" * 58)
    print("  פתח את חלון רובלוקס, הבא אותו לפוקוס, ולחץ F6 להתחיל.")
    print("  (עצירת חירום: הזז את העכבר לפינה השמאלית-עליונה של המסך)")
    print("=" * 58)

    region = parse_region(args.region) if args.mode == "detect" else None

    # הפעל את לולאת המקרו בת'רד נפרד
    if args.mode == "detect":
        worker = threading.Thread(
            target=run_detect_loop, args=(state, args.cps, region), daemon=True)
    else:
        worker = threading.Thread(
            target=run_spam_loop, args=(state, args.cps), daemon=True)
    worker.start()

    # המאזין למקלדת חוסם עד F8
    listener = build_hotkey_listener(state, args.mode)
    listener.start()
    try:
        listener.join()
    except KeyboardInterrupt:
        state.alive = False
        print("\nהופסק ע\"י המשתמש.")


if __name__ == "__main__":
    main()
