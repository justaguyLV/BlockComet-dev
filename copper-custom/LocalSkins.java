package git.artdeell.mojo.skins;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

import git.artdeell.mojo.authenticator.AuthType;
import git.artdeell.mojo.authenticator.accounts.Account;
import git.artdeell.mojo.instances.Instance;
import git.artdeell.mojo.tasks.AsyncAssetManager;

/**
 * BlockComet: skins for local (offline) accounts, prepared every time the game starts.
 *
 * 1. The skin chosen in the skin editor is copied to {gameDir}/CustomSkinLoader/LocalSkin/skins/{name}.png together with its
 *    model (classic or slim), so the player sees it on their own character. If no skin is chosen, a copy left from an
 *    earlier choice is removed.
 * 2. The CustomSkinLoader mod is installed for every local account on a Fabric instance, and its configuration is written
 *    by the launcher (not left to the mod's defaults): own skin first, then the shared BlockComet skin registry (one PNG
 *    per player name in a public GitHub folder), then Mojang. A BlockComet player whose skin is in the registry is shown
 *    with it to every other BlockComet player who plays on the same server.
 */
public final class LocalSkins {
    /** {USERNAME} is replaced by CustomSkinLoader with the player name. */
    public static final String REGISTRY_SKIN_URL =
            "https://raw.githubusercontent.com/justaguyLV/blockcomet-skins/main/skins/{USERNAME}.png";

    private static final String TAG = "LocalSkins";

    private LocalSkins() {}

    public static void install(Account account, Instance instance) {
        try {
            if (account == null || instance == null || instance.versionId == null) return;
            if (account.authType != AuthType.LOCAL || account.username == null) return;
            if (!instance.versionId.startsWith("fabric-loader")) return;

            AsyncAssetManager.installSkinMod(instance);

            File root = new File(instance.getGameDirectory(), "CustomSkinLoader");
            File skins = new File(root, "LocalSkin/skins");
            //noinspection ResultOfMethodCallIgnored
            skins.mkdirs();
            File mine = new File(skins, account.username + ".png");

            SkinLibrary.Entry entry = SkinLibrary.find(SkinLibrary.getSelected(SkinLibrary.localKey(account.username)));
            boolean slim = false;
            if (entry != null) {
                slim = entry.slim;
                write(mine, SkinLibrary.readBytes(entry));
            } else if (mine.exists()) {
                //noinspection ResultOfMethodCallIgnored
                mine.delete();
            }

            write(new File(root, "CustomSkinLoader.json"), buildConfig(slim).getBytes(StandardCharsets.UTF_8));
            // An older build used ExtraList; the config above already holds the registry, so a leftover file must not add it twice
            File old = new File(root, "ExtraList/blockcomet-skins.json");
            if (old.exists()) {
                //noinspection ResultOfMethodCallIgnored
                old.delete();
            }
            Log.i(TAG, "Prepared skins for " + account.username + " (own skin: " + (entry != null) + ", slim: " + slim + ")");
        } catch (Exception e) {
            Log.w(TAG, "Could not prepare the local skin", e);
        }
    }

    /** The CustomSkinLoader configuration: the order of the sources decides which skin wins. */
    static String buildConfig(boolean slimOwnSkin) throws org.json.JSONException {
        JSONObject own = new JSONObject();
        own.put("name", "BlockComet Local");
        own.put("type", "Legacy");
        own.put("checkPNG", false);
        own.put("model", slimOwnSkin ? "slim" : "default");
        own.put("skin", "LocalSkin/skins/{USERNAME}.png");

        JSONObject registry = new JSONObject();
        registry.put("name", "BlockComet Skins");
        registry.put("type", "Legacy");
        registry.put("checkPNG", true);
        registry.put("model", "auto");
        registry.put("skin", REGISTRY_SKIN_URL);

        JSONObject mojang = new JSONObject();
        mojang.put("name", "Mojang");
        mojang.put("type", "MojangAPI");

        JSONObject config = new JSONObject();
        config.put("enable", true);
        config.put("loadlist", new JSONArray().put(own).put(registry).put(mojang));
        config.put("enableDynamicSkull", true);
        config.put("enableTransparentSkin", true);
        config.put("forceIgnoreHttpsCertificate", false);
        config.put("forceLoadAllTextures", false);
        config.put("enableCape", true);
        config.put("threadPoolSize", 4);
        config.put("enableLogStdOut", false);
        config.put("cacheExpiry", 30);
        config.put("forceUpdateSkull", false);
        config.put("enableLocalProfileCache", false);
        config.put("enableCacheAutoClean", false);
        config.put("forceDisableCache", false);
        return config.toString(2);
    }

    private static void write(File file, byte[] data) throws java.io.IOException {
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(data);
        }
    }
}
