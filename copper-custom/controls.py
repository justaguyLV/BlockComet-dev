#!/usr/bin/env python3
"""Writes BlockComet's default touch-control layout (assets/default.json): left joystick, big jump/attack/place
buttons on the right, a thin top bar. Our own design (not copied), so it carries no third-party licence.
usage: controls.py <output default.json>"""
import json, sys

BG = 0x66000000 - (1 << 32) if 0x66000000 >= 1 << 31 else 0x66000000   # 40 % black
STROKE = 0xB3FFFFFF - (1 << 32)                                          # soft white outline
M = "${margin}"

def btn(name, keys, x, y, w=50, h=50, toggle=False, radius=50.0, swipe=False):
    return {"bgColor": BG, "bitmapTag": None, "cornerRadius": radius, "displayInGame": True, "displayInMenu": True,
            "dynamicX": x, "dynamicY": y, "height": float(h), "isSwipeable": swipe, "isToggle": toggle,
            "keycodes": (list(keys) + [0, 0, 0, 0])[:4], "name": name, "opacity": 1.0, "passThruEnabled": False,
            "strokeColor": STROKE, "strokeWidth": 1.5, "width": float(w)}

R = "${right}"; B = "${bottom}"
buttons = []
# top bar (small, out of the way)
top = [("Debug", [292]), ("Chat", [84]), ("Tab", [258]), ("3rd", [294])]
for i, (n, k) in enumerate(top):
    buttons.append(btn(n, k, f"{M} * {i + 1} + ${{width}} * {i}", M, 58, 28, radius=30.0))
buttons.append(btn("Keyboard", [-1], f"{M} * 5 + ${{width}} * 4", M, 58, 28, radius=30.0))
buttons.append(btn("GUI", [-2], f"{R} - {M} * 2 - ${{width}}", M, 58, 28, radius=30.0))
buttons.append(btn("Mouse", [-5], f"{R} - {M} * 3 - ${{width}} * 2", M, 58, 28, radius=30.0))
# right-hand cluster: jump (big), attack, place, sneak, sprint, inventory
buttons.append(btn("Jump", [32], f"{R} - {M} * 3", f"{B} - {M} * 3", 70, 70))
buttons.append(btn("Attack", [-3], f"{R} - {M} * 6 - ${{width}} * 2", f"{B} - {M} * 2", 64, 64))
buttons.append(btn("Place", [-4], f"{R} - {M} * 3", f"{B} - {M} * 6 - ${{height}} * 2", 64, 64))
buttons.append(btn("Sneak", [340], f"{R} - {M} * 7 - ${{width}} * 3", f"{B} - {M} * 3", 50, 50, toggle=True))
buttons.append(btn("Sprint", [341], f"{R} - {M} * 10 - ${{width}} * 4", f"{B} - {M} * 3", 50, 50, toggle=True))
buttons.append(btn("Inv", [69], f"{R} - {M} * 7 - ${{width}} * 3", f"{B} - {M} * 8 - ${{height}} * 3", 44, 44))
buttons.append(btn("Drop", [81], f"{R} - {M} * 10 - ${{width}} * 4", f"{B} - {M} * 8 - ${{height}} * 3", 44, 44))
buttons.append(btn("Swap", [70], f"{R} - {M} * 13 - ${{width}} * 5", f"{B} - {M} * 3", 44, 44))
# hotbar scroll (the hotbar itself stays touchable)
buttons.append(btn("◀", [-8], f"${{screen_width}} / 2 - ${{width}} * 5", f"{B} - {M}", 36, 36))
buttons.append(btn("▶", [-7], f"${{screen_width}} / 2 + ${{width}} * 4", f"{B} - {M}", 36, 36))

joy = btn("Move", [], f"{M} * 4", f"{B} - {M} * 3", 130, 130)
joy.update({"forwardLock": True, "absolute": False, "bgColor": 0x33000000})

layout = {"mControlDataList": buttons, "mDrawerDataList": [], "mJoystickDataList": [joy],
          "scaledAt": 100.0, "version": 9}
json.dump(layout, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("default controls written:", len(buttons), "buttons + 1 joystick")
