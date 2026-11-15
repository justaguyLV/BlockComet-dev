package git.artdeell.mojo.skins;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.LruCache;
import android.view.KeyEvent;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.progressindicator.LinearProgressIndicator;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import git.artdeell.mojo.MojoApplication;
import git.artdeell.mojo.R;
import git.artdeell.mojo.authenticator.AuthType;
import git.artdeell.mojo.authenticator.accounts.Account;
import git.artdeell.mojo.authenticator.accounts.Accounts;
import git.artdeell.mojo.authenticator.accounts.SkinHeadRenderer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * BlockComet skin gallery: search the skins other players chose to list on the BlockComet skin service, look at one in 3D
 * and add it to your own skins. Pages come from the service (GET /gallery) and are loaded as the player scrolls.
 */
public class SkinGalleryFragment extends Fragment {
    public static final String TAG = "SkinGalleryFragment";
    /** Which account the gallery was opened for: the file name the skin editor uses. */
    public static final String ARG_ACCOUNT_FILE = "account_file";

    private static final int PAGE = 24;
    private static final int GRID_TILE_DP = 100;
    private static final int MAX_JSON_BYTES = 256 * 1024;
    private static final int MAX_SKIN_BYTES = 128 * 1024;
    private static final Pattern QUERY = Pattern.compile("[A-Za-z0-9_]{0,16}");

    private final Handler mHandler = new Handler(Looper.getMainLooper());
    /** One tile: featured skins come from the service itself, the others from players who added theirs. */
    private static final class Item {
        final String name;
        final boolean featured;

        Item(String name, boolean featured) {
            this.name = name;
            this.featured = featured;
        }

        String key() {
            return (featured ? "f:" : "s:") + name;
        }
    }

    private final List<Item> mItems = new ArrayList<>();
    private final Set<String> mThumbsLoading = new HashSet<>();
    private final LruCache<String, Bitmap> mThumbs = new LruCache<String, Bitmap>(12 * 1024 * 1024) {
        @Override
        protected int sizeOf(String key, Bitmap value) {
            return value.getByteCount();
        }
    };

    private EditText mSearch;
    private RecyclerView mGrid;
    private GridLayoutManager mLayoutManager;
    private LinearProgressIndicator mProgress;
    private TextView mStatus;
    private GridAdapter mAdapter;

    private String mQuery = "";
    private String mCursor;
    private boolean mHasMore = true;
    private boolean mLoading;
    private int mGeneration;
    private int mStatusText;

    public SkinGalleryFragment() {
        super(R.layout.fragment_skin_gallery);
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        mSearch = view.findViewById(R.id.gallery_search);
        mProgress = view.findViewById(R.id.gallery_progress);
        mStatus = view.findViewById(R.id.gallery_status);
        mGrid = view.findViewById(R.id.gallery_grid);

        mAdapter = new GridAdapter();
        mLayoutManager = new GridLayoutManager(requireContext(), 3);
        mGrid.setLayoutManager(mLayoutManager);
        mGrid.setAdapter(mAdapter);
        mGrid.addOnLayoutChangeListener((v, l, t, r, b, oldL, oldT, oldR, oldB) -> {
            int width = r - l;
            if (width == oldR - oldL) return;
            int span = Math.max(2, (int) (width / (GRID_TILE_DP * getResources().getDisplayMetrics().density)));
            if (span != mLayoutManager.getSpanCount()) mLayoutManager.setSpanCount(span);
        });
        mGrid.addOnScrollListener(new RecyclerView.OnScrollListener() {
            @Override
            public void onScrolled(@NonNull RecyclerView recyclerView, int dx, int dy) {
                if (dy <= 0) return;
                if (mLayoutManager.findLastVisibleItemPosition() >= mItems.size() - 6) loadPage();
            }
        });

        view.findViewById(R.id.gallery_search_button).setOnClickListener(v -> startSearch());
        view.findViewById(R.id.gallery_add_button).setOnClickListener(v -> addMySkin());
        view.findViewById(R.id.gallery_remove_button).setOnClickListener(v -> removeMySkin());
        mSearch.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_SEARCH || actionId == EditorInfo.IME_ACTION_DONE
                    || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER)) {
                startSearch();
                return true;
            }
            return false;
        });

        resetAndLoad();
    }

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        mGeneration++; // answers still on their way belong to a view that is gone
        mHandler.removeCallbacksAndMessages(null);
        mThumbsLoading.clear();
        mLoading = false;
    }

    // ------------------------------------------------------------------ searching and paging

    private void startSearch() {
        String typed = mSearch.getText().toString().trim();
        if (!QUERY.matcher(typed).matches()) {
            Toast.makeText(requireContext(), R.string.blockcomet_gallery_bad_name, Toast.LENGTH_LONG).show();
            return;
        }
        InputMethodManager imm = (InputMethodManager) requireContext().getSystemService(android.content.Context.INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(mSearch.getWindowToken(), 0);
        mQuery = typed.toLowerCase(java.util.Locale.ROOT);
        resetAndLoad();
    }

    private void resetAndLoad() {
        mGeneration++;
        mItems.clear();
        mCursor = null;
        mHasMore = true;
        mLoading = false;
        mStatusText = 0;
        mAdapter.notifyDataSetChanged();
        loadPage();
    }

    private void loadPage() {
        if (mLoading || !mHasMore) return;
        final String api = LocalSkins.skinsApi();
        if (api.isEmpty()) {
            mHasMore = false;
            mStatusText = R.string.blockcomet_gallery_no_service;
            showStatus();
            return;
        }
        final int generation = mGeneration;
        final String query = mQuery;
        final String cursor = mCursor;
        mLoading = true;
        mProgress.setVisibility(View.VISIBLE);
        MojoApplication.sExecutorService.execute(() -> {
            final List<Item> got = new ArrayList<>();
            String next = null;
            Throwable error = null;
            try {
                String url = api + "/gallery?limit=" + PAGE
                        + (query.isEmpty() ? "" : "&q=" + Uri.encode(query))
                        + (cursor == null ? "" : "&cursor=" + Uri.encode(cursor));
                String body = new String(download(url, MAX_JSON_BYTES), StandardCharsets.UTF_8);
                JsonObject root = new Gson().fromJson(body, JsonObject.class);
                for (JsonElement element : root.getAsJsonArray("skins")) {
                    JsonObject entry = element.getAsJsonObject();
                    JsonElement featured = entry.get("featured");
                    got.add(new Item(entry.get("name").getAsString(), featured != null && !featured.isJsonNull() && featured.getAsBoolean()));
                }
                JsonElement c = root.get("cursor");
                next = (c == null || c.isJsonNull()) ? null : c.getAsString();
            } catch (Exception e) {
                error = e;
            }
            final String finalNext = next;
            final Throwable finalError = error;
            runIfAttached(() -> {
                if (generation != mGeneration) return; // the search changed while this page was coming
                mLoading = false;
                mProgress.setVisibility(View.INVISIBLE);
                if (finalError != null) {
                    mHasMore = false;
                    mStatusText = R.string.blockcomet_gallery_error;
                } else {
                    int start = mItems.size();
                    mItems.addAll(got);
                    mAdapter.notifyItemRangeInserted(start, got.size());
                    mCursor = finalNext;
                    mHasMore = finalNext != null;
                    mStatusText = mItems.isEmpty() ? R.string.blockcomet_gallery_empty : 0;
                }
                showStatus();
                // a short page with more behind it: go on until the screen is full
                if (mHasMore) mGrid.post(() -> {
                    if (isAdded() && !mGrid.canScrollVertically(1)) loadPage();
                });
            });
        });
    }

    private void showStatus() {
        if (mStatusText == 0) {
            mStatus.setVisibility(View.GONE);
        } else {
            mStatus.setText(mStatusText);
            mStatus.setVisibility(View.VISIBLE);
        }
    }

    // ------------------------------------------------------------------ thumbnails and preview

    private Bitmap thumb(@NonNull Item item) {
        final String key = item.key();
        Bitmap cached = mThumbs.get(key);
        if (cached != null) return cached;
        if (!mThumbsLoading.add(key)) return null;
        final int generation = mGeneration;
        MojoApplication.sExecutorService.execute(() -> {
            Bitmap head = null;
            try {
                byte[] data = download(skinUrl(item), MAX_SKIN_BYTES);
                Bitmap raw = BitmapFactory.decodeByteArray(data, 0, data.length);
                if (raw != null) {
                    if (SkinTextures.isValidSkinSize(raw.getWidth(), raw.getHeight())) {
                        Bitmap normalized = SkinTextures.normalizeSkin(raw);
                        head = new SkinHeadRenderer().render(160, normalized);
                        normalized.recycle();
                    }
                    raw.recycle();
                }
            } catch (Exception ignored) {
                // the tile just stays empty
            }
            final Bitmap result = head;
            runIfAttached(() -> {
                mThumbsLoading.remove(key);
                if (result == null) return;
                mThumbs.put(key, result);
                int index = indexOfKey(key);
                if (index >= 0 && generation == mGeneration) mAdapter.notifyItemChanged(index);
            });
        });
        return null;
    }

    private void openSkin(@NonNull Item item) {
        mProgress.setVisibility(View.VISIBLE);
        MojoApplication.sExecutorService.execute(() -> {
            byte[] data = null;
            Bitmap bitmap = null;
            try {
                data = download(skinUrl(item), MAX_SKIN_BYTES);
                bitmap = BitmapFactory.decodeByteArray(data, 0, data.length);
                if (bitmap != null && !SkinTextures.isValidSkinSize(bitmap.getWidth(), bitmap.getHeight())) bitmap = null;
            } catch (Exception ignored) {
                // reported below
            }
            final byte[] finalData = data;
            final Bitmap finalBitmap = bitmap;
            runIfAttached(() -> {
                mProgress.setVisibility(mLoading ? View.VISIBLE : View.INVISIBLE);
                if (finalData == null || finalBitmap == null) {
                    Toast.makeText(requireContext(), R.string.blockcomet_gallery_load_failed, Toast.LENGTH_LONG).show();
                    return;
                }
                showPreview(item.name, finalData, finalBitmap);
            });
        });
    }

    private void showPreview(@NonNull String name, @NonNull byte[] data, @NonNull Bitmap bitmap) {
        final boolean slim = SkinTextures.looksSlim(bitmap);
        PlayerPreviewView preview = new PlayerPreviewView(requireContext());
        int height = (int) (300 * getResources().getDisplayMetrics().density);
        preview.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height));
        preview.setSkin(bitmap, slim);
        new MaterialAlertDialogBuilder(requireContext())
                .setTitle(name)
                .setView(preview)
                .setPositiveButton(R.string.blockcomet_gallery_add, (dialog, which) -> addToLibrary(name, data, slim))
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private void addToLibrary(@NonNull String name, @NonNull byte[] data, boolean slim) {
        final android.content.Context appContext = requireContext().getApplicationContext();
        MojoApplication.sExecutorService.execute(() -> {
            boolean ok = true;
            try {
                SkinLibrary.add(data, name, slim);
            } catch (Exception e) {
                ok = false;
            }
            final boolean finalOk = ok;
            mHandler.post(() -> Toast.makeText(appContext,
                    finalOk ? R.string.blockcomet_gallery_added : R.string.blockcomet_gallery_load_failed,
                    Toast.LENGTH_LONG).show());
        });
    }

    // ------------------------------------------------------------------ my own skin

    /** The local account the gallery was opened for, or null. Reads the account file, so only call it off the main thread. */
    @Nullable
    private Account findLocalAccount() {
        try {
            String fileName = getArguments() == null ? null : getArguments().getString(ARG_ACCOUNT_FILE);
            if (fileName == null) return null;
            for (Account account : Accounts.load().accounts) {
                if (account.mSaveLocation != null && fileName.equals(account.mSaveLocation.getName())) {
                    return account.authType == AuthType.LOCAL && account.username != null ? account : null;
                }
            }
        } catch (Exception ignored) {
            // treated as no account
        }
        return null;
    }

    private void toastLater(final int message) {
        final android.content.Context appContext = requireContext().getApplicationContext();
        mHandler.post(() -> Toast.makeText(appContext, message, Toast.LENGTH_LONG).show());
    }

    private static int messageFor(int code) {
        if (code == 200) return R.string.blockcomet_gallery_mine_added;
        if (code == LocalSkins.PUBLISH_NO_SERVICE) return R.string.blockcomet_publish_no_service;
        if (code == 400) return R.string.blockcomet_publish_invalid;
        if (code == 403) return R.string.blockcomet_publish_taken;
        return R.string.blockcomet_publish_failed;
    }

    /** Uploads the skin that is chosen for this account and shows it in the gallery. */
    private void addMySkin() {
        MojoApplication.sExecutorService.execute(() -> {
            Account account = findLocalAccount();
            if (account == null) {
                toastLater(R.string.blockcomet_gallery_need_local);
                return;
            }
            byte[] png = null;
            try {
                SkinLibrary.Entry entry = SkinLibrary.find(SkinLibrary.getSelected(SkinLibrary.localKey(account.username)));
                if (entry != null) png = SkinLibrary.readBytes(entry);
            } catch (Exception ignored) {
                // handled below
            }
            if (png == null) {
                toastLater(R.string.blockcomet_gallery_need_skin);
                return;
            }
            LocalSkins.publishListed(account.username, png, true, code -> toastLater(messageFor(code)));
        });
    }

    /** Hides the player's skin in the gallery again; it stays available in the game. */
    private void removeMySkin() {
        MojoApplication.sExecutorService.execute(() -> {
            Account account = findLocalAccount();
            if (account == null) {
                toastLater(R.string.blockcomet_gallery_need_local);
                return;
            }
            LocalSkins.setListed(account.username, false, code -> toastLater(
                    code == 200 ? R.string.blockcomet_gallery_mine_removed
                            : code == LocalSkins.PUBLISH_NOTHING ? R.string.blockcomet_gallery_mine_nothing
                            : code == LocalSkins.PUBLISH_NO_SERVICE ? R.string.blockcomet_publish_no_service
                            : R.string.blockcomet_publish_failed));
        });
    }

    // ------------------------------------------------------------------ network

    private static String skinUrl(@NonNull Item item) {
        return LocalSkins.skinsApi() + (item.featured ? "/featured/" : "/skins/") + Uri.encode(item.name) + ".png";
    }

    private int indexOfKey(@NonNull String key) {
        for (int i = 0; i < mItems.size(); i++) {
            if (mItems.get(i).key().equals(key)) return i;
        }
        return -1;
    }

    private static byte[] download(@NonNull String address, int maxBytes) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        try {
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            if (connection.getResponseCode() != 200) throw new IOException("HTTP " + connection.getResponseCode());
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                    if (out.size() > maxBytes) throw new IOException("too big");
                }
                return out.toByteArray();
            }
        } finally {
            connection.disconnect();
        }
    }

    private void runIfAttached(@NonNull Runnable runnable) {
        mHandler.post(() -> {
            if (isAdded() && getView() != null) runnable.run();
        });
    }

    // ------------------------------------------------------------------ grid

    private class GridAdapter extends RecyclerView.Adapter<GridAdapter.Holder> {
        class Holder extends RecyclerView.ViewHolder {
            final ImageView image;
            final TextView label;

            Holder(@NonNull View itemView) {
                super(itemView);
                image = itemView.findViewById(R.id.gallery_tile_image);
                label = itemView.findViewById(R.id.gallery_tile_label);
            }
        }

        @NonNull
        @Override
        public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
            return new Holder(LayoutInflater.from(parent.getContext()).inflate(R.layout.item_gallery_skin, parent, false));
        }

        @Override
        public int getItemCount() {
            return mItems.size();
        }

        @Override
        public void onBindViewHolder(@NonNull Holder holder, int position) {
            final Item item = mItems.get(position);
            holder.label.setText(item.featured ? "\u2605 " + item.name : item.name);
            holder.image.setImageBitmap(thumb(item));
            holder.itemView.setOnClickListener(v -> openSkin(item));
        }
    }
}
