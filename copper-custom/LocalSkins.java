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
 *    per player name, served by the BlockComet skin service on Cloudflare), then Mojang. The launcher publishes the
 *    player's own skin there, so every other BlockComet player on the same server sees it.
 */
public final class LocalSkins {
    /** Base URL of the BlockComet skin service (Cloudflare Worker), without a trailing slash; empty when this build has none. */
    private static final String SKINS_API = "@SKINS_API@".replaceAll("/+$", "");
    /** Read-only fallback when the build has no skin service. {USERNAME} is replaced by CustomSkinLoader with the player name. */
    private static final String GITHUB_SKIN_URL =
            "https://raw.githubusercontent.com/justaguyLV/blockcomet-skins/main/skins/{USERNAME}.png";
    public static final String REGISTRY_SKIN_URL = SKINS_API.isEmpty() ? GITHUB_SKIN_URL : SKINS_API + "/skins/{USERNAME}.png";

    private static final String TAG = "LocalSkins";

    private LocalSkins() {}

    public static void install(Account account, Instance instance) {
        try {
            if (account == null || instance == null || instance.versionId == null) return;
            if (account.authType != AuthType.LOCAL || account.username == null) return;
            if (loaderOf(instance) == null) return;

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
                byte[] png = SkinLibrary.readBytes(entry);
                write(mine, png);
                publish(account.username, png);
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

    /** Address of the BlockComet skin service, empty when this build has none. */
    public static String skinsApi() {
        return SKINS_API;
    }

    /** Result codes of {@link #publishNow}, besides the HTTP codes of the skin service (200 stored, 400 not a valid skin, 403 name belongs to another phone). */
    public static final int PUBLISH_ERROR = -1;
    public static final int PUBLISH_OFF = -2;
    public static final int PUBLISH_NO_SERVICE = -3;

    public interface PublishCallback {
        void done(int code);
    }

    /**
     * Puts the player's skin on the BlockComet skin service so the other BlockComet players see it. Done in the background,
     * only when the skin changed, and only if the "Share my skin" switch is on. The name is claimed with a secret that
     * stays on this device: nobody else can replace the skin of that name.
     */
    private static void publish(String username, byte[] png) {
        upload(username, png, false, null);
    }

    /** Uploads the skin right now (the player has just chosen it) and tells the callback how it went. */
    public static void publishNow(String username, byte[] png, PublishCallback callback) {
        upload(username, png, true, callback);
    }

    private static void upload(String username, byte[] png, boolean force, PublishCallback callback) {
        try {
            if (SKINS_API.isEmpty()) {
                if (callback != null) callback.done(PUBLISH_NO_SERVICE);
                return;
            }
            if (!git.artdeell.mojo.prefs.LauncherPreferences.DEFAULT_PREF.getBoolean("blockcomet_share_skin", true)) {
                if (callback != null) callback.done(PUBLISH_OFF);
                return;
            }
            final android.content.SharedPreferences prefs = AsyncAssetManager.getBundlePrefs();
            final String lower = username.toLowerCase(java.util.Locale.ROOT);
            final String hash = hex(java.security.MessageDigest.getInstance("SHA-256").digest(png));
            final String doneKey = "skin_published_" + lower;
            if (!force && hash.equals(prefs.getString(doneKey, null))) {
                syncListing(username, lower, prefs);
                return;
            }
            final boolean listed = git.artdeell.mojo.prefs.LauncherPreferences.DEFAULT_PREF.getBoolean("blockcomet_list_skin", false);
            final String tokenKey = "skin_token_" + lower;
            String token = prefs.getString(tokenKey, null);
            if (token == null) {
                byte[] random = new byte[24];
                new java.security.SecureRandom().nextBytes(random);
                token = hex(random);
                prefs.edit().putString(tokenKey, token).commit();
            }
            final String finalToken = token;
            final String target = SKINS_API + "/skins/" + username + ".png";
            Thread thread = new Thread(() -> {
                java.net.HttpURLConnection connection = null;
                int code = PUBLISH_ERROR;
                try {
                    connection = (java.net.HttpURLConnection) new java.net.URL(target).openConnection();
                    connection.setRequestMethod("PUT");
                    connection.setConnectTimeout(8000);
                    connection.setReadTimeout(8000);
                    connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", "image/png");
                    connection.setRequestProperty("X-Skin-Token", finalToken);
                    connection.setRequestProperty("X-Skin-Listed", listed ? "1" : "0");
                    try (java.io.OutputStream out = connection.getOutputStream()) {
                        out.write(png);
                    }
                    code = connection.getResponseCode();
                    if (code == 200) {
                        prefs.edit().putString(doneKey, hash).putBoolean("skin_listed_" + lower, listed).apply();
                        Log.i(TAG, "Skin of " + username + " published");
                    } else {
                        Log.w(TAG, "Skin of " + username + " not published, HTTP " + code);
                    }
                } catch (Exception e) {
                    Log.w(TAG, "Skin of " + username + " not published", e);
                } finally {
                    if (connection != null) connection.disconnect();
                }
                if (callback != null) callback.done(code);
            }, "BlockCometSkinPublish");
            thread.setDaemon(true);
            thread.start();
        } catch (Exception e) {
            Log.w(TAG, "Could not start publishing the skin", e);
            if (callback != null) callback.done(PUBLISH_ERROR);
        }
    }

    /** "fabric", "forge" or "neoforge"; null for vanilla and other loaders, where CustomSkinLoader has no way in. */
    public static String loaderOf(Instance instance) {
        if (instance == null || instance.versionId == null) return null;
        String id = instance.versionId.toLowerCase(java.util.Locale.ROOT);
        if (id.startsWith("fabric-loader")) return "fabric";
        if (id.contains("neoforge")) return "neoforge";
        if (id.contains("forge")) return "forge";
        return null;
    }

    /** True when the bundled skin mod fits this instance: a supported loader and a Minecraft version it covers. */
    public static boolean supportsSkinMod(Instance instance) {
        if (loaderOf(instance) == null) return false;
        return AsyncAssetManager.getSkinModGameVersions().contains(AsyncAssetManager.gameVersionOf(instance));
    }

    /** True when at least one instance can show custom skins. */
    public static boolean anyInstanceSupportsSkins() {
        try {
            for (Instance instance : git.artdeell.mojo.instances.Instances.loadAllInstances()) {
                if (supportsSkinMod(instance)) return true;
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not list the instances", e);
        }
        return false;
    }

    /** "1.20.1, 1.20.2, ..." for the warning texts. */
    public static String supportedVersionsText() {
        return android.text.TextUtils.join(", ", AsyncAssetManager.getSkinModGameVersions());
    }

    /** The skin did not change, but the player may have switched "Show my skin in the gallery": tell the service without uploading again. */
    private static void syncListing(String username, String lower, android.content.SharedPreferences prefs) {
        try {
            final String token = prefs.getString("skin_token_" + lower, null);
            if (token == null) return;
            final boolean listed = git.artdeell.mojo.prefs.LauncherPreferences.DEFAULT_PREF.getBoolean("blockcomet_list_skin", false);
            final String listedKey = "skin_listed_" + lower;
            if (prefs.contains(listedKey) && prefs.getBoolean(listedKey, false) == listed) return;
            final String target = SKINS_API + "/skins/" + username + ".png";
            Thread thread = new Thread(() -> {
                java.net.HttpURLConnection connection = null;
                try {
                    connection = (java.net.HttpURLConnection) new java.net.URL(target).openConnection();
                    connection.setRequestMethod("POST"); // the service treats POST like PATCH; HttpURLConnection cannot send PATCH
                    connection.setConnectTimeout(8000);
                    connection.setReadTimeout(8000);
                    connection.setRequestProperty("X-Skin-Token", token);
                    connection.setRequestProperty("X-Skin-Listed", listed ? "1" : "0");
                    int code = connection.getResponseCode();
                    if (code == 200) prefs.edit().putBoolean(listedKey, listed).apply();
                    Log.i(TAG, "Gallery listing of " + username + " set to " + listed + ", HTTP " + code);
                } catch (Exception e) {
                    Log.w(TAG, "Could not update the gallery listing", e);
                } finally {
                    if (connection != null) connection.disconnect();
                }
            }, "BlockCometSkinListing");
            thread.setDaemon(true);
            thread.start();
        } catch (Exception e) {
            Log.w(TAG, "Could not start the gallery listing update", e);
        }
    }

    /** True when a CustomSkinLoader jar (not switched off) is in the instance's mods folder. */
    public static boolean hasSkinMod(Instance instance) {
        File[] files = new File(instance.getGameDirectory(), "mods").listFiles();
        if (files == null) return false;
        for (File file : files) {
            String name = file.getName().toLowerCase(java.util.Locale.ROOT);
            if (name.startsWith("customskinloader") && name.endsWith(".jar")) return true;
        }
        return false;
    }

    /** Fabric instances without the skin mod (it only exists for Fabric). */
    public static java.util.List<Instance> instancesWithoutSkinMod() {
        java.util.List<Instance> missing = new java.util.ArrayList<>();
        try {
            for (Instance instance : git.artdeell.mojo.instances.Instances.loadAllInstances()) {
                if (supportsSkinMod(instance) && !hasSkinMod(instance)) missing.add(instance);
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not list the instances", e);
        }
        return missing;
    }

    /**
     * The player agreed to install the skin mod: it goes into every Fabric instance, also where it was switched off or
     * removed before. Returns how many instances have it afterwards.
     */
    public static int installSkinModEverywhere() {
        int have = 0;
        try {
            final android.content.SharedPreferences prefs = AsyncAssetManager.getBundlePrefs();
            final android.content.SharedPreferences.Editor edit = prefs.edit();
            for (String key : new java.util.ArrayList<>(prefs.getAll().keySet())) {
                if (key.startsWith("mod_") && key.contains("CustomSkinLoader")) edit.remove(key);
            }
            edit.commit();
            for (Instance instance : git.artdeell.mojo.instances.Instances.loadAllInstances()) {
                if (!supportsSkinMod(instance)) continue;
                File mods = new File(instance.getGameDirectory(), "mods");
                File[] files = mods.listFiles();
                if (files != null) {
                    for (File file : files) {
                        String name = file.getName();
                        if (name.startsWith("CustomSkinLoader") && name.endsWith(".jar.disabled")) {
                            //noinspection ResultOfMethodCallIgnored
                            file.renameTo(new File(mods, name.substring(0, name.length() - ".disabled".length())));
                        }
                    }
                }
                AsyncAssetManager.installSkinMod(instance);
                if (hasSkinMod(instance)) have++;
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not install the skin mod", e);
        }
        return have;
    }

    public static final int UNPUBLISH_OK = 0;
    public static final int UNPUBLISH_NOTHING = 1;
    public static final int UNPUBLISH_FAILED = 2;

    public interface Callback {
        void done(int result);
    }

    /**
     * Removes the player's published skin from the BlockComet skin service (only the device that published it can).
     * The skin that is chosen now is not published again; choosing another one publishes that one at the next game start.
     */
    public static void unpublish(String username, Callback callback) {
        Thread thread = new Thread(() -> {
            int result = UNPUBLISH_FAILED;
            java.net.HttpURLConnection connection = null;
            try {
                final android.content.SharedPreferences prefs = AsyncAssetManager.getBundlePrefs();
                final String lower = username.toLowerCase(java.util.Locale.ROOT);
                final String token = prefs.getString("skin_token_" + lower, null);
                if (SKINS_API.isEmpty() || token == null) {
                    result = UNPUBLISH_NOTHING;
                } else {
                    connection = (java.net.HttpURLConnection) new java.net.URL(SKINS_API + "/skins/" + username + ".png").openConnection();
                    connection.setRequestMethod("DELETE");
                    connection.setConnectTimeout(8000);
                    connection.setReadTimeout(8000);
                    connection.setRequestProperty("X-Skin-Token", token);
                    int code = connection.getResponseCode();
                    if (code == 200 || code == 404) {
                        result = code == 200 ? UNPUBLISH_OK : UNPUBLISH_NOTHING;
                        SkinLibrary.Entry entry = SkinLibrary.find(SkinLibrary.getSelected(SkinLibrary.localKey(username)));
                        if (entry != null) {
                            String hash = hex(java.security.MessageDigest.getInstance("SHA-256").digest(SkinLibrary.readBytes(entry)));
                            prefs.edit().putString("skin_published_" + lower, hash).apply();
                        }
                    }
                    Log.i(TAG, "Unpublish " + username + ": HTTP " + code);
                }
            } catch (Exception e) {
                Log.w(TAG, "Could not remove the published skin", e);
            } finally {
                if (connection != null) connection.disconnect();
            }
            if (callback != null) callback.done(result);
        }, "BlockCometSkinUnpublish");
        thread.setDaemon(true);
        thread.start();
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format(java.util.Locale.ROOT, "%02x", b));
        return sb.toString();
    }

    private static void write(File file, byte[] data) throws java.io.IOException {
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(data);
        }
    }
}
