#!/usr/bin/env python3
"""BlockComet video recording: adds the HBRecorder library, our recorder class, an in-game menu entry, and the
FileProvider that lets the player play/share saved videos.   usage: record.py <res dir> <java dir> <here> <copper dir>"""
import os, re, shutil, sys
res, java, here, root = sys.argv[1:5]
manifest = os.path.join(root, "app_mojo/src/main/AndroidManifest.xml")
gradle = os.path.join(root, "app_mojo/build.gradle")
game = os.path.join(java, "game/GameActivity.java")

def sub(path, old, new, count=1):
    s = open(path, encoding="utf-8").read()
    assert s.count(old) == count, f"{path}: expected {count} x {old!r}, found {s.count(old)}"
    open(path, "w", encoding="utf-8").write(s.replace(old, new))

# 1. our class
os.makedirs(os.path.join(java, "record"), exist_ok=True)
shutil.copy(os.path.join(here, "java/BlockCometRecorder.java"), os.path.join(java, "record/BlockCometRecorder.java"))

# 2. the library (JitPack is already a repository of the project)
sub(gradle, "    implementation 'androidx.documentfile:documentfile:1.1.0'\n",
    "    implementation 'androidx.documentfile:documentfile:1.1.0'\n    implementation 'com.github.HBiSoft:HBRecorder:3.0.9'\n")

# 3. in-game menu: one more entry, and a getter for the control layout (to hide it while recording)
sub(game, "getResources().getStringArray(R.array.menu_ingame));",
    "git.artdeell.mojo.record.BlockCometRecorder.menuItems(this, getResources().getStringArray(R.array.menu_ingame)));")
sub(game, "case 4: openCustomControls(); break;",
    "case 4: openCustomControls(); break;\n                     case 5: git.artdeell.mojo.record.BlockCometRecorder.open(GameActivity.this); break;")
sub(game, "    private void loadControls() {",
    "    public ControlLayout bcControlLayout() { return mControlLayout; }\n\n    private void loadControls() {")

# 4. FileProvider for the Recordings folder
os.makedirs(os.path.join(res, "xml"), exist_ok=True)
open(os.path.join(res, "xml/bc_file_paths.xml"), "w").write(
    '<?xml version="1.0" encoding="utf-8"?>\n<paths>\n    <external-files-path name="recordings" path="Recordings/" />\n</paths>\n')
sub(manifest, '        <provider\n            android:name=".utils.scoped.FolderProvider"',
    '        <provider\n            android:name="androidx.core.content.FileProvider"\n'
    '            android:authorities="${applicationId}.bcfiles"\n            android:exported="false"\n'
    '            android:grantUriPermissions="true">\n            <meta-data\n'
    '                android:name="android.support.FILE_PROVIDER_PATHS"\n                android:resource="@xml/bc_file_paths" />\n'
    '        </provider>\n        <provider\n            android:name=".utils.scoped.FolderProvider"')
# 5. HBRecorder's notification STOP button is a manifest BroadcastReceiver. Copper's Application wraps its base context
# (LocaleUtils), and Android then fails to instantiate ANY manifest receiver ("cannot be cast to ContextImpl") and the
# app crashes. Remove that receiver; recording is stopped from the in-game menu instead.
sub(manifest, '        <provider\n            android:name="androidx.core.content.FileProvider"',
    '        <receiver\n            android:name="com.hbisoft.hbrecorder.NotificationReceiver"\n            tools:node="remove" />\n'
    '        <provider\n            android:name="androidx.core.content.FileProvider"')
print("recording added")
