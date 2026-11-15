// BlockComet skin registry: one PNG per player name, kept in Cloudflare KV (free plan is enough).
//   GET /skins/<name>.png   the skin (what CustomSkinLoader asks for), 404 when the player has none
//   PUT /skins/<name>.png   publish or replace: body = PNG, header X-Skin-Token = secret the launcher made for that name
//   DELETE /skins/<name>.png  remove the skin (same token); the name is free to claim again afterwards
//   PATCH /skins/<name>.png (or POST, for clients that cannot send PATCH)   show or hide the skin in the gallery without uploading it again: header X-Skin-Listed = 1 or 0 (same token)
//   GET /gallery?q=<start of a name>&cursor=<from the last page>&limit=<1-40>   the skins whose owners chose to list them (JSON)
// A name belongs to whoever published it first (the token's hash is stored); only the same token can replace the skin.
// A skin is in the gallery only when its owner asked for it (X-Skin-Listed: 1); the default is hidden.
const NAME = /^[A-Za-z0-9_]{3,16}$/;
const MAX_BYTES = 24 * 1024;
const MIN_SECONDS_BETWEEN_WRITES = 10;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "x-skin-token, x-skin-listed, content-type", "access-control-allow-methods": "GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS" };
const GALLERY_MAX = 40;
const GALLERY_ROUNDS = 6;

const text = (body, status = 200, extra = {}) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...CORS, ...extra } });

const json = (data, extra = {}) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra } });

// One page of the gallery: the listed skins whose name starts with q. KV lists keys alphabetically, a few at a time;
// a page that came back short still carries a cursor, so the caller asks again until the cursor is null.
async function gallery(url, env, ctx, req) {
  const cache = caches.default;
  const hit = await cache.match(req);
  if (hit) return hit;
  const q = (url.searchParams.get("q") || "").toLowerCase();
  if (q && !/^[a-z0-9_]{1,16}$/.test(q)) return json({ skins: [], cursor: null });
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "24", 10) || 24, 1), GALLERY_MAX);
  let cursor = url.searchParams.get("cursor") || undefined;
  const skins = [];
  let complete = false;
  for (let round = 0; round < GALLERY_ROUNDS && !complete && skins.length < limit; round++) {
    const page = await env.SKINS.list({ prefix: "skin:" + q, cursor, limit });
    for (const k of page.keys) {
      if (k.metadata && k.metadata.listed) skins.push({ name: k.metadata.name || k.name.slice(5), t: k.metadata.t || 0 });
    }
    complete = page.list_complete;
    cursor = complete ? undefined : page.cursor;
  }
  const res = json({ skins, cursor: complete ? null : cursor || null }, { "cache-control": "public, max-age=120" });
  ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// PNG signature + IHDR: a Minecraft skin is 64x64 (or the old 64x32)
function validSkin(buf) {
  if (buf.byteLength < 33 || buf.byteLength > MAX_BYTES) return false;
  const b = new Uint8Array(buf);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((v, i) => b[i] === v)) return false;
  const v = new DataView(buf);
  return v.getUint32(16) === 64 && (v.getUint32(20) === 64 || v.getUint32(20) === 32);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/") return text("BlockComet skin registry");
    if (url.pathname === "/gallery") return req.method === "GET" ? gallery(url, env, ctx, req) : text("method not allowed", 405, { allow: "GET, OPTIONS" });
    const m = url.pathname.match(/^\/skins\/([A-Za-z0-9_]+?)(?:\.png)?$/);
    if (!m || !NAME.test(m[1])) return text("not found", 404);
    const key = "skin:" + m[1].toLowerCase();

    if (req.method === "GET" || req.method === "HEAD") {
      const cache = caches.default;
      const hit = await cache.match(req);
      if (hit) return hit;
      const { value } = await env.SKINS.getWithMetadata(key, { type: "arrayBuffer" });
      if (!value) return text("no skin", 404, { "cache-control": "public, max-age=60" });
      const res = new Response(req.method === "HEAD" ? null : value, { headers: { "content-type": "image/png", "cache-control": "public, max-age=300", ...CORS } });
      if (req.method === "GET") ctx.waitUntil(cache.put(req, res.clone()));
      return res;
    }

    if (req.method === "PUT") {
      const token = req.headers.get("x-skin-token") || "";
      if (!/^[0-9a-f]{32,128}$/.test(token)) return text("missing or bad X-Skin-Token", 401);
      const body = await req.arrayBuffer();
      if (!validSkin(body)) return text("not a 64x64 (or 64x32) PNG skin under 24 KB", 400);
      const owner = await sha256Hex(token);
      const { metadata } = await env.SKINS.getWithMetadata(key, { type: "arrayBuffer" });
      if (metadata && metadata.owner !== owner) return text("this name belongs to another token", 403);
      const now = Date.now();
      if (metadata && now - (metadata.t || 0) < MIN_SECONDS_BETWEEN_WRITES * 1000) return text("too many updates, wait a moment", 429);
      const asked = req.headers.get("x-skin-listed");
      const listed = asked === null ? !!(metadata && metadata.listed) : asked === "1";
      await env.SKINS.put(key, body, { metadata: { owner, t: now, listed, name: m[1] } });
      // the cached copy (up to 5 minutes old) is dropped so the new skin shows soon
      ctx.waitUntil(caches.default.delete(new Request(url.origin + "/skins/" + m[1] + ".png")));
      return text("ok", 200);
    }
    if (req.method === "PATCH" || req.method === "POST") {
      const token = req.headers.get("x-skin-token") || "";
      if (!/^[0-9a-f]{32,128}$/.test(token)) return text("missing or bad X-Skin-Token", 401);
      const asked = req.headers.get("x-skin-listed");
      if (asked !== "0" && asked !== "1") return text("X-Skin-Listed must be 0 or 1", 400);
      const { value, metadata } = await env.SKINS.getWithMetadata(key, { type: "arrayBuffer" });
      if (!value) return text("no skin", 404);
      if (!metadata || metadata.owner !== (await sha256Hex(token))) return text("this name belongs to another token", 403);
      await env.SKINS.put(key, value, { metadata: { ...metadata, listed: asked === "1", name: metadata.name || m[1] } });
      return text("ok", 200);
    }
    if (req.method === "DELETE") {
      const token = req.headers.get("x-skin-token") || "";
      if (!/^[0-9a-f]{32,128}$/.test(token)) return text("missing or bad X-Skin-Token", 401);
      const { value, metadata } = await env.SKINS.getWithMetadata(key, { type: "arrayBuffer" });
      if (!value) return text("no skin", 404);
      if (!metadata || metadata.owner !== (await sha256Hex(token))) return text("this name belongs to another token", 403);
      await env.SKINS.delete(key);
      ctx.waitUntil(caches.default.delete(new Request(url.origin + "/skins/" + m[1] + ".png")));
      return text("deleted", 200);
    }
    return text("method not allowed", 405, { allow: "GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS" });
  },
};
