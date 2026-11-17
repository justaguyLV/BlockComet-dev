// BlockComet skin registry: one PNG per player name, kept in Cloudflare KV (free plan is enough).
//   GET /skins/<name>.png   the skin (what CustomSkinLoader asks for), 404 when the player has none
//   PUT /skins/<name>.png   publish or replace: body = PNG, header X-Skin-Token = secret the launcher made for that name
//   DELETE /skins/<name>.png  remove the skin (same token); the name is free to claim again afterwards
//   PATCH /skins/<name>.png (or POST, for clients that cannot send PATCH)   show or hide the skin in the gallery without uploading it again: header X-Skin-Listed = 1 or 0 (same token)
//   GET /gallery?q=<start of a name>&cursor=<from the last page>&limit=<1-40>   the skins whose owners chose to list them (JSON)
//   GET /featured/<n>.png   a featured skin (put there by the deploy from featured.txt, not by players; separate from the player skins)
// A name belongs to whoever published it first (the token's hash is stored); only the same token can replace the skin.
// A skin is in the gallery only when its owner asked for it (X-Skin-Listed: 1); the default is hidden.
import { admin, logEvent } from "./admin.js";

const NAME = /^[A-Za-z0-9_]{3,16}$/;
const MAX_BYTES = 24 * 1024;
const MIN_SECONDS_BETWEEN_WRITES = 10;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "x-skin-token, x-skin-listed, content-type", "access-control-allow-methods": "GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS" };
const GALLERY_MAX = 40;
const GALLERY_ROUNDS = 6;

// What the service can see about a client from the request itself (used by the developer panel only): the app's User-Agent
// (an Android HTTP client usually names the phone model and the Android version) and Cloudflare's approximate location.
const parseUA = (ua) => { const m = /Android\s+([\d.]+);\s*([^;)]+?)(?:\s+Build\/|[;)])/.exec(ua || ""); return m ? { os: "Android " + m[1], dv: m[2].trim().slice(0, 40) } : { os: "", dv: "" }; };
function clientInfo(req) {
  const ua = (req.headers.get("user-agent") || "").slice(0, 120);
  const cf = req.cf || {};
  return { ua, ...parseUA(ua), c: String(cf.country || ""), cy: String(cf.city || "").slice(0, 40), asn: String(cf.asnOrganization || "").slice(0, 40) };
}
const CLIENT_REFRESH_MS = 6 * 3600 * 1000;
// One record per IP ("cl:<ip>"): first seen, last seen, device, location, and the player names that published a skin from it.
// Written at most once per 6 hours per IP (plus when a new name shows up), so the free KV write quota is not used up.
async function touchClient(env, ip, info, name) {
  try {
    if (!ip) return;
    const key = "cl:" + ip, now = Date.now();
    const { metadata } = await env.SKINS.getWithMetadata(key);
    const old = metadata || {};
    const names = Array.isArray(old.nm) ? old.nm.slice() : [];
    const isNew = !!name && !names.includes(name);
    if (isNew) names.push(name);
    if (metadata && now - (old.l || 0) < CLIENT_REFRESH_MS && !isNew) return;
    await env.SKINS.put(key, "1", { expirationTtl: 120 * 24 * 3600, metadata: { f: old.f || now, l: now, ua: info.ua, os: info.os, dv: info.dv, c: info.c, cy: info.cy, asn: info.asn, nm: names.slice(-5) } });
  } catch (e) { /* never break a request */ }
}

const text = (body, status = 200, extra = {}) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...CORS, ...extra } });

const json = (data, extra = {}) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra } });

// One page of the gallery: first the featured skins, then the listed player skins, both filtered by the start of the name.
// The cursor says where we are: "f<kv cursor>" in the featured list, "s<kv cursor>" in the player list; none = the very start.
// KV lists keys alphabetically, a few at a time; a short page still carries a cursor, so the caller asks again until it is null.
async function gallery(url, env, ctx, req) {
  const cache = caches.default;
  const hit = await cache.match(req);
  if (hit) return hit;
  const q = (url.searchParams.get("q") || "").toLowerCase();
  if (q && !/^[a-z0-9_]{1,16}$/.test(q)) return json({ skins: [], cursor: null });
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "24", 10) || 24, 1), GALLERY_MAX);
  const raw = url.searchParams.get("cursor") || "";
  let phase = raw.startsWith("s") ? "s" : "f";
  let cursor = raw.slice(1) || undefined;
  const skins = [];
  let finished = false;
  for (let round = 0; round < GALLERY_ROUNDS && !finished && skins.length < limit; round++) {
    const prefix = (phase === "f" ? "featured:" : "skin:") + q;
    const page = await env.SKINS.list({ prefix, cursor, limit });
    for (const k of page.keys) {
      const meta = k.metadata || {};
      if (phase === "f") skins.push({ name: meta.name || k.name.slice(9), t: meta.t || 0, featured: true });
      else if (meta.listed) skins.push({ name: meta.name || k.name.slice(5), t: meta.t || 0, featured: false });
    }
    if (page.list_complete) {
      if (phase === "f") { phase = "s"; cursor = undefined; } else finished = true;
    } else {
      cursor = page.cursor;
    }
  }
  const res = json({ skins, cursor: finished ? null : phase + (cursor || "") }, { "cache-control": "public, max-age=120" });
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
    const ip = req.headers.get("cf-connecting-ip") || "";
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return admin(req, env, ctx, ip);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    // a banned IP gets nothing from the service (log at most once a minute per IP so a loop cannot use up the KV writes)
    if (ip && (await env.SKINS.get("ban:ip:" + ip))) {
      if (!(await env.SKINS.get("seen:" + ip))) { await env.SKINS.put("seen:" + ip, "1", { expirationTtl: 60 }); ctx.waitUntil(logEvent(env, { type: "blocked", ip, target: "ip", reason: url.pathname.slice(0, 60) })); }
      return text("banned", 403);
    }
    if (ip && req.method !== "PUT" && url.pathname !== "/") ctx.waitUntil(touchClient(env, ip, clientInfo(req), ""));
    if (url.pathname === "/") return text("BlockComet skin registry");
    // for the launcher to ask later whether a player is banned: GET /status/<name> -> {"banned":true|false}
    const st = url.pathname.match(/^\/status\/([A-Za-z0-9_]{3,16})$/);
    if (st && req.method === "GET") return json({ banned: !!(await env.SKINS.get("ban:name:" + st[1].toLowerCase())) }, { "cache-control": "no-store" });
    if (url.pathname === "/gallery") return req.method === "GET" ? gallery(url, env, ctx, req) : text("method not allowed", 405, { allow: "GET, OPTIONS" });
    const f = url.pathname.match(/^\/featured\/([A-Za-z0-9_]+?)(?:\.png)?$/);
    if (f && NAME.test(f[1]) && (req.method === "GET" || req.method === "HEAD")) {
      const { value } = await env.SKINS.getWithMetadata("featured:" + f[1].toLowerCase(), { type: "arrayBuffer" });
      if (!value) return text("no skin", 404, { "cache-control": "public, max-age=60" });
      return new Response(req.method === "HEAD" ? null : value, { headers: { "content-type": "image/png", "cache-control": "public, max-age=3600", ...CORS } });
    }
    const m = url.pathname.match(/^\/skins\/([A-Za-z0-9_]+?)(?:\.png)?$/);
    if (!m || !NAME.test(m[1])) return text("not found", 404);
    const key = "skin:" + m[1].toLowerCase();
    if (await env.SKINS.get("ban:name:" + m[1].toLowerCase())) {
      if (req.method !== "GET" && req.method !== "HEAD") ctx.waitUntil(logEvent(env, { type: "blocked", ip, target: m[1].toLowerCase(), reason: "banned name" }));
      return text(req.method === "GET" || req.method === "HEAD" ? "no skin" : "banned", req.method === "GET" || req.method === "HEAD" ? 404 : 403);
    }

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
      if (await env.SKINS.get("ban:owner:" + owner)) { ctx.waitUntil(logEvent(env, { type: "blocked", ip, target: m[1].toLowerCase(), reason: "banned token" })); return text("banned", 403); }
      const { metadata } = await env.SKINS.getWithMetadata(key, { type: "arrayBuffer" });
      if (metadata && metadata.owner !== owner) return text("this name belongs to another token", 403);
      const now = Date.now();
      if (metadata && now - (metadata.t || 0) < MIN_SECONDS_BETWEEN_WRITES * 1000) return text("too many updates, wait a moment", 429);
      const asked = req.headers.get("x-skin-listed");
      const listed = asked === null ? !!(metadata && metadata.listed) : asked === "1";
      const info = clientInfo(req);
      await env.SKINS.put(key, body, { metadata: { owner, t: now, listed, name: m[1], ip, f: (metadata && (metadata.f || metadata.t)) || now, c: info.c, cy: info.cy, dv: info.dv, os: info.os } });
      ctx.waitUntil(touchClient(env, ip, info, m[1].toLowerCase()));
      ctx.waitUntil(logEvent(env, { type: "skin_put", ip, target: m[1].toLowerCase() }));
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
      ctx.waitUntil(logEvent(env, { type: "skin_delete", ip, target: m[1].toLowerCase() }));
      return text("deleted", 200);
    }
    return text("method not allowed", 405, { allow: "GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS" });
  },
};
