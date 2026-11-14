// BlockComet skin registry: one PNG per player name, kept in Cloudflare KV (free plan is enough).
//   GET /skins/<name>.png   the skin (what CustomSkinLoader asks for), 404 when the player has none
//   PUT /skins/<name>.png   publish or replace: body = PNG, header X-Skin-Token = secret the launcher made for that name
//   DELETE /skins/<name>.png  remove the skin (same token); the name is free to claim again afterwards
// A name belongs to whoever published it first (the token's hash is stored); only the same token can replace the skin.
const NAME = /^[A-Za-z0-9_]{3,16}$/;
const MAX_BYTES = 24 * 1024;
const MIN_SECONDS_BETWEEN_WRITES = 10;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "x-skin-token, content-type", "access-control-allow-methods": "GET, HEAD, PUT, DELETE, OPTIONS" };

const text = (body, status = 200, extra = {}) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...CORS, ...extra } });

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
      await env.SKINS.put(key, body, { metadata: { owner, t: now } });
      // the cached copy (up to 5 minutes old) is dropped so the new skin shows soon
      ctx.waitUntil(caches.default.delete(new Request(url.origin + "/skins/" + m[1] + ".png")));
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
    return text("method not allowed", 405, { allow: "GET, HEAD, PUT, DELETE, OPTIONS" });
  },
};
