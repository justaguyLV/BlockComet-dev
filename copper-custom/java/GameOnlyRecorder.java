package git.artdeell.mojo.record;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.PixelCopy;
import android.view.Surface;
import android.view.SurfaceView;
import android.view.TextureView;
import android.view.View;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * "Game only" recording. Copies the frames of the game's own render surface (SurfaceView via PixelCopy, or
 * TextureView) into a hardware H.264 encoder. The on-screen controls are separate views drawn on top of the game,
 * so they are simply not in the copied frames: the player keeps seeing and using them, the video does not have them.
 * No screen-capture permission is needed. Video only (no audio).
 */
final class GameOnlyRecorder {
    interface Callback { void onFinished(File file, String error); }

    private final View source;
    private final int w, h, fps, bitrate;
    private final File file;
    private final Callback callback;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Object lock = new Object();

    private MediaCodec codec;
    private MediaMuxer muxer;
    private Surface input;
    private HandlerThread copyThread;
    private Handler copyHandler;
    private Thread drainThread;
    private final Bitmap[] bitmaps = new Bitmap[2];
    private int bitmapIndex;
    private volatile boolean running;
    private volatile boolean inFlight;
    private volatile boolean muxerStarted;
    private int track = -1;
    private long firstPts = -1, lastPts = -1;
    private volatile long frames;

    GameOnlyRecorder(View source, int w, int h, int fps, int bitrate, File file, Callback callback) {
        this.source = source; this.w = w; this.h = h; this.fps = fps; this.bitrate = bitrate;
        this.file = file; this.callback = callback;
    }

    void start() throws IOException {
        if (Build.VERSION.SDK_INT < 24 && source instanceof SurfaceView) throw new IOException("Android 7 or newer is needed");
        MediaFormat fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h);
        fmt.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        fmt.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
        fmt.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
        fmt.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
        codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        codec.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        input = codec.createInputSurface();
        codec.start();
        muxer = new MediaMuxer(file.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
        bitmaps[0] = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        bitmaps[1] = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        copyThread = new HandlerThread("bc-rec-copy");
        copyThread.start();
        copyHandler = new Handler(copyThread.getLooper());
        running = true;
        drainThread = new Thread(this::drain, "bc-rec-drain");
        drainThread.start();
        main.post(tick);
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!running) return;
            if (!inFlight) capture();
            main.postDelayed(this, Math.max(1, 1000L / fps));
        }
    };

    private void capture() {
        inFlight = true;
        final Bitmap bmp = bitmaps[bitmapIndex];
        bitmapIndex ^= 1;
        try {
            if (source instanceof SurfaceView && Build.VERSION.SDK_INT >= 24) {
                PixelCopy.request((SurfaceView) source, bmp, result -> {
                    if (result == PixelCopy.SUCCESS) push(bmp);
                    inFlight = false;
                }, copyHandler);
            } else if (source instanceof TextureView) {
                ((TextureView) source).getBitmap(bmp);
                push(bmp);
                inFlight = false;
            } else {
                inFlight = false;
            }
        } catch (Exception e) {
            inFlight = false;
        }
    }

    private void push(Bitmap bmp) {
        synchronized (lock) {
            if (!running) return;
            try {
                Canvas c = input.lockHardwareCanvas();
                c.drawBitmap(bmp, 0, 0, null);
                input.unlockCanvasAndPost(c);
                frames++;
            } catch (Exception ignored) { }
        }
    }

    private void drain() {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (true) {
            int idx;
            try { idx = codec.dequeueOutputBuffer(info, 10_000); } catch (Exception e) { break; }
            if (idx == MediaCodec.INFO_TRY_AGAIN_LATER) continue;
            if (idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                try {
                    track = muxer.addTrack(codec.getOutputFormat());
                    muxer.start();
                    muxerStarted = true;
                } catch (Exception e) { break; }
                continue;
            }
            if (idx < 0) continue;
            ByteBuffer buf = codec.getOutputBuffer(idx);
            if (buf != null && info.size > 0 && muxerStarted && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                if (firstPts < 0) firstPts = info.presentationTimeUs;
                long pts = Math.max(lastPts + 1, info.presentationTimeUs - firstPts); // strictly increasing
                lastPts = pts;
                info.presentationTimeUs = pts;
                buf.position(info.offset);
                buf.limit(info.offset + info.size);
                try { muxer.writeSampleData(track, buf, info); } catch (Exception ignored) { }
            }
            try { codec.releaseOutputBuffer(idx, false); } catch (Exception e) { break; }
            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
        }
    }

    boolean isRunning() { return running; }

    /** Finishes the file on a background thread and reports the result on the main thread. */
    void stop() {
        synchronized (lock) {
            if (!running) return;
            running = false;
        }
        main.removeCallbacks(tick);
        new Thread(() -> {
            String error = null;
            synchronized (lock) {
                try { codec.signalEndOfInputStream(); } catch (Exception ignored) { }
            }
            try { drainThread.join(8000); } catch (InterruptedException ignored) { }
            try {
                if (muxerStarted) muxer.stop(); else error = "no frames were captured";
            } catch (Exception e) { error = String.valueOf(e.getMessage()); }
            try { muxer.release(); } catch (Exception ignored) { }
            try { codec.stop(); } catch (Exception ignored) { }
            try { codec.release(); } catch (Exception ignored) { }
            try { input.release(); } catch (Exception ignored) { }
            copyThread.quitSafely();
            if (frames == 0 || error != null) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                if (error == null) error = "no frames were captured";
            }
            final String err = error;
            main.post(() -> callback.onFinished(err == null ? file : null, err));
        }, "bc-rec-stop").start();
    }
}
