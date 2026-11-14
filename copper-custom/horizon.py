#!/usr/bin/env python3
"""Adds a "Horizon (Rust)" button to the main menu.

Tapping it opens Starling (the Android port of Horizon, the Rust rewrite of Minecraft Java) when it is installed,
or offers to open its download page when it is not. Horizon stays a separate app (MIT licence); nothing of it is bundled.
usage: horizon.py <res-dir> <java-dir> <manifest>
"""
import os
import sys

res, java, manifest = sys.argv[1:4]
PKG = "io.github.juanluci.starling"
RELEASES = "https://github.com/starling-client/starling/releases/latest"


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def write(p, s):
    with open(p, "w", encoding="utf-8") as f:
        f.write(s)


# 1. Strings (English default, Arabic)
os.makedirs(res + "/values-ar", exist_ok=True)
write(res + "/values/blockcomet_horizon.xml", """<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="blockcomet_horizon_button">Horizon (Rust)</string>
    <string name="blockcomet_horizon_missing_title">Horizon is not installed</string>
    <string name="blockcomet_horizon_missing_body">Horizon is a separate app: Minecraft: Java Edition rewritten in Rust (Starling is its Android port, still experimental). Open its download page, install the APK for your phone, then come back and tap this button again.</string>
    <string name="blockcomet_horizon_download">Download page</string>
    <string name="blockcomet_horizon_error">Could not open Horizon</string>
</resources>
""")
write(res + "/values-ar/blockcomet_horizon.xml", """<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="blockcomet_horizon_button">Horizon (Rust)</string>
    <string name="blockcomet_horizon_missing_title">Horizon غير مثبّت</string>
    <string name="blockcomet_horizon_missing_body">Horizon تطبيق منفصل: ماينكرافت جافا مُعاد كتابتها بلغة Rust (و Starling هو نسخته للأندرويد، ولا يزال تجريبيًا). افتح صفحة التحميل، ثبّت ملف APK المناسب لجوالك، ثم ارجع واضغط الزر مرة ثانية.</string>
    <string name="blockcomet_horizon_download">صفحة التحميل</string>
    <string name="blockcomet_horizon_error">تعذّر فتح Horizon</string>
</resources>
""")

# 2. The class behind the button
JAVA_SRC = """package git.artdeell.mojo;

import android.app.Activity;
import android.content.Intent;
import android.widget.Toast;

import com.google.android.material.dialog.MaterialAlertDialogBuilder;

/** BlockComet: opens Horizon (Starling) when it is installed, otherwise offers its download page. */
public final class BlockCometHorizon {
    public static final String PACKAGE = "@PKG@";
    public static final String RELEASES = "@RELEASES@";

    private BlockCometHorizon() {}

    public static void open(Activity activity) {
        try {
            Intent launch = activity.getPackageManager().getLaunchIntentForPackage(PACKAGE);
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(launch);
                return;
            }
            new MaterialAlertDialogBuilder(activity)
                    .setTitle(R.string.blockcomet_horizon_missing_title)
                    .setMessage(R.string.blockcomet_horizon_missing_body)
                    .setPositiveButton(R.string.blockcomet_horizon_download, (d, w) -> Tools.openURL(activity, RELEASES))
                    .setNegativeButton(android.R.string.cancel, null)
                    .show();
        } catch (Exception e) {
            Toast.makeText(activity, R.string.blockcomet_horizon_error, Toast.LENGTH_LONG).show();
        }
    }
}
"""
write(java + "/BlockCometHorizon.java", JAVA_SRC.replace("@PKG@", PKG).replace("@RELEASES@", RELEASES))

# 3. The button, in both menu layouts (portrait and landscape), right under "Browse Content"
anchor = 'android:text="@string/mcl_button_mod_store" />'
button = anchor + """

\t\t\t<com.kdt.mcgui.LauncherMenuButton
\t\t\t\tandroid:id="@+id/horizon_button"
\t\t\t\tstyle="@style/LauncherMenuButton.Universal"
\t\t\t\tandroid:layout_width="match_parent"
\t\t\t\tandroid:drawableStart="@drawable/ic_px_gamepad"
\t\t\t\tandroid:text="@string/blockcomet_horizon_button" />"""
for folder in ("layout", "layout-land"):
    p = "%s/%s/fragment_launcher.xml" % (res, folder)
    s = read(p)
    assert s.count(anchor) == 1, "mod store button not found once in " + p
    write(p, s.replace(anchor, button, 1))

# 4. The click handler
p = java + "/fragments/MainMenuFragment.java"
s = read(p)
anchor = "mModStoreButton.setOnClickListener(v -> showContentPicker(false));"
assert s.count(anchor) == 1, "mod store handler not found once"
hook = anchor + """
        View blockCometHorizon = view.findViewById(R.id.horizon_button);
        if (blockCometHorizon != null) blockCometHorizon.setOnClickListener(v -> git.artdeell.mojo.BlockCometHorizon.open(requireActivity()));"""
write(p, s.replace(anchor, hook, 1))

# 5. Package visibility (Android 11+ hides other apps unless the manifest names them)
m = read(manifest)
if PKG not in m:
    q = '<package android:name="%s" />' % PKG
    if "<queries>" in m:
        m = m.replace("<queries>", "<queries>\n        " + q, 1)
    else:
        assert "<application" in m, "manifest has no application tag"
        m = m.replace("<application", "<queries>\n        " + q + "\n    </queries>\n    <application", 1)
    write(manifest, m)
print("horizon button added")
