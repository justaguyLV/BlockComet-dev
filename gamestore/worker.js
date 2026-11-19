const MAX_FILE = 90 * 1024 * 1024, MAX_COVER = 5 * 1024 * 1024;
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });
const clean = (v, n) => String(v || "").trim().slice(0, n);

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    try {
      if (p === "/api/games" && req.method === "GET") {
        const q = `%${clean(url.searchParams.get("q"), 60)}%`, cat = clean(url.searchParams.get("cat"), 30);
        const sql = "SELECT id,title,description,category,developer,cover_key,file_size,downloads,created_at FROM games WHERE (title LIKE ?1 OR developer LIKE ?1)" + (cat ? " AND category = ?2" : "") + " ORDER BY id DESC LIMIT 100";
        const { results } = await env.DB.prepare(sql).bind(...(cat ? [q, cat] : [q])).all();
        return json(results);
      }
      if (p === "/api/games" && req.method === "POST") {
        const f = await req.formData();
        const title = clean(f.get("title"), 60), description = clean(f.get("description"), 1000),
          category = clean(f.get("category"), 30), developer = clean(f.get("developer"), 40);
        const cover = f.get("cover"), file = f.get("file");
        if (!title || !description || !category || !developer) return json({ error: "عبّي كل الحقول" }, 400);
        if (!cover?.size || !file?.size) return json({ error: "ارفع الغلاف وملف اللعبة" }, 400);
        if (!cover.type.startsWith("image/") || cover.size > MAX_COVER) return json({ error: "الغلاف لازم يكون صورة أقل من 5MB" }, 400);
        if (file.size > MAX_FILE) return json({ error: "ملف اللعبة أكبر من 90MB" }, 400);
        const id = crypto.randomUUID();
        const coverKey = `covers/${id}`, fileKey = `games/${id}`;
        await env.FILES.put(coverKey, cover.stream(), { httpMetadata: { contentType: cover.type } });
        await env.FILES.put(fileKey, file.stream());
        const r = await env.DB.prepare("INSERT INTO games (title,description,category,developer,cover_key,file_key,file_name,file_size) VALUES (?,?,?,?,?,?,?,?)")
          .bind(title, description, category, developer, coverKey, fileKey, clean(file.name, 120) || "game", file.size).run();
        return json({ id: r.meta.last_row_id }, 201);
      }
      const del = p.match(/^\/api\/games\/(\d+)$/);
      if (del && req.method === "DELETE") {
        if (!env.ADMIN_PASSWORD || req.headers.get("x-admin") !== env.ADMIN_PASSWORD) return json({ error: "غير مصرّح" }, 401);
        const g = await env.DB.prepare("SELECT cover_key,file_key FROM games WHERE id=?").bind(del[1]).first();
        if (!g) return json({ error: "غير موجودة" }, 404);
        await env.FILES.delete([g.cover_key, g.file_key]);
        await env.DB.prepare("DELETE FROM games WHERE id=?").bind(del[1]).run();
        return json({ ok: true });
      }
      const dl = p.match(/^\/dl\/(\d+)$/);
      if (dl) {
        const g = await env.DB.prepare("SELECT file_key,file_name FROM games WHERE id=?").bind(dl[1]).first();
        if (!g) return new Response("Not found", { status: 404 });
        const o = await env.FILES.get(g.file_key);
        if (!o) return new Response("Not found", { status: 404 });
        await env.DB.prepare("UPDATE games SET downloads=downloads+1 WHERE id=?").bind(dl[1]).run();
        return new Response(o.body, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(g.file_name)}` } });
      }
      if (p.startsWith("/files/covers/")) {
        const o = await env.FILES.get(p.slice(7));
        if (!o) return new Response("Not found", { status: 404 });
        return new Response(o.body, { headers: { "content-type": o.httpMetadata?.contentType || "image/png", "cache-control": "public, max-age=86400" } });
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: "خطأ في السيرفر" }, 500);
    }
  },
};
