package git.artdeell.mojo.skins;

import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

import git.artdeell.mojo.authenticator.AuthType;
import git.artdeell.mojo.authenticator.accounts.Account;
import git.artdeell.mojo.instances.Instance;
import git.artdeell.mojo.tasks.AsyncAssetManager;

/**
 * BlockComet: skins for local (offline) accounts.
 *
 * 1. The skin the user chose in the skin editor is written where the CustomSkinLoader mod looks for local skins
 *    ({gameDir}/CustomSkinLoader/LocalSkin/skins/{name}.png): the player sees it on their own character.
 * 2. For every local account on a Fabric instance the mod is installed and the shared BlockComet skin registry is added
 *    to its sources (CustomSkinLoader "ExtraList"). The registry is a public GitHub folder with one PNG per player name,
 *    so every BlockComet player who published a skin there is seen with it by every other BlockComet player.
 */
public final class LocalSkins {
    /** {USERNAME} is replaced by CustomSkinLoader with the player name. */
    public static final String REGISTRY_SKIN_URL =
            "https://raw.githubusercontent.com/justaguyLV/blockcomet-skins/main/skins/{USERNAME}.png";

    private LocalSkins() {}

    public static void install(Account account, Instance instance) {
        try {
            if (account == null || instance == null || instance.versionId == null) return;
            if (account.authType != AuthType.LOCAL || account.username == null) return;
            if (!instance.versionId.startsWith("fabric-loader")) return;

            AsyncAssetManager.installSkinMod(instance);
            writeRegistrySource(instance);

            SkinLibrary.Entry entry = SkinLibrary.find(SkinLibrary.getSelected(SkinLibrary.localKey(account.username)));
            if (entry == null) return;
            File dir = new File(instance.getGameDirectory(), "CustomSkinLoader/LocalSkin/skins");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            byte[] png = SkinLibrary.readBytes(entry);
            try (FileOutputStream out = new FileOutputStream(new File(dir, account.username + ".png"))) {
                out.write(png);
            }
        } catch (Exception e) {
            Log.w("LocalSkins", "Could not prepare the local skin", e);
        }
    }

    /** CustomSkinLoader reads this file at start, adds the source to its list once and deletes the file (a duplicate is ignored). */
    private static void writeRegistrySource(Instance instance) throws java.io.IOException {
        File dir = new File(instance.getGameDirectory(), "CustomSkinLoader/ExtraList");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        String json = "{\"name\":\"BlockComet Skins\",\"type\":\"Legacy\",\"checkPNG\":true,\"model\":\"auto\","
                + "\"skin\":\"" + REGISTRY_SKIN_URL + "\"}";
        try (FileOutputStream out = new FileOutputStream(new File(dir, "blockcomet-skins.json"))) {
            out.write(json.getBytes(StandardCharsets.UTF_8));
        }
    }
}
