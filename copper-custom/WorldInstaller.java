package git.artdeell.mojo.modding.modpacks.api;

import androidx.annotation.NonNull;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Enumeration;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Unpacks a world downloaded from CurseForge into the instance's saves folder. A world zip is packed in different ways:
 * the world folder inside a zip, the world files straight at the top, or a few folders deep. The folder that holds the
 * shallowest level.dat is the world.
 */
public final class WorldInstaller {
    private WorldInstaller() {}

    /** Returns the name of the folder the world was put in. */
    @NonNull
    public static String install(@NonNull File zipFile, @NonNull File savesDir) throws IOException {
        try (ZipFile zip = new ZipFile(zipFile)) {
            String root = null;
            int bestDepth = Integer.MAX_VALUE;
            Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                String name = entry.getName().replace('\\', '/');
                if (entry.isDirectory() || name.startsWith("__MACOSX/")) continue;
                if (!(name.equals("level.dat") || name.endsWith("/level.dat"))) continue;
                int depth = 0;
                for (int i = 0; i < name.length(); i++) if (name.charAt(i) == '/') depth++;
                if (depth < bestDepth) {
                    bestDepth = depth;
                    root = name.substring(0, name.length() - "level.dat".length());
                }
            }
            if (root == null) throw new IOException("There is no level.dat in this download, so it is not a Minecraft world.");

            String folder = root.isEmpty() ? stripExtension(zipFile.getName()) : lastSegment(root);
            folder = folder.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
            if (folder.isEmpty()) folder = "World";

            if (!savesDir.exists() && !savesDir.mkdirs()) throw new IOException("Could not create " + savesDir);
            File target = new File(savesDir, folder);
            for (int n = 2; target.exists(); n++) target = new File(savesDir, folder + " (" + n + ")");
            if (!target.mkdirs()) throw new IOException("Could not create " + target);
            final String targetPath = target.getCanonicalPath() + File.separator;

            entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                String name = entry.getName().replace('\\', '/');
                if (entry.isDirectory() || name.startsWith("__MACOSX/") || !name.startsWith(root)) continue;
                File out = new File(target, name.substring(root.length()));
                // an entry like ../../x must never leave the world folder
                if (!out.getCanonicalPath().startsWith(targetPath)) continue;
                File parent = out.getParentFile();
                if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("Could not create " + parent);
                try (InputStream in = zip.getInputStream(entry); OutputStream os = new FileOutputStream(out)) {
                    byte[] buffer = new byte[16384];
                    int read;
                    while ((read = in.read(buffer)) != -1) os.write(buffer, 0, read);
                }
            }
            return target.getName();
        }
    }

    private static String stripExtension(String fileName) {
        return fileName.toLowerCase(Locale.ROOT).endsWith(".zip") ? fileName.substring(0, fileName.length() - 4) : fileName;
    }

    private static String lastSegment(String root) {
        String trimmed = root.endsWith("/") ? root.substring(0, root.length() - 1) : root;
        return trimmed.substring(trimmed.lastIndexOf('/') + 1);
    }
}
