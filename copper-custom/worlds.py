#!/usr/bin/env python3
"""worlds.py <res-dir> <java-dir> <here>

Content browser: a fourth kind of content, "Worlds" (CurseForge category 17). A world is downloaded as a zip and unpacked
into the instance's saves folder. Modrinth has no worlds, so this kind only searches CurseForge.
"""
import os
import re
import shutil
import sys

res, java, here = sys.argv[1:4]


def patch(path, pairs):
    s = open(path, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, "upstream changed, anchor not found in %s:\n%s" % (path, old)
        s = s.replace(old, new, 1)
    open(path, "w", encoding="utf-8").write(s)


shutil.copy(os.path.join(here, "WorldInstaller.java"), os.path.join(java, "modding", "modpacks", "api", "WorldInstaller.java"))

# the new kind
patch(os.path.join(java, "modding", "modpacks", "models", "ContentType.java"), [
    ('SHADER_PACK("shaderpacks", ".zip", "shader", 6552);',
     'SHADER_PACK("shaderpacks", ".zip", "shader", 6552),\n'
     '    // CurseForge category "Worlds"; unpacked into saves/ after the download (see WorldInstaller)\n'
     '    WORLD("saves", ".zip", "world", 17);'),
    ('            case "shader":       return SHADER_PACK;\n',
     '            case "shader":       return SHADER_PACK;\n            case "world":        return WORLD;\n'),
])

# Modrinth has no worlds
patch(os.path.join(java, "modding", "modpacks", "api", "CommonApi.java"), [(
    "            if(!isEngineIncluded(mModpackApiSources[i], searchFilters.engine)) continue;",
    "            if (searchFilters.contentType == git.artdeell.mojo.modding.modpacks.models.ContentType.WORLD\n"
    "                    ? mModpackApiSources[i] != Constants.SOURCE_CURSEFORGE\n"
    "                    : !isEngineIncluded(mModpackApiSources[i], searchFilters.engine)) continue;")])

# the download: a world is unpacked, the zip is only the way it travels
patch(os.path.join(java, "fragments", "ModsSearchFragment.java"), [(
    "                    DownloadUtils.downloadFile(url, targetFile);\n\n                    // This is an update/downgrade",
    "                    DownloadUtils.downloadFile(url, targetFile);\n\n"
    "                    if (mFilters.contentType == ContentType.WORLD) {\n"
    "                        String worldName;\n"
    "                        try {\n"
    "                            worldName = git.artdeell.mojo.modding.modpacks.api.WorldInstaller.install(targetFile, modsDir);\n"
    "                        } finally {\n"
    "                            //noinspection ResultOfMethodCallIgnored\n"
    "                            targetFile.delete();\n"
    "                        }\n"
    "                        final String installedName = worldName;\n"
    "                        ProgressLayout.clearProgress(ProgressLayout.INSTALL_MODPACK);\n"
    "                        Tools.runOnUiThread(() -> Toast.makeText(context,\n"
    "                                context.getString(R.string.blockcomet_world_installed, installedName), Toast.LENGTH_LONG).show());\n"
    "                        return;\n"
    "                    }\n\n"
    "                    // This is an update/downgrade")])

patch(os.path.join(java, "fragments", "ModsSearchFragment.java"), [(
    "            case SHADER_PACK:   return R.string.hint_search_shaderpack;\n",
    "            case SHADER_PACK:   return R.string.hint_search_shaderpack;\n"
    "            case WORLD:         return R.string.blockcomet_hint_search_world;\n")])

patch(os.path.join(java, "fragments", "ContentDetailFragment.java"), [(
    "        if (type == ContentType.SHADER_PACK) return R.string.content_kind_shaderpack;\n",
    "        if (type == ContentType.SHADER_PACK) return R.string.content_kind_shaderpack;\n"
    "        if (type == ContentType.WORLD) return R.string.blockcomet_content_kind_world;\n")])

# the two places that list the kinds: the landscape pane and the dialog
patch(os.path.join(java, "fragments", "ContentPickerFragment.java"), [
    ("        View shaderpacksButton = view.findViewById(R.id.content_picker_shaderpacks);\n",
     "        View shaderpacksButton = view.findViewById(R.id.content_picker_shaderpacks);\n"
     "        View worldsButton = view.findViewById(R.id.content_picker_worlds);\n"),
    ("                v -> mainMenuFragment.selectContentType(manage, ContentType.SHADER_PACK));\n",
     "                v -> mainMenuFragment.selectContentType(manage, ContentType.SHADER_PACK));\n"
     "        if (worldsButton != null) worldsButton.setOnClickListener(\n"
     "                v -> mainMenuFragment.selectContentType(manage, ContentType.WORLD));\n"),
])
patch(os.path.join(java, "fragments", "MainMenuFragment.java"), [
    ("            View shaderpacksButton = dialog.findViewById(R.id.content_picker_shaderpacks);\n",
     "            View shaderpacksButton = dialog.findViewById(R.id.content_picker_shaderpacks);\n"
     "            View worldsButton = dialog.findViewById(R.id.content_picker_worlds);\n"),
    ("                onContentTypeChosen(manage, ContentType.SHADER_PACK);\n            });\n",
     "                onContentTypeChosen(manage, ContentType.SHADER_PACK);\n            });\n"
     "            if (worldsButton != null) worldsButton.setOnClickListener(v -> {\n"
     "                dialog.dismiss();\n"
     "                onContentTypeChosen(manage, ContentType.WORLD);\n"
     "            });\n"),
    ("    private void onContentTypeChosen(boolean manage, ContentType contentType) {\n        if (manage) {",
     "    private void onContentTypeChosen(boolean manage, ContentType contentType) {\n"
     "        if (manage && contentType == ContentType.WORLD) {\n"
     "            // worlds are folders, not files: the game's Singleplayer screen is where they are managed\n"
     "            Toast.makeText(requireContext(), R.string.blockcomet_world_manage_hint, Toast.LENGTH_LONG).show();\n"
     "            return;\n"
     "        }\n"
     "        if (manage) {"),
])

button = (
    '\n    <com.kdt.mcgui.LauncherMenuButton\n'
    '        android:id="@+id/content_picker_worlds"\n'
    '        style="@style/LauncherMenuButton.Universal"\n'
    '        android:layout_width="match_parent"\n'
    '        android:drawableStart="@drawable/ic_menu_install_jar"\n'
    '        android:text="@string/blockcomet_content_worlds" />\n')
dialog_button = (
    '\n\n    <com.kdt.mcgui.MineButton\n'
    '        android:id="@+id/content_picker_worlds"\n'
    '        android:layout_width="match_parent"\n'
    '        android:layout_height="wrap_content"\n'
    '        android:layout_marginTop="@dimen/padding_large"\n'
    '        android:text="@string/blockcomet_content_worlds" />\n')
path = os.path.join(res, "layout", "fragment_content_picker.xml")
s2 = open(path, encoding="utf-8").read()
pattern = re.compile(r'<com\.kdt\.mcgui\.LauncherMenuButton[^>]*?content_picker_shaderpacks[^>]*?/>', re.S)
assert len(pattern.findall(s2)) == 1, "shader button not found once in fragment_content_picker.xml"
open(path, "w", encoding="utf-8").write(pattern.sub(lambda m: m.group(0) + button, s2, count=1))
path = os.path.join(res, "layout", "dialog_content_picker.xml")
s2 = open(path, encoding="utf-8").read()
pattern = re.compile(r'<com\.kdt\.mcgui\.MineButton[^>]*?content_picker_shaderpacks[^>]*?/>', re.S)
assert len(pattern.findall(s2)) == 1, "shader button not found once in dialog_content_picker.xml"
open(path, "w", encoding="utf-8").write(pattern.sub(lambda m: m.group(0) + dialog_button, s2, count=1))

strings = {
    "values": {
        "blockcomet_content_worlds": "Worlds",
        "blockcomet_content_kind_world": "World",
        "blockcomet_world_installed": "World \"%1$s\" added. Open it from Singleplayer in the game.",
        "blockcomet_world_manage_hint": "Worlds are managed from the Singleplayer screen inside the game.",
        "blockcomet_hint_search_world": "Search worlds (CurseForge)",
    },
    "values-ar": {
        "blockcomet_content_worlds": "العوالم",
        "blockcomet_content_kind_world": "عالم",
        "blockcomet_world_installed": "تمت إضافة العالم \"%1$s\". افتحه من Singleplayer داخل اللعبة.",
        "blockcomet_world_manage_hint": "تُدار العوالم من شاشة Singleplayer داخل اللعبة.",
        "blockcomet_hint_search_world": "ابحث عن عوالم (CurseForge)",
    },
}
for folder, items in strings.items():
    os.makedirs(os.path.join(res, folder), exist_ok=True)
    body = "".join('    <string name="%s">%s</string>\n' % (k, v.replace('"', '\\"')) for k, v in items.items())
    open(os.path.join(res, folder, "blockcomet_worlds.xml"), "w", encoding="utf-8").write(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n' + body + '</resources>\n')
print("worlds: done")
