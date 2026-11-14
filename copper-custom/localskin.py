#!/usr/bin/env python3
"""localskin.py <res-dir> <java-dir> <here>

1. Skin editor for local (offline) accounts: choose a skin from the library with one tap (no Microsoft login, no network).
   The chosen skin is put where the CustomSkinLoader mod reads local skins when the game starts.
2. Settings switch "Download performance mods" (off by default): performance mods are no longer installed by themselves.
3. At game start the bundled mods are (re)checked, so the switch takes effect without reinstalling.
"""
import os
import shutil
import sys

res, java, here = sys.argv[1:4]


def patch(path, pairs):
    s = open(path, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, "upstream changed, anchor not found in %s:\n%s" % (path, old)
        s = s.replace(old, new, 1)
    open(path, "w", encoding="utf-8").write(s)


# ---- LocalSkins helper -------------------------------------------------------------------------------------------
shutil.copy(os.path.join(here, "LocalSkins.java"), os.path.join(java, "skins", "LocalSkins.java"))

# ---- SkinLibrary: separate selection per local account name ------------------------------------------------------
patch(os.path.join(java, "skins", "SkinLibrary.java"), [(
    "    public static File fileOf(@NonNull Entry entry) {",
    "    /** Key of a local account in the selection map (local accounts all share one profile UUID, so the name is used) */\n"
    "    public static String localKey(@NonNull String username) {\n"
    "        return \"local:\" + username;\n"
    "    }\n\n"
    "    public static File fileOf(@NonNull Entry entry) {")])

# ---- Account: face of a local account (from the chosen skin) -----------------------------------------------------
patch(os.path.join(java, "authenticator", "accounts", "Account.java"), [
    ("        if(authType.skinUrl == null) return;\n        Bitmap skinBitmap = BitmapFactory.decodeByteArray(skinPng, 0, skinPng.length);",
     "        if(authType.skinUrl == null && authType != AuthType.LOCAL) return;\n        Bitmap skinBitmap = BitmapFactory.decodeByteArray(skinPng, 0, skinPng.length);"),
    ("        if(isLocal()) return null;\n        File skinFaceFile = getSkinFaceFile();",
     "        File skinFaceFile = getSkinFaceFile();"),
    ('"skin-face-" + profileId +"-"+authType.name() + ".webp"',
     '"skin-face-" + profileId +"-"+authType.name() + (authType == AuthType.LOCAL ? "-" + username : "") + ".webp"'),
])

# ---- Account list: the skin button for local accounts too --------------------------------------------------------
patch(os.path.join(java, "..", "..", "..", "com", "kdt", "mcgui", "AccountSpinner.java"), [(
    "            if(account.authType == AuthType.MICROSOFT) {\n                editButton.setVisibility(View.VISIBLE);",
    "            if(account.authType == AuthType.MICROSOFT || account.authType == AuthType.LOCAL) {\n                editButton.setVisibility(View.VISIBLE);")])

# ---- Skin editor --------------------------------------------------------------------------------------------------
patch(os.path.join(java, "skins", "SkinEditorFragment.java"), [
    ("""                if (result.account == null || result.account.authType != AuthType.MICROSOFT) {
                    result.notMicrosoft = true;
                } else {
                    loadInBackground(result, seedName);
                }""",
     """                if (result.account == null || (result.account.authType != AuthType.MICROSOFT && result.account.authType != AuthType.LOCAL)) {
                    result.notMicrosoft = true;
                } else if (result.account.authType == AuthType.LOCAL) {
                    // Local account: only the local library, nothing to download
                    result.skins = SkinLibrary.list();
                    result.selectedSkinId = SkinLibrary.getSelected(SkinLibrary.localKey(result.account.username));
                } else {
                    loadInBackground(result, seedName);
                }"""),
    ("        if (result.account != null) mAccount = result.account;\n        mLoaded = true;\n",
     """        if (result.account != null) mAccount = result.account;
        mLoaded = true;
        if (mAccount != null && mAccount.authType == AuthType.LOCAL && getView() != null) {
            // Capes belong to a Minecraft profile, a local account has none
            View capesTab = getView().findViewById(R.id.skin_tab_capes);
            if (capesTab != null) capesTab.setVisibility(View.GONE);
        }
"""),
    ("""                fresh = MinecraftSkinApi.ensureFreshSession(account);
                byte[] skinBytes = SkinLibrary.readBytes(entry);
                MinecraftSkinApi.uploadSkin(fresh.accessToken, skinBytes, slim);
                SkinLibrary.setSelected(fresh.profileId, skinId);""",
     """                byte[] skinBytes = SkinLibrary.readBytes(entry);
                if (account.authType == AuthType.LOCAL) {
                    // No upload: the skin is read from the library when the game starts
                    SkinLibrary.setSelected(SkinLibrary.localKey(account.username), skinId);
                } else {
                    fresh = MinecraftSkinApi.ensureFreshSession(account);
                    MinecraftSkinApi.uploadSkin(fresh.accessToken, skinBytes, slim);
                    SkinLibrary.setSelected(fresh.profileId, skinId);
                }"""),
])

# ---- Game start: bundled mods follow the settings switch, local skin is put in place -----------------------------
patch(os.path.join(java, "utils", "jre", "GameRunner.java"), [(
    "        File gamedir = instance.getGameDirectory();\n        JVersionList.Version versionInfo = Tools.getVersionInfo(versionId);",
    "        File gamedir = instance.getGameDirectory();\n"
    "        if (git.artdeell.mojo.tasks.AsyncAssetManager.isBundledInstance(instance)) {\n"
    "            git.artdeell.mojo.tasks.AsyncAssetManager.installBundledMods(instance); // honours \"Download performance mods\"\n"
    "        }\n"
    "        git.artdeell.mojo.skins.LocalSkins.install(account, instance);\n"
    "        JVersionList.Version versionInfo = Tools.getVersionInfo(versionId);")])

# ---- Skin editor: "Delete my published skin" (local accounts only) -----------------------------------------------
# the editor has a portrait and a landscape layout: the button goes into both
for layout_dir in ("layout", "layout-land"):
    layout_file = os.path.join(res, layout_dir, "fragment_skin_editor.xml")
    if not os.path.exists(layout_file):
        continue
    patch(layout_file, [(
        '            android:text="@string/skin_editor_slim" />\n    </LinearLayout>',
        '            android:text="@string/skin_editor_slim" />\n\n'
        '        <com.google.android.material.button.MaterialButton\n'
        '            android:id="@+id/skin_unpublish_button"\n'
        '            style="?attr/materialButtonOutlinedStyle"\n'
        '            android:layout_width="match_parent"\n'
        '            android:layout_height="wrap_content"\n'
        '            android:layout_margin="@dimen/_8sdp"\n'
        '            android:text="@string/blockcomet_unpublish_button"\n'
        '            android:visibility="gone" />\n'
        '    </LinearLayout>')])
patch(os.path.join(java, "skins", "SkinEditorFragment.java"), [
    ("        mSlimSwitch.setEnabled(false);\n        mSlimSwitch.setOnCheckedChangeListener((button, checked) -> {",
     "        View unpublishView = view.findViewById(R.id.skin_unpublish_button);\n"
     "        if (unpublishView != null) unpublishView.setOnClickListener(v -> onUnpublishClicked());\n"
     "        mSlimSwitch.setEnabled(false);\n        mSlimSwitch.setOnCheckedChangeListener((button, checked) -> {"),
    ("        if (result.account != null) mAccount = result.account;",
     "        if (result.account != null) mAccount = result.account;\n"
     "        View unpublishButton = getView() == null ? null : getView().findViewById(R.id.skin_unpublish_button);\n"
     "        if (unpublishButton != null) unpublishButton.setVisibility(mAccount != null && mAccount.authType == AuthType.LOCAL ? View.VISIBLE : View.GONE);"),
    ("    // ------------------------------------------------------------------ loading",
     "    /** BlockComet: removes the skin this local player published for the other players. */\n"
     "    private void onUnpublishClicked() {\n"
     "        if (mAccount == null || mAccount.username == null) return;\n"
     "        final android.content.Context appContext = requireContext().getApplicationContext();\n"
     "        beginBusy();\n"
     "        LocalSkins.unpublish(mAccount.username, result -> mHandler.post(() -> {\n"
     "            endBusy();\n"
     "            int message = result == LocalSkins.UNPUBLISH_OK ? R.string.blockcomet_unpublish_done\n"
     "                    : result == LocalSkins.UNPUBLISH_NOTHING ? R.string.blockcomet_unpublish_none : R.string.blockcomet_unpublish_failed;\n"
     "            android.widget.Toast.makeText(appContext, message, android.widget.Toast.LENGTH_LONG).show();\n"
     "        }));\n"
     "    }\n\n"
     "    // ------------------------------------------------------------------ loading")])

# ---- After a local player chooses a skin: offer the skin mod where it is missing, publish the skin, say how it went -------
patch(os.path.join(java, "skins", "SkinEditorFragment.java"), [
    ("Toast.makeText(requireContext(), R.string.skin_editor_skin_applied, Toast.LENGTH_SHORT).show();",
     "Toast.makeText(requireContext(), R.string.skin_editor_skin_applied, Toast.LENGTH_SHORT).show();\n"
     "                    if (finalAccount.authType == AuthType.LOCAL) onLocalSkinChosen(finalAccount.username, entry);"),
    ("    /** BlockComet: removes the skin this local player published for the other players. */",
     "    /** BlockComet: a local player chose a skin. Offers to install the skin mod where it is missing, then publishes the skin and says how it went. */\n"
     "    private void onLocalSkinChosen(@NonNull String username, @NonNull SkinLibrary.Entry entry) {\n"
     "        final android.content.Context appContext = requireContext().getApplicationContext();\n"
     "        MojoApplication.sExecutorService.execute(() -> {\n"
     "            final java.util.List<git.artdeell.mojo.instances.Instance> missing = LocalSkins.instancesWithoutSkinMod();\n"
     "            byte[] bytes = null;\n"
     "            try {\n"
     "                bytes = SkinLibrary.readBytes(entry);\n"
     "            } catch (Exception ignored) {\n"
     "                // nothing to publish then\n"
     "            }\n"
     "            final byte[] png = bytes;\n"
     "            runIfAttached(() -> {\n"
     "                if (!missing.isEmpty()) {\n"
     "                    StringBuilder names = new StringBuilder();\n"
     "                    for (git.artdeell.mojo.instances.Instance missingInstance : missing) {\n"
     "                        if (names.length() > 0) names.append(\", \");\n"
     "                        names.append(missingInstance.name);\n"
     "                    }\n"
     "                    new MaterialAlertDialogBuilder(requireContext())\n"
     "                            .setTitle(R.string.blockcomet_skinmod_title)\n"
     "                            .setMessage(getString(R.string.blockcomet_skinmod_message, names.toString()))\n"
     "                            .setPositiveButton(R.string.blockcomet_skinmod_install, (dialog, which) -> MojoApplication.sExecutorService.execute(() -> {\n"
     "                                final int have = LocalSkins.installSkinModEverywhere();\n"
     "                                mHandler.post(() -> android.widget.Toast.makeText(appContext,\n"
     "                                        have > 0 ? R.string.blockcomet_skinmod_installed : R.string.blockcomet_skinmod_unavailable,\n"
     "                                        android.widget.Toast.LENGTH_LONG).show());\n"
     "                            }))\n"
     "                            .setNegativeButton(R.string.blockcomet_skinmod_later, null)\n"
     "                            .show();\n"
     "                }\n"
     "                if (png != null) publishChosenSkin(username, png, appContext);\n"
     "            });\n"
     "        });\n"
     "    }\n\n"
     "    /** Uploads the chosen skin to the BlockComet skin service right away, so the player sees at once whether it was stored. */\n"
     "    private void publishChosenSkin(String username, byte[] png, android.content.Context appContext) {\n"
     "        LocalSkins.publishNow(username, png, code -> mHandler.post(() -> {\n"
     "            int message = code == 200 ? R.string.blockcomet_publish_done\n"
     "                    : code == LocalSkins.PUBLISH_OFF ? 0\n"
     "                    : code == LocalSkins.PUBLISH_NO_SERVICE ? R.string.blockcomet_publish_no_service\n"
     "                    : code == 400 ? R.string.blockcomet_publish_invalid\n"
     "                    : code == 403 ? R.string.blockcomet_publish_taken\n"
     "                    : R.string.blockcomet_publish_failed;\n"
     "            if (message != 0) android.widget.Toast.makeText(appContext, message, android.widget.Toast.LENGTH_LONG).show();\n"
     "        }));\n"
     "    }\n\n"
     "    /** BlockComet: removes the skin this local player published for the other players. */"),
])

# ---- Settings switch + texts ---------------------------------------------------------------------------------------
patch(os.path.join(res, "xml", "pref_misc.xml"), [(
    "<git.artdeell.mojo.prefs.BackButtonPreference />",
    "<git.artdeell.mojo.prefs.BackButtonPreference />\n"
    "    <SwitchPreferenceCompat\n"
    "        android:widgetLayout=\"@layout/preference_widget_material_switch\"\n"
    "        android:defaultValue=\"false\"\n"
    "        android:key=\"blockcomet_perf_mods\"\n"
    "        android:title=\"@string/blockcomet_perf_mods_title\"\n"
    "        android:summary=\"@string/blockcomet_perf_mods_desc\" />\n"
    "    <SwitchPreferenceCompat\n"
    "        android:widgetLayout=\"@layout/preference_widget_material_switch\"\n"
    "        android:defaultValue=\"true\"\n"
    "        android:key=\"blockcomet_share_skin\"\n"
    "        android:title=\"@string/blockcomet_share_skin_title\"\n"
    "        android:summary=\"@string/blockcomet_share_skin_desc\" />")])

en = '''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="blockcomet_perf_mods_title">Download performance mods</string>
    <string name="blockcomet_perf_mods_desc">Add FerriteCore, Lithium, ModernFix, Krypton, Noisium, MemoryLeakFix and ScalableLux to the Meteor instances the next time a game starts. Off by default: nothing is added without your permission, and turning it off never removes mods you already have.</string>
    <string name="blockcomet_share_skin_title">Share my skin with other players</string>
    <string name="blockcomet_share_skin_desc">When you start a game with a local account, your chosen skin is published under your player name so other BlockComet players see it. Turn this off to keep your skin on this phone only.</string>
    <string name="blockcomet_unpublish_button">Delete my published skin</string>
    <string name="blockcomet_unpublish_done">Your skin was removed for other players. Choose another skin and it is published the next time a game starts.</string>
    <string name="blockcomet_unpublish_none">No skin of this name was published from this phone.</string>
    <string name="blockcomet_unpublish_failed">Could not remove it. Check your connection and try again.</string>
    <string name="blockcomet_skinmod_title">Install the skin mod?</string>
    <string name="blockcomet_skinmod_message">Skins are shown in the game by the CustomSkinLoader mod, and it is not installed in: %s. Install it now?</string>
    <string name="blockcomet_skinmod_install">Install</string>
    <string name="blockcomet_skinmod_later">Not now</string>
    <string name="blockcomet_skinmod_installed">Skin mod installed. Start the game to see your skin.</string>
    <string name="blockcomet_skinmod_unavailable">There is no skin mod for this Minecraft version.</string>
    <string name="blockcomet_publish_done">Your skin is saved on the server. Other BlockComet players will see it.</string>
    <string name="blockcomet_publish_invalid">The server refused the skin: it must be a 64x64 (or 64x32) PNG under 24 KB.</string>
    <string name="blockcomet_publish_taken">This name was claimed from another device, so the skin cannot be published under it.</string>
    <string name="blockcomet_publish_failed">Could not publish the skin. Check your connection and try again.</string>
    <string name="blockcomet_publish_no_service">This build has no skin service, so other players will not see your skin.</string>
</resources>
'''
ar = '''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="blockcomet_perf_mods_title">تنزيل مودات الأداء</string>
    <string name="blockcomet_perf_mods_desc">يضيف FerriteCore وLithium وModernFix وKrypton وNoisium وMemoryLeakFix وScalableLux إلى نسخ Meteor عند تشغيل اللعبة المرة القادمة. معطّل افتراضيًا: لا يُضاف أي مود بدون إذنك، وإيقافه لا يحذف مودات موجودة عندك.</string>
    <string name="blockcomet_share_skin_title">مشاركة سكني مع اللاعبين</string>
    <string name="blockcomet_share_skin_desc">عند تشغيل لعبة بحساب محلي يُنشر السكن الذي اخترته باسم لاعبك ليراه لاعبو BlockComet الآخرون. أوقفه إن أردت إبقاء سكنك على هذا الجوال فقط.</string>
    <string name="blockcomet_unpublish_button">حذف سكني المنشور</string>
    <string name="blockcomet_unpublish_done">تم حذف سكنك عند اللاعبين. اختر سكنًا آخر وسيُنشر عند تشغيل اللعبة المرة القادمة.</string>
    <string name="blockcomet_unpublish_none">لا يوجد سكن منشور بهذا الاسم من هذا الجوال.</string>
    <string name="blockcomet_unpublish_failed">تعذّر الحذف. تحقق من الاتصال وحاول مرة أخرى.</string>
    <string name="blockcomet_skinmod_title">تثبيت مود السكنات؟</string>
    <string name="blockcomet_skinmod_message">السكنات تظهر في اللعبة عن طريق مود CustomSkinLoader، وهو غير مثبّت في: %s. هل تريد تثبيته الآن؟</string>
    <string name="blockcomet_skinmod_install">تثبيت</string>
    <string name="blockcomet_skinmod_later">ليس الآن</string>
    <string name="blockcomet_skinmod_installed">تم تثبيت مود السكنات. شغّل اللعبة ليظهر سكنك.</string>
    <string name="blockcomet_skinmod_unavailable">لا يوجد مود سكنات لنسخة ماينكرافت هذه.</string>
    <string name="blockcomet_publish_done">تم حفظ سكنك على الخادم وسيراه لاعبو BlockComet الآخرون.</string>
    <string name="blockcomet_publish_invalid">رفض الخادم السكن: يجب أن يكون PNG بحجم 64×64 (أو 64×32) وأقل من 24 كيلوبايت.</string>
    <string name="blockcomet_publish_taken">هذا الاسم محجوز من جهاز آخر، لذلك لا يمكن نشر السكن به.</string>
    <string name="blockcomet_publish_failed">تعذّر نشر السكن. تحقق من الاتصال وحاول مرة أخرى.</string>
    <string name="blockcomet_publish_no_service">هذا الإصدار بلا خادم سكنات، فلن يراه اللاعبون الآخرون.</string>
</resources>
'''
os.makedirs(os.path.join(res, "values-ar"), exist_ok=True)
open(os.path.join(res, "values", "blockcomet_skin_perf.xml"), "w", encoding="utf-8").write(en)
open(os.path.join(res, "values-ar", "blockcomet_skin_perf.xml"), "w", encoding="utf-8").write(ar)
print("localskin: done")
