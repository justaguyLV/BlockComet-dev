#!/usr/bin/env bash
# Skin demo for the emulator (records a video): fresh install -> "Local account" -> type a name -> open the skin editor from
# the account bar -> tap a skin -> check that the choice was stored for that name -> press Play and look for the files the
# launcher prepares for the game (skin + CustomSkinLoader configuration).
#   usage: emulator-skins.sh <apk>      env: OUT (default emulator-out), PKG, NAME (default Comet_Tester), EMU_LOCALE
set -u
APK="$1"; OUT="${OUT:-emulator-out}"; PKG="${PKG:-com.maxjubayeryt.copper.debug}"; NAME="${NAME:-Comet_Tester}"
HERE="$(cd "$(dirname "$0")" && pwd)"
RESULT="$OUT/skins-result.txt"; LOG="$OUT/skins-ui-log.txt"
mkdir -p "$OUT"; : > "$RESULT"; : > "$LOG"
say()  { echo "$*" | tee -a "$RESULT"; }
shot() { adb exec-out screencap -p > "$OUT/skins-$1.png" 2>/dev/null; }
ui()   { python3 "$HERE/ui.py" "$@" >> "$LOG" 2>&1; }
texts() { python3 "$HERE/ui.py" texts 2>/dev/null; }
# wait_for <regex on the dump> <seconds>
wait_for() { local end=$((SECONDS + $2)); while [ $SECONDS -lt $end ]; do texts | grep -qE "$1" && return 0; sleep 3; done; return 1; }
check() { # check <label> <command...>
  local label="$1"; shift
  if "$@"; then say "PASS  $label"; else say "FAIL  $label"; shot "fail-$(echo "$label" | tr -c 'a-zA-Z0-9' '-' | cut -c1-40)"; texts >> "$LOG"; FAILED=1; fi
}
FAILED=0

adb wait-for-device
if [ -n "${EMU_LOCALE:-}" ]; then
  adb root >/dev/null 2>&1; sleep 3
  adb shell "setprop persist.sys.locale $EMU_LOCALE"; adb shell "stop; start"
  sleep 8; adb wait-for-device
  for _ in $(seq 1 60); do [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ] && break; sleep 2; done
fi
adb install -r "$APK" 2>&1 | tail -1
adb shell pm clear "$PKG" >/dev/null 2>&1
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS 2>/dev/null

# A skin in the launcher's library (what the "+" tile of the editor would have imported): a 64x64 PNG made without extra libraries
python3 - "$OUT/demo-skin.png" <<'PY'
import struct, sys, zlib
w = h = 64
rows = []
for y in range(h):
    row = bytearray([0])
    for x in range(w):
        if y < 16 and x < 32:   c = (240, 190, 150, 255)          # head
        elif y < 32 and 16 <= x < 40: c = (30, 136, 229, 255)    # body: BlockComet blue
        else:                    c = (60, 60, 70, 255)
        row += bytes(c)
    rows.append(bytes(row))
raw = b"".join(rows)
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
open(sys.argv[1], "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
PY
printf '{"skins":[{"id":"demo-skin","name":"BlockComet demo","slim":false,"added":1}],"selected":{}}' > "$OUT/index.json"
adb push "$OUT/demo-skin.png" /data/local/tmp/demo-skin.png >/dev/null
adb push "$OUT/index.json" /data/local/tmp/index.json >/dev/null
adb shell "run-as $PKG sh -c 'mkdir -p skins && cp /data/local/tmp/demo-skin.png skins/demo-skin.png && cp /data/local/tmp/index.json skins/index.json'"
adb logcat -c

( adb shell screenrecord --time-limit 180 --bit-rate 3000000 /sdcard/skins.mp4 >/dev/null 2>&1 & )
sleep 2
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1

check "launcher opens and shows the account choices" wait_for 'button_local_authentication' 150
shot 01-add-account
ui tap-id button_local_authentication; sleep 3
check "local account screen opens" wait_for 'login_edit_email' 30
shot 02-local-screen
ui tap-id login_edit_email; sleep 1
adb shell input text "$NAME"; sleep 2
shot 03-name-typed
adb shell dumpsys input_method 2>/dev/null | grep -q "mInputShown=true" && { adb shell input keyevent KEYCODE_BACK; sleep 1; }
ui tap-id login_button; sleep 4
check "account '$NAME' is created and shown in the account bar" wait_for "$NAME" 30
shot 04-account-created

ui tap-id account_spinner; sleep 2
shot 05-account-list
ui tap-id edit_account_button; sleep 3
check "skin editor opens for the local account" wait_for 'skin_grid' 30
shot 06-skin-editor
check "the 'delete my published skin' button is shown for a local account" wait_for 'skin_unpublish_button' 20
ui tap-id tile_image; sleep 3
shot 07-skin-chosen
ui tap-id skin_unpublish_button; sleep 4
shot 07b-after-delete-button
check "the skin choice is stored for '$NAME'" bash -c "adb shell \"run-as $PKG cat skins/index.json\" | grep -q 'local:$NAME'"
adb shell "run-as $PKG cat skins/index.json" | tee -a "$RESULT"; echo | tee -a "$RESULT"

# Back to the main menu, then Play: the launcher prepares the skin and the CustomSkinLoader configuration before the game starts
adb shell input keyevent KEYCODE_BACK; sleep 2
ui tap-id play_button; sleep 5
shot 08-play-pressed
INST="/sdcard/Android/data/$PKG/files/instances"
for _ in $(seq 1 30); do
  adb shell "find $INST -path '*CustomSkinLoader/CustomSkinLoader.json' 2>/dev/null" | grep -q . && break
  sleep 6
done
FOUND=$(adb shell "find $INST -path '*CustomSkinLoader*' 2>/dev/null" | tr -d '\r')
echo "$FOUND" > "$OUT/skins-files.txt"
check "the launcher wrote the skin for '$NAME' where the game reads it" bash -c "grep -q 'LocalSkin/skins/$NAME.png' '$OUT/skins-files.txt'"
check "the launcher wrote the CustomSkinLoader configuration" bash -c "grep -q 'CustomSkinLoader.json' '$OUT/skins-files.txt'"
CFG=$(echo "$FOUND" | grep 'CustomSkinLoader.json' | head -1)
[ -n "$CFG" ] && adb shell "cat $CFG" > "$OUT/skins-config.json"
sleep 20; shot 09-after-play

adb shell "pkill -2 screenrecord"; sleep 6
adb pull /sdcard/skins.mp4 "$OUT/skins-demo.mp4" 2>&1 | tail -1
adb logcat -d -v threadtime > "$OUT/skins-logcat-full.txt"
grep -E "LocalSkins|AndroidRuntime|FATAL" "$OUT/skins-logcat-full.txt" | tail -n 60 > "$OUT/skins-logcat.txt"
grep -h "LocalSkins" "$OUT/skins-logcat.txt" | sed 's/^.*LocalSkins: /INFO  launcher log: /' | tail -n 4 | tee -a "$RESULT"
[ "$FAILED" = 0 ] && say "ALL CHECKS PASSED" || say "SOME CHECKS FAILED (see skins-ui-log.txt and the fail-*.png screenshots)"
exit 0
