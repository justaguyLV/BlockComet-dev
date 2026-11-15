package git.artdeell.mojo.record;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.DisplayMetrics;
import android.view.View;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.hbisoft.hbrecorder.HBRecorder;
import com.hbisoft.hbrecorder.HBRecorderListener;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.List;
import java.util.Locale;

import git.artdeell.mojo.game.GameActivity;
import git.artdeell.mojo.input.ControlLayout;

/**
 * BlockComet in-game video recording. Wraps the open-source HBRecorder library (MIT), which uses Android's own
 * screen-capture API, so it behaves the same on every device (no per-chip or per-vendor code).
 * Videos are saved in the launcher's own folder (Android/data/&lt;app&gt;/files/Recordings) and listed in "My videos".
 */
public final class BlockCometRecorder {
    private BlockCometRecorder() {}

    private static final String PREFS = "blockcomet_recorder";
    private static HBRecorder sRecorder;
    private static GameActivity sActivity;
    private static boolean sControlsWereVisible;
    private static boolean sControlsHidden;
    private static int[] sSavedVisibility = new int[0];

    private static boolean ar() { return "ar".equals(Locale.getDefault().getLanguage()); }
    private static String t(String en, String arabic) { return ar() ? arabic : en; }
    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    /** The in-game menu entries plus our own. */
    public static String[] menuItems(Context c, String[] base) {
        String[] out = Arrays.copyOf(base, base.length + 1);
        out[base.length] = t("Video recording", "تسجيل الفيديو");
        return out;
    }

    public static File recordingsDir(Context c) {
        File base = c.getExternalFilesDir("Recordings");
        if (base == null) base = new File(c.getFilesDir(), "Recordings");
        //noinspection ResultOfMethodCallIgnored
        base.mkdirs();
        return base;
    }

    // ---- main dialog -------------------------------------------------------------------------------------------

    public static void open(GameActivity act) {
        sActivity = act;
        boolean busy = sRecorder != null && sRecorder.isBusyRecording();
        if (!busy) setControlsHidden(false);
        String[] items = {
                busy ? t("Stop recording", "إيقاف التسجيل") : t("Start recording", "بدء التسجيل"),
                t("Recording settings", "إعدادات التسجيل"),
                t("My videos", "فيديوهاتي")
        };
        new AlertDialog.Builder(act).setTitle(t("Video recording", "تسجيل الفيديو"))
                .setItems(items, (d, which) -> {
                    if (which == 0) { if (busy) stop(act); else start(act); }
                    else if (which == 1) settings(act);
                    else videos(act);
                }).show();
    }

    // ---- settings ----------------------------------------------------------------------------------------------

    private static final int[] FPS = {24, 30, 60};
    private static final int[] QUALITY = {480, 720, 1080};

    private static int next(int[] values, int cur) {
        for (int i = 0; i < values.length; i++) if (values[i] == cur) return values[(i + 1) % values.length];
        return values[0];
    }

    private static void settings(GameActivity act) {
        SharedPreferences p = prefs(act);
        int fps = p.getInt("fps", 30), q = p.getInt("quality", 720);
        boolean mic = p.getBoolean("mic", false), hide = p.getBoolean("hide_controls", true);
        String on = t("on", "مفعّل"), off = t("off", "متوقف");
        String[] items = {
                "FPS: " + fps,
                t("Quality: ", "الجودة: ") + q + "p",
                t("Microphone: ", "الميكروفون: ") + (mic ? on : off),
                t("Hide controls while recording: ", "إخفاء الأزرار أثناء التسجيل: ") + (hide ? on : off)
        };
        new AlertDialog.Builder(act).setTitle(t("Recording settings", "إعدادات التسجيل"))
                .setItems(items, (d, which) -> {
                    SharedPreferences.Editor e = p.edit();
                    if (which == 0) e.putInt("fps", next(FPS, fps));
                    else if (which == 1) e.putInt("quality", next(QUALITY, q));
                    else if (which == 2) e.putBoolean("mic", !mic);
                    else e.putBoolean("hide_controls", !hide);
                    e.apply();
                    settings(act); // show the new value
                })
                .setPositiveButton(t("Back", "رجوع"), (d, w) -> open(act)).show();
    }

    // ---- start / stop ------------------------------------------------------------------------------------------

    private static void start(GameActivity act) {
        if (prefs(act).getBoolean("mic", false)
                && ContextCompat.checkSelfPermission(act, android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            final ActivityResultLauncher<?>[] holder = new ActivityResultLauncher<?>[1];
            ActivityResultLauncher<String> l = act.getActivityResultRegistry().register("bc_rec_perm_" + System.nanoTime(),
                    new ActivityResultContracts.RequestPermission(), granted -> {
                        if (holder[0] != null) holder[0].unregister();
                        if (!granted) prefs(act).edit().putBoolean("mic", false).apply();
                        askCapture(act);
                    });
            holder[0] = l;
            l.launch(android.Manifest.permission.RECORD_AUDIO);
        } else askCapture(act);
    }

    private static void askCapture(GameActivity act) {
        android.media.projection.MediaProjectionManager mpm =
                (android.media.projection.MediaProjectionManager) act.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        final ActivityResultLauncher<?>[] holder = new ActivityResultLauncher<?>[1];
        ActivityResultLauncher<Intent> l = act.getActivityResultRegistry().register("bc_rec_cap_" + System.nanoTime(),
                new ActivityResultContracts.StartActivityForResult(), result -> {
                    if (holder[0] != null) holder[0].unregister();
                    if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
                        begin(act, result.getData(), result.getResultCode());
                    } else {
                        Toast.makeText(act, t("Recording was not allowed", "لم يتم السماح بالتسجيل"), Toast.LENGTH_SHORT).show();
                    }
                });
        holder[0] = l;
        l.launch(mpm.createScreenCaptureIntent());
    }

    private static void begin(GameActivity act, Intent data, int resultCode) {
        SharedPreferences p = prefs(act);
        int fps = p.getInt("fps", 30), q = p.getInt("quality", 720);
        boolean mic = p.getBoolean("mic", false);

        DisplayMetrics dm = new DisplayMetrics();
        act.getWindowManager().getDefaultDisplay().getRealMetrics(dm);
        int w = dm.widthPixels, h = dm.heightPixels;
        float scale = Math.min(1f, (float) q / Math.min(w, h));
        int outW = Math.max(2, ((int) (w * scale)) & ~1), outH = Math.max(2, ((int) (h * scale)) & ~1);
        int base = q >= 1080 ? 10_000_000 : q >= 720 ? 5_000_000 : 2_500_000;
        int bitrate = (int) (base * (fps / 30f));

        sRecorder = new HBRecorder(act.getApplicationContext(), new HBRecorderListener() {
            @Override public void HBRecorderOnStart() {
                ui(() -> {
                    Toast.makeText(sActivity, t("Recording started", "بدأ التسجيل"), Toast.LENGTH_SHORT).show();
                });
            }
            @Override public void HBRecorderOnComplete() {
                ui(() -> {
                    setControlsHidden(false);
                    Toast.makeText(sActivity, t("Video saved in My videos", "تم حفظ الفيديو في فيديوهاتي"), Toast.LENGTH_LONG).show();
                });
            }
            @Override public void HBRecorderOnError(int errorCode, String reason) {
                ui(() -> {
                    setControlsHidden(false);
                    Toast.makeText(sActivity, t("Recording error: ", "خطأ في التسجيل: ") + reason, Toast.LENGTH_LONG).show();
                });
            }
            @Override public void HBRecorderOnPause() {}
            @Override public void HBRecorderOnResume() {}
        });
        sRecorder.setOutputPath(recordingsDir(act).getAbsolutePath());
        sRecorder.setFileName("BlockComet_" + new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date()));
        sRecorder.enableCustomSettings();
        sRecorder.setOutputFormat("MPEG_4");
        sRecorder.setVideoEncoder("H264");
        sRecorder.setVideoFrameRate(fps);
        sRecorder.setVideoBitrate(bitrate);
        sRecorder.setScreenDimensions(outH, outW);
        sRecorder.isAudioEnabled(mic);
        if (mic) { sRecorder.setAudioSource("MIC"); sRecorder.setAudioBitrate(128000); sRecorder.setAudioSamplingRate(44100); }
        sRecorder.setNotificationSmallIcon(android.R.drawable.ic_menu_camera);
        sRecorder.setNotificationTitle(t("BlockComet is recording", "BlockComet يسجّل"));
        sRecorder.setNotificationDescription(t("Tap Stop to finish", "اضغط إيقاف للإنهاء"));
        sRecorder.setNotificationButtonText(t("Stop", "إيقاف"));
        if (p.getBoolean("hide_controls", true)) setControlsHidden(true);
        sRecorder.startScreenRecording(data, resultCode);
    }

    private static void stop(GameActivity act) {
        if (sRecorder != null && sRecorder.isBusyRecording()) sRecorder.stopScreenRecording();
        setControlsHidden(false);
    }

    private static void ui(Runnable r) {
        if (sActivity != null) sActivity.runOnUiThread(r);
    }

    /**
     * Hides every on-screen control while recording and puts them back afterwards, in the state they were in.
     * Copper never hides its own "GUI" and "Mouse" buttons (they bring the controls back), so they are hidden here
     * by hand too, or they would stay in the video. The recording is stopped from its notification.
     */
    private static void setControlsHidden(boolean hide) {
        if (sActivity == null) return;
        ControlLayout layout = sActivity.bcControlLayout();
        if (layout == null) return;
        if (hide && !sControlsHidden) {
            sControlsWereVisible = layout.areControlVisible();
            int n = layout.getChildCount();
            sSavedVisibility = new int[n];
            for (int i = 0; i < n; i++) sSavedVisibility[i] = layout.getChildAt(i).getVisibility();
            layout.setControlVisible(false);   // keeps them hidden when the game switches between menu and play
            for (int i = 0; i < n; i++) layout.getChildAt(i).setVisibility(View.GONE);
            sControlsHidden = true;
        } else if (!hide && sControlsHidden) {
            layout.setControlVisible(sControlsWereVisible);
            int n = Math.min(layout.getChildCount(), sSavedVisibility.length);
            for (int i = 0; i < n; i++) layout.getChildAt(i).setVisibility(sSavedVisibility[i]);
            sControlsHidden = false;
        }
    }

    // ---- My videos ---------------------------------------------------------------------------------------------

    private static void videos(GameActivity act) {
        File[] found = recordingsDir(act).listFiles((dir, name) -> name.toLowerCase(Locale.ROOT).endsWith(".mp4"));
        List<File> files = new ArrayList<>(found == null ? new ArrayList<File>() : Arrays.asList(found));
        files.sort(Comparator.comparingLong(File::lastModified).reversed());
        if (files.isEmpty()) {
            Toast.makeText(act, t("No videos yet", "لا توجد فيديوهات بعد"), Toast.LENGTH_SHORT).show();
            return;
        }
        String[] names = new String[files.size()];
        for (int i = 0; i < names.length; i++) {
            names[i] = files.get(i).getName().replace(".mp4", "") + "  (" + (files.get(i).length() / 1_000_000) + " MB)";
        }
        new AlertDialog.Builder(act).setTitle(t("My videos", "فيديوهاتي"))
                .setItems(names, (d, which) -> videoActions(act, files.get(which)))
                .setPositiveButton(t("Back", "رجوع"), (d, w) -> open(act)).show();
    }

    private static void videoActions(GameActivity act, File f) {
        String[] items = {t("Play", "تشغيل"), t("Share", "مشاركة"), t("Delete", "حذف")};
        new AlertDialog.Builder(act).setTitle(f.getName()).setItems(items, (d, which) -> {
            Uri uri = FileProvider.getUriForFile(act, act.getPackageName() + ".bcfiles", f);
            try {
                if (which == 0) {
                    Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "video/mp4")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    act.startActivity(i);
                } else if (which == 1) {
                    Intent i = new Intent(Intent.ACTION_SEND).setType("video/mp4").putExtra(Intent.EXTRA_STREAM, uri)
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    act.startActivity(Intent.createChooser(i, f.getName()));
                } else {
                    new AlertDialog.Builder(act).setMessage(t("Delete this video?", "حذف هذا الفيديو؟"))
                            .setPositiveButton(t("Delete", "حذف"), (dd, ww) -> { //noinspection ResultOfMethodCallIgnored
                                f.delete(); videos(act); })
                            .setNegativeButton(t("Cancel", "إلغاء"), null).show();
                }
            } catch (Exception e) {
                Toast.makeText(act, String.valueOf(e.getMessage()), Toast.LENGTH_LONG).show();
            }
        }).show();
    }
}
