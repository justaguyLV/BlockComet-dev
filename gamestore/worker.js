const MAX_FILE = 95 * 1024 * 1024, MAX_COVER = 2 * 1024 * 1024;
const COVER_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });
const clean = (v, n) => String(v || "").trim().slice(0, n);
const gh = (env, url, init = {}) => fetch(url, { ...init, headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "game-store", "X-GitHub-Api-Version": "2022-11-28", ...(init.headers || {}) } });
const getIdx = async (env) => JSON.parse((await env.STORE.get("idx")) || "[]");
const isAdmin = (req, env) => !!env.ADMIN_PASSWORD && req.headers.get("x-admin") === env.ADMIN_PASSWORD;

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    try {
      if (p === "/api/games" && req.method === "GET") {
        const q = clean(url.searchParams.get("q"), 60).toLowerCase(), cat = clean(url.searchParams.get("cat"), 30);
        const list = (await getIdx(env)).filter((g) => (!q || `${g.title} ${g.developer}`.toLowerCase().includes(q)) && (!cat || g.category === cat));
        return json(list.slice(0, 100).map(({ file_url, release_id, ...g }) => g));
      }
      if (p === "/api/games" && req.method === "POST") {
        const f = await req.formData();
        const title = clean(f.get("title"), 60), description = clean(f.get("description"), 1000),
          category = clean(f.get("category"), 30), developer = clean(f.get("developer"), 40);
        const cover = f.get("cover"), file = f.get("file");
        if (!title || !description || !category || !developer) return json({ error: "عبّي كل الحقول" }, 400);
        if (!cover?.size || !file?.size) return json({ error: "ارفع الغلاف وملف اللعبة" }, 400);
        if (!COVER_TYPES.includes(cover.type) || cover.size > MAX_COVER) return json({ error: "الغلاف لازم يكون PNG أو JPG أو WEBP أقل من 2MB" }, 400);
        if (file.size > MAX_FILE) return json({ error: "ملف اللعبة أكبر من 95MB" }, 400);
        if (!env.GH_TOKEN) return json({ error: "تخزين GitHub غير مضبوط بعد" }, 503);
        const id = crypto.randomUUID();
        const rel = await gh(env, `https://api.github.com/repos/${env.GH_REPO}/releases`, { method: "POST", body: JSON.stringify({ tag_name: `g-${id}`, name: title, body: `${developer} · ${category}` }) });
        if (!rel.ok) return json({ error: "فشل إنشاء الإصدار على GitHub" }, 502);
        const release = await rel.json();
        const fname = (file.name || "game").replace(/[^\w.\-]+/g, "_").slice(-100) || "game";
        const up = await gh(env, `https://uploads.github.com/repos/${env.GH_REPO}/releases/${release.id}/assets?name=${encodeURIComponent(fname)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
        if (!up.ok) {
          await gh(env, `https://api.github.com/repos/${env.GH_REPO}/releases/${release.id}`, { method: "DELETE" });
          await gh(env, `https://api.github.com/repos/${env.GH_REPO}/git/refs/tags/g-${id}`, { method: "DELETE" });
          return json({ error: "فشل رفع الملف إلى GitHub" }, 502);
        }
        const asset = await up.json();
        await env.STORE.put(`c:${id}`, await cover.arrayBuffer(), { metadata: { type: cover.type } });
        const idx = await getIdx(env);
        idx.unshift({ id, title, description, category, developer, cover_key: `covers/${id}`, file_size: file.size, downloads: 0, created_at: new Date().toISOString(), file_url: asset.browser_download_url, release_id: release.id });
        await env.STORE.put("idx", JSON.stringify(idx.slice(0, 500)));
        return json({ id }, 201);
      }
      if (p === "/api/admin/check") return isAdmin(req, env) ? json({ ok: true }) : json({ error: "كلمة السر غلط" }, 401);
      const del = p.match(/^\/api\/games\/([\w-]+)$/);
      if (del && req.method === "DELETE") {
        if (!isAdmin(req, env)) return json({ error: "غير مصرّح" }, 401);
        const all = await getIdx(env), g = all.find((x) => x.id === del[1]);
        if (g?.release_id && env.GH_TOKEN) {
          await gh(env, `https://api.github.com/repos/${env.GH_REPO}/releases/${g.release_id}`, { method: "DELETE" });
          await gh(env, `https://api.github.com/repos/${env.GH_REPO}/git/refs/tags/g-${g.id}`, { method: "DELETE" });
        }
        await env.STORE.put("idx", JSON.stringify(all.filter((x) => x.id !== del[1])));
        await env.STORE.delete(`c:${del[1]}`);
        return json({ ok: true });
      }
      const dl = p.match(/^\/dl\/([\w-]+)$/);
      if (dl) {
        const idx = await getIdx(env), g = idx.find((x) => x.id === dl[1]);
        if (!g?.file_url) return new Response("Not found", { status: 404 });
        g.downloads++;
        await env.STORE.put("idx", JSON.stringify(idx));
        return Response.redirect(g.file_url, 302);
      }
      const cv = p.match(/^\/files\/covers\/([\w-]+)$/);
      if (cv) {
        const { value, metadata } = await env.STORE.getWithMetadata(`c:${cv[1]}`, "arrayBuffer");
        if (!value) return new Response("Not found", { status: 404 });
        return new Response(value, { headers: { "content-type": metadata?.type || "image/png", "x-content-type-options": "nosniff", "cache-control": "public, max-age=86400" } });
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: "خطأ في السيرفر" }, 500);
    }
  },
};
