const MAX_FILE = 24 * 1024 * 1024, MAX_COVER = 2 * 1024 * 1024;
const COVER_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });
const clean = (v, n) => String(v || "").trim().slice(0, n);
const getIdx = async (env) => JSON.parse((await env.STORE.get("idx")) || "[]");
const isAdmin = (req, env) => !!env.ADMIN_PASSWORD && req.headers.get("x-admin") === env.ADMIN_PASSWORD;

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    try {
      if (p === "/api/games" && req.method === "GET") {
        const q = clean(url.searchParams.get("q"), 60).toLowerCase(), cat = clean(url.searchParams.get("cat"), 30);
        const list = (await getIdx(env)).filter((g) => (!q || `${g.title} ${g.developer}`.toLowerCase().includes(q)) && (!cat || g.category === cat));
        return json(list.slice(0, 100));
      }
      if (p === "/api/games" && req.method === "POST") {
        const f = await req.formData();
        const title = clean(f.get("title"), 60), description = clean(f.get("description"), 1000),
          category = clean(f.get("category"), 30), developer = clean(f.get("developer"), 40);
        const cover = f.get("cover"), file = f.get("file");
        if (!title || !description || !category || !developer) return json({ error: "عبّي كل الحقول" }, 400);
        if (!cover?.size || !file?.size) return json({ error: "ارفع الغلاف وملف اللعبة" }, 400);
        if (!COVER_TYPES.includes(cover.type) || cover.size > MAX_COVER) return json({ error: "الغلاف لازم يكون PNG أو JPG أو WEBP أقل من 2MB" }, 400);
        if (file.size > MAX_FILE) return json({ error: "ملف اللعبة أكبر من 24MB" }, 400);
        const id = crypto.randomUUID();
        await env.STORE.put(`c:${id}`, await cover.arrayBuffer(), { metadata: { type: cover.type } });
        await env.STORE.put(`f:${id}`, await file.arrayBuffer(), { metadata: { name: clean(file.name, 120) || "game" } });
        const idx = await getIdx(env);
        idx.unshift({ id, title, description, category, developer, cover_key: `covers/${id}`, file_size: file.size, downloads: 0, created_at: new Date().toISOString() });
        await env.STORE.put("idx", JSON.stringify(idx.slice(0, 500)));
        return json({ id }, 201);
      }
      if (p === "/api/admin/check") return isAdmin(req, env) ? json({ ok: true }) : json({ error: "كلمة السر غلط" }, 401);
      const del = p.match(/^\/api\/games\/([\w-]+)$/);
      if (del && req.method === "DELETE") {
        if (!isAdmin(req, env)) return json({ error: "غير مصرّح" }, 401);
        const idx = (await getIdx(env)).filter((g) => g.id !== del[1]);
        await env.STORE.put("idx", JSON.stringify(idx));
        await env.STORE.delete(`c:${del[1]}`); await env.STORE.delete(`f:${del[1]}`);
        return json({ ok: true });
      }
      const dl = p.match(/^\/dl\/([\w-]+)$/);
      if (dl) {
        const { value, metadata } = await env.STORE.getWithMetadata(`f:${dl[1]}`, "arrayBuffer");
        if (!value) return new Response("Not found", { status: 404 });
        const idx = await getIdx(env), g = idx.find((x) => x.id === dl[1]);
        if (g) { g.downloads++; await env.STORE.put("idx", JSON.stringify(idx)); }
        const name = metadata?.name || "game";
        return new Response(value, { headers: { "content-type": "application/octet-stream", "x-content-type-options": "nosniff", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } });
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
