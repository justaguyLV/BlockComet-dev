// Developer-only admin panel for the BlockComet skin service. Lives at /admin on the same worker.
// Protection: secret password (ADMIN_PASSWORD, username "developer"), slowed-down wrong tries per IP (no lock-out), signed HttpOnly session cookie,
// SameSite=Strict + custom header on every API call, strict CSP, optional IP allow-list (ADMIN_ALLOWED_IPS).
// If ADMIN_PASSWORD is missing or shorter than 12 characters, /admin answers 404 (panel disabled).

const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const safeEq = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

const SESSION_SECONDS = 2 * 60 * 60;
const MAX_FAILS = 5;
const LOCK_SECONDS = 15 * 60;
const SEC = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
};
const reply = (body, status = 200, extra = {}) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...SEC, ...extra } });
const jsonReply = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...SEC, ...extra } });

// events are stored newest-first (reverse timestamp in the key) and expire after 14 days
export async function logEvent(env, ev) {
  try {
    const key = "log:" + String(9999999999999 - Date.now()).padStart(13, "0") + ":" + crypto.randomUUID().slice(0, 6);
    await env.SKINS.put(key, JSON.stringify({ t: Date.now(), ...ev }), { expirationTtl: 14 * 24 * 3600 });
  } catch (e) { /* logging must never break a request */ }
}

const PERMS = ["stats", "logs", "skins", "ips", "devices", "times", "ban", "banip", "unban", "delete"];
const ALL = Object.fromEntries(PERMS.map((k) => [k, true]));
const STAFF_NAME = /^[a-z0-9_-]{2,20}$/;
const bytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
async function pbk(pw, saltHex) {
  const k = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: bytes(saltHex), iterations: 10000 }, k, 256));
}
const cleanPerms = (p) => { const o = {}; for (const k of PERMS) o[k] = !!(p && p[k]); return o; };
const cleanLimit = (n) => { const v = Math.floor(Number(n)); return Number.isFinite(v) ? Math.min(1000, Math.max(0, v)) : 30; };
function genPassword() {
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  const al = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return [...a].map((x) => al[x % al.length]).join("");
}
async function getStaff(env, name) {
  if (!STAFF_NAME.test(name) || name === "admin" || name === "developer") return null;
  try { const v = await env.SKINS.get("staff:" + name); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
async function setPassword(rec, pw) {
  rec.salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  rec.h = await pbk(pw, rec.salt);
}

// The signed cookie only says WHO logged in; the staff member's permissions are read from KV on every request,
// so editing or deleting an account takes effect immediately.
async function sessionInfo(req, env) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)bc_admin=([0-9]+)\.([0-9a-f]+)\.([0-9a-f]+)\.([0-9a-f]+)/);
  if (!m || Number(m[1]) < Date.now()) return null;
  const want = await hmac("bc-session:" + env.ADMIN_PASSWORD, m[1] + "." + m[2] + "." + m[3]);
  if (!safeEq(want, m[4])) return null;
  let who = "";
  try { who = new TextDecoder().decode(bytes(m[3])); } catch (e) { return null; }
  if (who === "admin:admin") return { role: "admin", name: "developer", perms: ALL, limit: 0, exp: Number(m[1]) };
  if (who.startsWith("staff:")) {
    const name = who.slice(6), rec = await getStaff(env, name);
    if (rec && !rec.off) return { role: "staff", name, perms: cleanPerms(rec.perms), limit: rec.limit === undefined ? 30 : cleanLimit(rec.limit), exp: Number(m[1]) };
  }
  return null;
}

async function login(req, env, ip) {
  const rl = "rl:" + (ip || "none");
  const fails = parseInt((await env.SKINS.get(rl)) || "0", 10);
  // no lock-out: the right username + password always gets in, however many wrong tries came before it.
  // Wrong tries only get slower (up to 5 s each), so guessing stays impractical against the long random passwords.
  let pw = "", user = "";
  try { const b = await req.json(); pw = String(b.password || ""); user = String(b.username || "").trim().toLowerCase(); } catch (e) { /* bad body */ }
  let role = "admin", name = "developer", ok = false;
  if (user === "developer") {
    ok = safeEq(await sha("bc-pw:" + pw), await sha("bc-pw:" + env.ADMIN_PASSWORD));
  } else {
    role = "staff"; name = user;
    const rec = await getStaff(env, user);
    ok = !!rec && !rec.off && !!rec.h && safeEq(await pbk(pw, rec.salt), rec.h);
  }
  if (!ok) {
    await env.SKINS.put(rl, String(fails + 1), { expirationTtl: LOCK_SECONDS });
    await logEvent(env, { type: "admin_login_failed", ip, by: user || "" });
    await new Promise((r) => setTimeout(r, Math.min(5000, 600 + 500 * fails)));
    return jsonReply({ error: "wrong username or password" }, 401);
  }
  await env.SKINS.delete(rl);
  const exp = Date.now() + SESSION_SECONDS * 1000;
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const who = hex(enc.encode(role === "admin" ? "admin:admin" : role + ":" + name));
  const sig = await hmac("bc-session:" + env.ADMIN_PASSWORD, exp + "." + nonce + "." + who);
  await logEvent(env, { type: "admin_login", ip, by: name });
  return jsonReply({ ok: true }, 200, { "set-cookie": `bc_admin=${exp}.${nonce}.${who}.${sig}; Path=/admin; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict` });
}

const NAME = /^[A-Za-z0-9_]{3,16}$/;
const IPV = /^[0-9a-fA-F:.]{3,45}$/;

async function api(req, env, ctx, url, ip, sess) {
  const p = url.pathname.slice("/admin/api/".length);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const actor = sess.name, admin = sess.role === "admin";
  const can = (k) => admin || !!sess.perms[k];
  const no = () => jsonReply({ error: "forbidden" }, 403);
  const redact = (e) => { // hide what this account may not see inside a log line
    const o = { ...e };
    if (!can("ips")) { delete o.ip; if (o.type === "ban_ip" || o.type === "unban_ip") o.target = "(مخفي)"; if (o.ipBanned) o.ipBanned = "yes"; }
    return o;
  };

  if (p.startsWith("staff") && !admin) return no();
  if (p === "ping") return jsonReply({ ok: true });

  if (p === "logs") {
    if (!can("logs")) return no();
    const page = await env.SKINS.list({ prefix: "log:", limit: 150 });
    const out = [];
    for (const k of page.keys) { const v = await env.SKINS.get(k.name); if (v) { try { out.push(redact(JSON.parse(v))); } catch (e) { /* skip */ } } }
    return jsonReply({ logs: out });
  }
  if (p === "players") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    if (q && !/^[a-z0-9_]{1,16}$/.test(q)) return jsonReply({ players: [] });
    const page = await env.SKINS.list({ prefix: "skin:" + q, limit: 200 });
    return jsonReply({ players: page.keys.map((k) => {
      const m = k.metadata || {};
      const o = { name: m.name || k.name.slice(5), listed: !!m.listed };
      if (can("times")) { o.t = m.t || 0; o.f = m.f || m.t || 0; }
      if (can("ips")) o.ip = m.ip || "";
      if (can("devices")) { o.c = m.c || ""; o.cy = m.cy || ""; o.dv = m.dv || ""; o.os = m.os || ""; }
      return o;
    }) });
  }
  if (p === "player") {
    const n = (url.searchParams.get("name") || "").toLowerCase();
    if (!/^[a-z0-9_]{3,16}$/.test(n)) return jsonReply({ error: "bad name" }, 400);
    const l = await env.SKINS.list({ prefix: "skin:" + n, limit: 5 });
    const k = l.keys.find((x) => x.name === "skin:" + n);
    const m = (k && k.metadata) || null;
    let ban = null;
    try { const b = await env.SKINS.get("ban:name:" + n); if (b) ban = JSON.parse(b); } catch (e) { ban = {}; }
    const out = { name: n, hasSkin: !!m, ban, skin: m ? { listed: !!m.listed } : null };
    if (m) {
      if (can("times")) { out.skin.t = m.t || 0; out.skin.f = m.f || m.t || 0; }
      if (can("ips")) out.skin.ip = m.ip || "";
      if (can("devices")) { out.skin.c = m.c || ""; out.skin.cy = m.cy || ""; out.skin.dv = m.dv || ""; out.skin.os = m.os || ""; }
    }
    if (m && m.ip) {
      if (can("ips") || can("banip") || can("unban")) out.ipBanned = !!(await env.SKINS.get("ban:ip:" + m.ip));
      if (can("devices") || can("times")) {
        const c = await env.SKINS.list({ prefix: "cl:" + m.ip, limit: 5 });
        const ck = c.keys.find((x) => x.name === "cl:" + m.ip), cm = ck ? ck.metadata || {} : null;
        if (cm) {
          out.client = {};
          if (can("devices")) Object.assign(out.client, { asn: cm.asn || "", ua: cm.ua || "", dv: cm.dv || "", os: cm.os || "", c: cm.c || "", cy: cm.cy || "" });
          if (can("times")) Object.assign(out.client, { f: cm.f || 0, l: cm.l || 0 });
        }
      }
      if (can("ips")) {
        const all = await env.SKINS.list({ prefix: "skin:", limit: 1000 });
        out.sameIp = all.keys.filter((x) => x.metadata && x.metadata.ip === m.ip && x.name !== "skin:" + n).map((x) => x.metadata.name || x.name.slice(5)).slice(0, 20);
      }
    }
    if (can("logs")) {
      const lp = await env.SKINS.list({ prefix: "log:", limit: 100 });
      const events = [];
      for (const lk of lp.keys) {
        if (events.length >= 20) break;
        const v = await env.SKINS.get(lk.name);
        if (!v) continue;
        try { const e = JSON.parse(v); if (e.target === n || (m && m.ip && e.ip === m.ip)) events.push(redact(e)); } catch (e) { /* skip */ }
      }
      out.events = events;
    }
    return jsonReply(out);
  }
  if (p === "clients") {
    if (!can("ips")) return no();
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const page = await env.SKINS.list({ prefix: "cl:", limit: 1000 });
    let out = page.keys.map((k) => { const m = k.metadata || {}; const o = { ip: k.name.slice(3), nm: m.nm || [] };
      if (can("devices")) Object.assign(o, { os: m.os || "", dv: m.dv || "", c: m.c || "", cy: m.cy || "", asn: m.asn || "" });
      if (can("times")) Object.assign(o, { f: m.f || 0, l: m.l || 0 });
      return o; });
    if (q) out = out.filter((c) => (c.ip + " " + c.nm.join(" ") + " " + (c.dv || "") + " " + (c.os || "") + " " + (c.c || "") + " " + (c.cy || "") + " " + (c.asn || "")).toLowerCase().includes(q));
    out.sort((a, b) => (b.l || 0) - (a.l || 0));
    const bl = await env.SKINS.list({ prefix: "ban:ip:", limit: 1000 });
    const bset = new Set(bl.keys.map((k) => k.name.slice(7)));
    return jsonReply({ clients: out.slice(0, 200).map((c) => ({ ...c, banned: bset.has(c.ip) })), total: page.keys.length });
  }
  if (p === "stats") {
    if (!can("stats")) return no();
    const [sk, cl, bn] = await Promise.all([env.SKINS.list({ prefix: "skin:", limit: 1000 }), env.SKINS.list({ prefix: "cl:", limit: 1000 }), env.SKINS.list({ prefix: "ban:", limit: 1000 })]);
    const now = Date.now(), day = 86400000;
    const countries = {}, devices = {};
    let new24 = 0, new7 = 0, act24 = 0;
    for (const k of cl.keys) {
      const md = k.metadata || {};
      if ((md.f || 0) > now - day) new24++;
      if ((md.f || 0) > now - 7 * day) new7++;
      if ((md.l || 0) > now - day) act24++;
      if (md.c) countries[md.c] = (countries[md.c] || 0) + 1;
      if (md.dv) devices[md.dv] = (devices[md.dv] || 0) + 1;
    }
    const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return jsonReply({
      players: sk.keys.length, listed: sk.keys.filter((k) => (k.metadata || {}).listed).length,
      uploads24: sk.keys.filter((k) => ((k.metadata || {}).t || 0) > now - day).length,
      clients: cl.keys.length, new24, new7, act24,
      bannedNames: bn.keys.filter((k) => k.name.startsWith("ban:name:")).length, bannedIps: bn.keys.filter((k) => k.name.startsWith("ban:ip:")).length,
      countries: top(countries), devices: top(devices),
    });
  }
  if (p === "bans") {
    const page = await env.SKINS.list({ prefix: "ban:", limit: 500 });
    const out = [];
    for (const k of page.keys) {
      const [, kind, ...rest] = k.name.split(":");
      if (kind === "owner") continue; // internal: the token behind a banned name
      if (kind === "ip" && !can("ips")) continue; // IP bans are only listed for accounts allowed to see IPs
      let v = {}; try { v = JSON.parse((await env.SKINS.get(k.name)) || "{}"); } catch (e) { /* skip */ }
      out.push({ kind, value: rest.join(":"), reason: v.reason || "", t: v.t || 0 });
    }
    return jsonReply({ bans: out });
  }
  if (p === "ban" && req.method === "POST") {
    const kind = body.kind, reason = String(body.reason || "").slice(0, 200), now = Date.now();
    if (kind === "ip") { if (!(can("banip") && can("ips"))) return no(); }
    else if (kind === "name") {
      if (body.ipOnly) { if (!can("banip")) return no(); }
      else { if (!can("ban")) return no(); if (body.alsoIp && !can("banip")) return no(); }
    } else return jsonReply({ error: "bad kind" }, 400);
    if (!admin) {
      if (reason.trim().length < 3) return jsonReply({ error: "اكتب سبب الحظر" }, 400);
      if (sess.limit > 0) {
        const bk = "bl:" + actor, used = parseInt((await env.SKINS.get(bk)) || "0", 10);
        if (used >= sess.limit) return jsonReply({ error: "وصلت الحد (" + sess.limit + " حظر بالساعة)، كلّم المطور" }, 429);
        await env.SKINS.put(bk, String(used + 1), { expirationTtl: 3600 });
      }
    }
    if (kind === "ip") {
      const v = String(body.value || "").trim();
      if (!IPV.test(v)) return jsonReply({ error: "bad ip" }, 400);
      if (v === ip) return jsonReply({ error: "هذا الـ IP حقك أنت" }, 400);
      await env.SKINS.put("ban:ip:" + v, JSON.stringify({ reason, t: now }));
      await logEvent(env, { type: "ban_ip", ip, target: v, reason, by: actor });
      return jsonReply({ ok: true });
    }
    const v = String(body.value || "").trim();
    if (!NAME.test(v)) return jsonReply({ error: "bad name" }, 400);
    const low = v.toLowerCase();
    const { metadata } = await env.SKINS.getWithMetadata("skin:" + low, { type: "arrayBuffer" });
    const tip = metadata && metadata.ip;
    if ((body.alsoIp || body.ipOnly) && tip && tip === ip) return jsonReply({ error: "هذا الحظر يحظر الـ IP حقك أنت" }, 400);
    if (body.ipOnly) {
      if (!tip) return jsonReply({ error: "ما في IP معروف لهذا اللاعب" }, 404);
      await env.SKINS.put("ban:ip:" + tip, JSON.stringify({ reason: "with " + low + (reason ? ": " + reason : ""), t: now }));
      await logEvent(env, { type: "ban_ip", ip, target: tip, reason: "player " + low + (reason ? ": " + reason : ""), by: actor });
      return jsonReply(can("ips") ? { ok: true, ipBanned: tip } : { ok: true, ipBanned: true });
    }
    await env.SKINS.put("ban:name:" + low, JSON.stringify({ reason, t: now }));
    if (metadata && metadata.owner) await env.SKINS.put("ban:owner:" + metadata.owner, JSON.stringify({ reason, t: now, name: low }));
    await env.SKINS.delete("skin:" + low);
    ctx.waitUntil(caches.default.delete(new Request(url.origin + "/skins/" + v + ".png")));
    let ipBanned = "";
    if (body.alsoIp && tip) { await env.SKINS.put("ban:ip:" + tip, JSON.stringify({ reason: "with " + low + (reason ? ": " + reason : ""), t: now })); ipBanned = tip; }
    await logEvent(env, { type: "ban_name", ip, target: low, reason, ipBanned, by: actor });
    return jsonReply({ ok: true, ipBanned: can("ips") ? ipBanned : !!ipBanned });
  }
  if (p === "unban" && req.method === "POST") {
    const kind = body.kind, v = String(body.value || "").trim();
    if (!can("unban")) return no();
    if (kind === "ip" && IPV.test(v)) { if (!can("ips")) return no(); await env.SKINS.delete("ban:ip:" + v); }
    else if (kind === "name" && NAME.test(v)) {
      const low = v.toLowerCase();
      const raw = await env.SKINS.list({ prefix: "ban:owner:", limit: 1000 });
      for (const k of raw.keys) { try { const o = JSON.parse((await env.SKINS.get(k.name)) || "{}"); if (o.name === low) await env.SKINS.delete(k.name); } catch (e) { /* skip */ } }
      await env.SKINS.delete("ban:name:" + low);
    } else return jsonReply({ error: "bad request" }, 400);
    await logEvent(env, { type: "unban_" + kind, ip, target: kind === "ip" ? v : v.toLowerCase(), by: actor });
    return jsonReply({ ok: true });
  }
  if (p === "delete-skin" && req.method === "POST") {
    if (!can("delete")) return no();
    const v = String(body.value || "").trim();
    if (!NAME.test(v)) return jsonReply({ error: "bad name" }, 400);
    await env.SKINS.delete("skin:" + v.toLowerCase());
    ctx.waitUntil(caches.default.delete(new Request(url.origin + "/skins/" + v + ".png")));
    await logEvent(env, { type: "admin_delete_skin", ip, target: v.toLowerCase(), by: actor });
    return jsonReply({ ok: true });
  }

  // ---- staff accounts (admin only) ----
  if (p === "staff") {
    const page = await env.SKINS.list({ prefix: "staff:", limit: 200 });
    const out = [];
    for (const k of page.keys) {
      try { const r = JSON.parse((await env.SKINS.get(k.name)) || "{}"); out.push({ name: k.name.slice(6), perms: cleanPerms(r.perms), limit: r.limit === undefined ? 30 : cleanLimit(r.limit), off: !!r.off, t: r.t || 0, by: r.by || "" }); } catch (e) { /* skip */ }
    }
    return jsonReply({ staff: out });
  }
  if (p === "staff-save" && req.method === "POST") {
    const name = String(body.name || "").trim().toLowerCase();
    if (!STAFF_NAME.test(name) || name === "admin" || name === "developer") return jsonReply({ error: "اسم غير صالح (حروف إنجليزية صغيرة وأرقام و _ أو -، من 2 إلى 20)" }, 400);
    let rec = await getStaff(env, name), password = "";
    if (body.create) {
      if (rec) return jsonReply({ error: "الاسم موجود" }, 409);
      rec = { t: Date.now(), by: actor };
      password = genPassword(); await setPassword(rec, password);
    } else {
      if (!rec) return jsonReply({ error: "غير موجود" }, 404);
      if (body.reset) { password = genPassword(); await setPassword(rec, password); }
    }
    if (body.perms) rec.perms = cleanPerms(body.perms); else if (!rec.perms) rec.perms = cleanPerms({});
    if (body.limit !== undefined) rec.limit = cleanLimit(body.limit);
    if (body.off !== undefined) rec.off = !!body.off;
    await env.SKINS.put("staff:" + name, JSON.stringify(rec));
    await logEvent(env, { type: body.create ? "staff_create" : body.reset ? "staff_reset" : "staff_update", ip, target: name, by: actor });
    return jsonReply({ ok: true, password });
  }
  if (p === "staff-delete" && req.method === "POST") {
    const name = String(body.name || "").trim().toLowerCase();
    if (!STAFF_NAME.test(name)) return jsonReply({ error: "bad name" }, 400);
    await env.SKINS.delete("staff:" + name);
    await logEvent(env, { type: "staff_delete", ip, target: name, by: actor });
    return jsonReply({ ok: true });
  }
  return jsonReply({ error: "not found" }, 404);
}

function page(nonce, sess, host) {
  const authed = !!sess, isStaff = !!sess && sess.role === "staff";
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self' wss://${host}; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>BlockComet Admin</title>
<style nonce="${nonce}">
:root{--bg:#0f1115;--card:#181b22;--line:#2a2f3a;--tx:#e8eaf0;--mut:#8b93a5;--ac:#f5c518;--bad:#ff5d5d;--ok:#4cd964}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px system-ui,sans-serif;padding:12px;max-width:900px;margin:auto}
h1{font-size:18px;color:var(--ac);margin:6px 0 12px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:12px}
input,button{font:inherit;border-radius:8px;border:1px solid var(--line);background:#0f1115;color:var(--tx);padding:9px 10px}
button{background:var(--ac);color:#000;border:0;font-weight:600;cursor:pointer}button.s{background:#262b36;color:var(--tx)}button.d{background:var(--bad);color:#fff}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}.row>input{flex:1;min-width:120px}.tabs{display:flex;gap:6px;margin-bottom:12px}.tabs button{flex:1}
.tabs button.on{background:var(--ac);color:#000}.tabs button:not(.on){background:#262b36;color:var(--tx)}
.it{border-bottom:1px solid var(--line);padding:8px 0;display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}.it:last-child{border:0}
.m{color:var(--mut);font-size:12px;direction:ltr;unicode-bidi:plaintext;word-break:break-all}.tag{font-size:11px;padding:2px 6px;border-radius:6px;background:#262b36}.bad{color:var(--bad)}.ok{color:var(--ok)}.v{direction:ltr;unicode-bidi:plaintext;word-break:break-all;text-align:left}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:12px}.grid .card{margin:0}.big{font-size:24px;font-weight:700;color:var(--ac)}.chat{height:55vh;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:8px;background:var(--card);margin-bottom:8px}.msg{margin-bottom:8px;max-width:85%;padding:6px 10px;border-radius:10px;background:#262b36}.msg.me{background:#3a3320;margin-inline-start:auto}.tx{white-space:pre-wrap;word-break:break-word}.sk{image-rendering:pixelated;width:192px;height:192px;background:#0b0d11;border:1px solid var(--line);border-radius:8px}
</style></head><body><h1>BlockComet — ${isStaff ? "لوحة الستاف" : "لوحة المطورين"}</h1><div id="app"></div>
<script nonce="${nonce}">
const A=document.getElementById("app");
const el=(t,a={},...k)=>{const e=document.createElement(t);for(const[x,v]of Object.entries(a)){if(x==="onclick")e.onclick=v;else if(x==="class")e.className=v;else e.setAttribute(x,v)}for(const c of k)e.append(c);return e};
const call=async(p,b)=>{const r=await fetch("/admin/api/"+p,{method:b?"POST":"GET",headers:{"x-admin":"1","content-type":"application/json"},body:b?JSON.stringify(b):undefined,credentials:"same-origin"});if(r.status===401){location.reload();return{}}return r.json()};
const when=t=>t?new Date(t).toLocaleString("ar-EG"):"";
${authed ? "const ME=" + JSON.stringify({ role: sess.role, name: sess.name, perms: sess.role === "admin" ? ALL : sess.perms }) + ";\n" + panelJs() : loginJs()}
</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, ...SEC } });
}

function loginJs() {
  return `
const us=el("input",{placeholder:"اسم المستخدم",autocomplete:"username"});const pw=el("input",{type:"password",placeholder:"كلمة السر",autocomplete:"current-password"});const msg=el("div",{class:"m"});
const go=async()=>{const r=await fetch("/admin/login",{method:"POST",headers:{"x-admin":"1","content-type":"application/json"},body:JSON.stringify({username:us.value,password:pw.value}),credentials:"same-origin"});const d=await r.json().catch(()=>({}));if(d.ok)location.reload();else msg.textContent=d.error||"error"};
pw.addEventListener("keydown",e=>{if(e.key==="Enter")go()});
A.append(el("div",{class:"card"},el("div",{class:"row"},us),el("div",{class:"row"},pw,el("button",{onclick:go},"دخول")),msg));`;
}

function panelJs() {
  return `
const can=k=>ME.role==="admin"||!!ME.perms[k];
const PL={stats:"الإحصاءات",logs:"السجل",skins:"صور السكنات",ips:"رؤية الـ IP",devices:"الجهاز والموقع",times:"الأوقات (أول ظهور وآخر نشاط)",ban:"حظر الأسماء",banip:"حظر الـ IP",unban:"فك الحظر",delete:"حذف السكنات"};
const TY={ban_name:"حظر لاعب",ban_ip:"حظر IP",unban_name:"فك حظر لاعب",unban_ip:"فك حظر IP",skin_put:"رفع/تحديث سكن",skin_delete:"حذف سكن",admin_delete_skin:"حذف سكن",blocked:"محاولة محظورة",admin_login:"دخول",admin_login_failed:"دخول فاشل",staff_create:"إنشاء ستاف",staff_update:"تعديل ستاف",staff_reset:"كلمة سر جديدة لستاف",staff_delete:"حذف ستاف"};
const ago=t=>{if(!t)return "—";const s=Math.floor((Date.now()-t)/1000);if(s<60)return "قبل لحظات";if(s<3600)return "قبل "+Math.floor(s/60)+" دقيقة";if(s<86400)return "قبل "+Math.floor(s/3600)+" ساعة";return "قبل "+Math.floor(s/86400)+" يوم"};
const devOf=o=>[o.dv,o.os].filter(Boolean).join(" · ")||"غير معروف";
const locOf=o=>[o.cy,o.c].filter(Boolean).join(", ")||"—";
const TABS=[["stats","الإحصاءات",can("stats")],["logs","السجل",can("logs")],["players","اللاعبون",true],["clients","الأجهزة",can("ips")],["bans","المحظورون",true],["chat","الشات",true],["staff","الستاف",ME.role==="admin"]].filter(t=>t[2]);
const tabs=el("div",{class:"tabs"});const box=el("div");A.append(tabs,box);let cur=TABS[0][0];
const out=async()=>{await fetch("/admin/logout",{method:"POST",headers:{"x-admin":"1"},credentials:"same-origin"});location.reload()};
const draw=()=>{tabs.replaceChildren(...TABS.map(([k,n])=>el("button",{class:cur===k?"on":"",onclick:()=>{cur=k;if(k==="chat")CH.unread=0;draw();show()}},n+(k==="chat"&&CH.unread?" ("+CH.unread+")":""))),el("button",{class:"s",onclick:out},"خروج"))};
const FN={};
async function show(){box.replaceChildren(el("div",{class:"m"},"..."));FN[cur]()}
const kv=(k,v)=>el("div",{class:"it"},el("span",{class:"m"},k),el("span",{class:"v"},v||"—"));
const stat=(n,v)=>el("div",{class:"card"},el("div",{class:"m"},n),el("div",{class:"big"},String(v)));
const evRow=l=>el("div",{class:"it"},el("div",{},el("span",{class:"tag"},TY[l.type]||l.type)," ",l.target||"",(l.reason?" — "+l.reason:"")+(l.by?" ["+l.by+"]":"")),el("div",{class:"m"},when(l.t)+"  "+(l.ip||"")));
FN.stats=async function(){const d=await call("stats");box.replaceChildren(el("div",{class:"grid"},stat("اللاعبون (سكنات)",d.players),stat("ظاهرة في المعرض",d.listed),stat("الأجهزة (IP)",d.clients),stat("أجهزة جديدة خلال 24 ساعة",d.new24),stat("أجهزة جديدة خلال 7 أيام",d.new7),stat("نشطة خلال 24 ساعة",d.act24),stat("سكنات مرفوعة خلال 24 ساعة",d.uploads24),stat("محظورون (أسماء / IP)",d.bannedNames+" / "+d.bannedIps)),el("div",{class:"card"},el("div",{class:"m"},"أكثر الدول"),...(d.countries||[]).map(([c,n])=>kv(c,n))),el("div",{class:"card"},el("div",{class:"m"},"أكثر الأجهزة"),...(d.devices||[]).map(([c,n])=>kv(c,n))))};
FN.logs=async function(){const d=await call("logs");box.replaceChildren(el("div",{class:"row"},el("button",{class:"s",onclick:show},"تحديث")),el("div",{class:"card"},...(d.logs||[]).map(evRow)))};
async function ban(name,mode){const r=prompt("سبب الحظر (مطلوب)؟");if(r===null)return false;if(r.trim().length<3){alert("اكتب سبب واضح");return false}
const what=mode==="ip"?"حظر الـ IP فقط":mode==="both"?"حظر الاسم والـ IP":"حظر الاسم";if(!confirm(what+" — "+name+" ؟"))return false;
const x=await call("ban",{kind:"name",value:name,reason:r.trim(),alsoIp:mode==="both",ipOnly:mode==="ip"});if(x.error){alert(x.error);return false}alert(x.ipBanned?"تم، والـ IP انحظر":"تم");return true}
async function banIp(ip){const r=prompt("سبب حظر الـ IP (مطلوب)؟");if(r===null)return false;if(r.trim().length<3){alert("اكتب سبب واضح");return false}const x=await call("ban",{kind:"ip",value:ip,reason:r.trim()});if(x.error){alert(x.error);return false}return true}
async function detail(name){box.replaceChildren(el("div",{class:"m"},"..."));const d=await call("player?name="+encodeURIComponent(name));
if(d.error){box.replaceChildren(el("div",{class:"card"},d.error));return}
const s=d.skin,c=d.client||{};const acts=el("div",{class:"row"},el("button",{class:"s",onclick:()=>{cur="players";draw();show()}},"رجوع"));
if(d.ban){if(can("unban"))acts.append(el("button",{class:"s",onclick:async()=>{await call("unban",{kind:"name",value:name});detail(name)}},"فك حظر اللاعب"))}
else if(can("ban"))acts.append(el("button",{class:"d",onclick:async()=>{if(await ban(name,"name"))detail(name)}},"حظر الاسم"));
if(s&&can("ban")&&can("banip")&&!d.ban)acts.append(el("button",{class:"d",onclick:async()=>{if(await ban(name,"both"))detail(name)}},"الاسم + IP"));
if(s&&can("banip")){if(d.ipBanned){if(can("unban")&&can("ips")&&s.ip)acts.append(el("button",{class:"s",onclick:async()=>{await call("unban",{kind:"ip",value:s.ip});detail(name)}},"فك حظر الـ IP"))}else acts.append(el("button",{class:"d",onclick:async()=>{if(await ban(name,"ip"))detail(name)}},"حظر الـ IP فقط"))}
if(d.hasSkin&&can("delete"))acts.append(el("button",{class:"s",onclick:async()=>{if(confirm("حذف السكن؟")){await call("delete-skin",{value:name});detail(name)}}},"حذف السكن"));
const info=el("div",{class:"card"},kv("الاسم",name),kv("الحالة",d.ban?"محظور"+(d.ban.reason?" — "+d.ban.reason:"")+(d.ban.t?" ("+when(d.ban.t)+")":""):"نشط"));
if(s){if(s.f!==undefined)info.append(kv("أول ظهور للسكن",when(s.f)+" ("+ago(s.f)+")"),kv("آخر تحديث للسكن",when(s.t)+" ("+ago(s.t)+")"));info.append(kv("ظاهر في المعرض",s.listed?"نعم":"لا"));if(s.ip!==undefined)info.append(kv("الـ IP",s.ip+(d.ipBanned?" (محظور)":"")));else if(d.ipBanned)info.append(kv("الـ IP","محظور"));if(s.c!==undefined||c.c!==undefined){const o=(c.dv||c.os||c.c||c.cy)?c:s;info.append(kv("الموقع التقريبي",locOf(o)),kv("الجهاز",devOf(o)))}}
if(c.asn!==undefined)info.append(kv("مزود الإنترنت",c.asn),kv("User-Agent",c.ua));
if(c.f!==undefined)info.append(kv("أول اتصال من هذا الجهاز/الشبكة",when(c.f)+" ("+ago(c.f)+")"),kv("آخر اتصال",when(c.l)+" ("+ago(c.l)+")"));
if((d.sameIp||[]).length)info.append(kv("أسماء أخرى من نفس الـ IP",d.sameIp.join(", ")));
const head=[acts];if(d.hasSkin&&can("skins")){const img=el("img",{class:"sk",alt:""});img.setAttribute("src","/skins/"+name+".png");head.push(el("div",{class:"card"},img))}
const rest=[info];if(d.events)rest.push(el("div",{class:"card"},el("div",{class:"m"},"آخر الأحداث المرتبطة"),...d.events.map(evRow)));
box.replaceChildren(...head,...rest)}
FN.players=async function(){const q=el("input",{placeholder:"ابدأ باسم اللاعب"});const list=el("div",{class:"card"});
const load=async()=>{const d=await call("players?q="+encodeURIComponent(q.value.trim()));list.replaceChildren(...(d.players||[]).map(p=>{const l1=[];if(p.f!==undefined)l1.push("أول ظهور: "+when(p.f));if(p.ip!==undefined)l1.push("IP: "+(p.ip||"—"));
return el("div",{class:"it"},el("div",{},el("span",{class:"v"},p.name),l1.length?el("div",{class:"m"},l1.join("  ·  ")):"",p.dv!==undefined?el("div",{class:"m"},devOf(p)+"  ·  "+locOf(p)):""),
el("div",{class:"row"},el("button",{class:"s",onclick:()=>detail(p.name)},"تفاصيل"),can("ban")?el("button",{class:"d",onclick:async()=>{if(await ban(p.name,"name"))load()}},"حظر الاسم"):"",can("ban")&&can("banip")?el("button",{class:"d",onclick:async()=>{if(await ban(p.name,"both"))load()}},"الاسم + IP"):"",can("banip")?el("button",{class:"d",onclick:async()=>{if(await ban(p.name,"ip"))load()}},"IP فقط"):""))}))};
q.addEventListener("input",()=>{clearTimeout(window._t);window._t=setTimeout(load,350)});box.replaceChildren(el("div",{class:"row"},q),list);load()};
FN.clients=async function(){const q=el("input",{placeholder:"بحث: IP، اسم، جهاز، دولة، مدينة"});const list=el("div",{class:"card"});const note=el("div",{class:"m"},"أول ظهور = أول مرة اتصل فيها اللانشر بالخدمة من هذا الـ IP (قريب من وقت أول تشغيل، مو وقت التحميل الفعلي).");
const load=async()=>{const d=await call("clients?q="+encodeURIComponent(q.value.trim()));list.replaceChildren(...(d.clients||[]).map(c=>el("div",{class:"it"},el("div",{},el("span",{class:"v"},c.ip),c.banned?el("span",{class:"tag bad"},"محظور"):"",c.dv!==undefined?el("div",{class:"m"},devOf(c)+"  ·  "+locOf(c)+(c.asn?"  ·  "+c.asn:"")):"",c.f!==undefined?el("div",{class:"m"},"أول ظهور: "+when(c.f)+"  ·  آخر ظهور: "+ago(c.l)):"",(c.nm||[]).length?el("div",{class:"m"},"لاعبون: "+c.nm.join(", ")):""),
el("div",{class:"row"},c.banned?(can("unban")?el("button",{class:"s",onclick:async()=>{await call("unban",{kind:"ip",value:c.ip});load()}},"فك حظر"):""):(can("banip")?el("button",{class:"d",onclick:async()=>{if(await banIp(c.ip))load()}},"حظر IP"):"")))))};
q.addEventListener("input",()=>{clearTimeout(window._t);window._t=setTimeout(load,350)});box.replaceChildren(el("div",{class:"row"},q),note,list);load()};
FN.bans=async function(){const d=await call("bans");const parts=[];
if(can("ban")||(can("banip")&&can("ips"))){const v=el("input",{placeholder:can("banip")&&can("ips")?"اسم لاعب أو IP":"اسم لاعب"});const r=el("input",{placeholder:"السبب"});const add=k=>async()=>{if(!v.value.trim())return;if(r.value.trim().length<3){alert("اكتب سبب واضح");return}const x=await call("ban",{kind:k,value:v.value.trim(),reason:r.value.trim()});if(x.error)alert(x.error);else FN.bans()};
parts.push(el("div",{class:"card"},el("div",{class:"row"},v,r),el("div",{class:"row"},can("ban")?el("button",{class:"d",onclick:add("name")},"حظر لاعب"):"",can("banip")&&can("ips")?el("button",{class:"d",onclick:add("ip")},"حظر IP"):"")))}
parts.push(el("div",{class:"card"},...(d.bans||[]).map(b=>el("div",{class:"it"},el("div",{},el("span",{class:"tag"},b.kind==="ip"?"IP":"لاعب")," ",el("span",{class:"v"},b.value),el("div",{class:"m"},when(b.t)+(b.reason?"  "+b.reason:""))),can("unban")?el("button",{class:"s",onclick:async()=>{await call("unban",{kind:b.kind,value:b.value});FN.bans()}},"فك"):""))));
box.replaceChildren(...parts)};
const permBoxes=cur=>{const w=el("div",{});const cbs={};for(const k of Object.keys(PL)){const c=el("input",{type:"checkbox"});c.checked=!!cur[k];cbs[k]=c;w.append(el("label",{class:"it"},el("span",{},PL[k]),c))}return{w,get:()=>{const o={};for(const k in cbs)o[k]=cbs[k].checked;return o}}};
const pwCard=(name,pw)=>el("div",{class:"card"},el("div",{},"كلمة سر "+name+" (انسخها الآن، ما تظهر مرة ثانية):"),el("div",{class:"v big"},pw));
function editStaff(s){const pb=permBoxes(s.perms);const lim=el("input",{type:"number",min:"0",max:"1000",value:String(s.limit)});const off=el("input",{type:"checkbox"});off.checked=s.off;
box.replaceChildren(el("div",{class:"card"},el("div",{},"تعديل: "+s.name),pb.w,el("label",{class:"it"},el("span",{},"حد الحظر بالساعة (0 = بلا حد)"),lim),el("label",{class:"it"},el("span",{},"موقوف"),off),el("div",{class:"row"},el("button",{onclick:async()=>{const x=await call("staff-save",{name:s.name,perms:pb.get(),limit:Number(lim.value),off:off.checked});if(x.error)alert(x.error);else FN.staff()}},"حفظ"),el("button",{class:"s",onclick:()=>FN.staff()},"رجوع"))))}
FN.staff=async function(note){const d=await call("staff");const parts=[];if(note)parts.push(note);
const nm=el("input",{placeholder:"اسم الستاف (إنجليزي صغير)"});const lim=el("input",{type:"number",min:"0",max:"1000",value:"30"});const pb=permBoxes({ban:true,banip:true});
parts.push(el("div",{class:"card"},el("div",{},"ستاف جديد"),el("div",{class:"row"},nm),pb.w,el("label",{class:"it"},el("span",{},"حد الحظر بالساعة (0 = بلا حد)"),lim),el("button",{onclick:async()=>{const x=await call("staff-save",{create:true,name:nm.value,perms:pb.get(),limit:Number(lim.value)});if(x.error)alert(x.error);else FN.staff(pwCard(nm.value.trim().toLowerCase(),x.password))}},"إنشاء")));
parts.push(el("div",{class:"card"},...((d.staff||[]).length?d.staff.map(s=>el("div",{class:"it"},el("div",{},el("span",{class:"v"},s.name),s.off?el("span",{class:"tag bad"},"موقوف"):"",el("div",{class:"m"},"صلاحيات: "+(Object.keys(PL).filter(k=>s.perms[k]).map(k=>PL[k]).join("، ")||"أسماء فقط")+"  ·  حد: "+(s.limit||"بلا")+"  ·  أنشأه: "+(s.by||"—"))),el("div",{class:"row"},el("button",{class:"s",onclick:()=>editStaff(s)},"تعديل"),el("button",{class:"s",onclick:async()=>{if(!confirm("كلمة سر جديدة لـ "+s.name+"؟ القديمة تتعطل."))return;const x=await call("staff-save",{name:s.name,reset:true});if(x.error)alert(x.error);else FN.staff(pwCard(s.name,x.password))}},"كلمة سر جديدة"),el("button",{class:"d",onclick:async()=>{if(confirm("حذف "+s.name+"؟")){await call("staff-delete",{name:s.name});FN.staff()}}},"حذف")))):[el("div",{class:"m"},"ما في ستاف بعد")])));
box.replaceChildren(...parts)};
const CH={ws:null,msgs:[],online:[],unread:0,list:null,who:null,input:null};
const hhmm=t=>new Date(t).toLocaleTimeString("ar-EG",{hour:"2-digit",minute:"2-digit"});
function chatRender(){if(cur!=="chat"||!CH.list)return;const atEnd=CH.list.scrollHeight-CH.list.scrollTop-CH.list.clientHeight<60;
CH.who.textContent="متصلون الآن: "+(CH.online.join("، ")||"—");
CH.list.replaceChildren(...CH.msgs.map(m=>el("div",{class:"msg"+(m.by===ME.name?" me":"")},el("div",{class:"m"},m.by+(m.role==="admin"?" (مطوّر)":"")+"  ·  "+hhmm(m.t)+(ME.role==="admin"?"  ":""),ME.role==="admin"?el("button",{class:"s",onclick:()=>{if(CH.ws&&CH.ws.readyState===1)CH.ws.send(JSON.stringify({type:"del",id:m.id}))}},"حذف"):""),el("div",{class:"tx"},m.text))));
if(atEnd||!CH.stuck)CH.list.scrollTop=CH.list.scrollHeight;CH.stuck=true}
function chatConnect(){if(CH.ws&&CH.ws.readyState<2)return;const ws=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host+"/admin/chat");CH.ws=ws;
ws.onmessage=e=>{let d;try{d=JSON.parse(e.data)}catch(x){return}
if(d.type==="history"){CH.msgs=d.messages||[];CH.online=d.online||[]}
else if(d.type==="msg"){CH.msgs.push(d.msg);if(CH.msgs.length>300)CH.msgs.shift();if(cur!=="chat"&&d.msg.by!==ME.name){CH.unread++;draw()}}
else if(d.type==="del"){CH.msgs=CH.msgs.filter(m=>m.id!==d.id)}
else if(d.type==="presence"){CH.online=d.online||[]}
chatRender()};
ws.onclose=async()=>{if(CH.ws===ws)CH.ws=null;const r=await call("ping").catch(()=>null);setTimeout(chatConnect,3000)};
ws.onopen=()=>{clearInterval(CH.pi);CH.pi=setInterval(()=>{if(ws.readyState===1)ws.send('{"type":"ping"}')},25000)}}
FN.chat=function(){CH.unread=0;draw();CH.who=el("div",{class:"m"},"");CH.list=el("div",{class:"chat"});CH.stuck=false;
const inp=el("input",{placeholder:"اكتب رسالة للإدارة...",maxlength:"500"});CH.input=inp;
const send=()=>{const t=inp.value.trim();if(!t)return;if(!CH.ws||CH.ws.readyState!==1){alert("غير متصل، جاري إعادة الاتصال");chatConnect();return}CH.ws.send(JSON.stringify({type:"msg",text:t}));inp.value=""};
inp.addEventListener("keydown",e=>{if(e.key==="Enter")send()});
box.replaceChildren(CH.who,CH.list,el("div",{class:"row"},inp,el("button",{onclick:send},"إرسال")));chatRender();chatConnect()};
chatConnect();
draw();show();`;
}

export async function admin(req, env, ctx, ip) {
  const url = new URL(req.url);
  if (!env.ADMIN_PASSWORD || String(env.ADMIN_PASSWORD).length < 12) return reply("not found", 404);
  const allow = (env.ADMIN_ALLOWED_IPS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allow.length && !allow.includes(ip)) return reply("not found", 404);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/admin/login" && req.method === "POST") {
    if (req.headers.get("x-admin") !== "1") return reply("forbidden", 403);
    return login(req, env, ip);
  }
  const sess = await sessionInfo(req, env);
  if (path === "/admin" && req.method === "GET") return page(crypto.randomUUID().replace(/-/g, ""), sess, url.host);
  if (!sess) return jsonReply({ error: "unauthorized" }, 401);
  if (path === "/admin/chat") { // WebSocket: browsers cannot add the x-admin header, so the cookie (SameSite=Strict) plus an Origin check guard it
    if (req.headers.get("upgrade") !== "websocket") return reply("expected websocket", 426);
    if (req.headers.get("origin") !== url.origin) return reply("forbidden", 403);
    if (!env.CHAT) return reply("chat not available", 503);
    const h = new Headers(req.headers);
    h.set("x-chat-name", sess.name); h.set("x-chat-role", sess.role); h.set("x-chat-exp", String(sess.exp || 0));
    return env.CHAT.get(env.CHAT.idFromName("staff")).fetch(new Request(req, { headers: h }));
  }
  if (req.headers.get("x-admin") !== "1") return reply("forbidden", 403);
  if (path === "/admin/logout" && req.method === "POST") return jsonReply({ ok: true }, 200, { "set-cookie": "bc_admin=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
  if (path.startsWith("/admin/api/")) return api(req, env, ctx, url, ip, sess);
  return reply("not found", 404);
}
