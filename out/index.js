var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/admin.js
var enc = new TextEncoder();
var hex = /* @__PURE__ */ __name((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""), "hex");
var sha = /* @__PURE__ */ __name(async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s))), "sha");
var safeEq = /* @__PURE__ */ __name((a, b) => {
  if (a.length !== b.length)
    return false;
  let r = 0;
  for (let i = 0; i < a.length; i++)
    r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}, "safeEq");
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
__name(hmac, "hmac");
var SESSION_SECONDS = 2 * 60 * 60;
var MAX_FAILS = 5;
var LOCK_SECONDS = 15 * 60;
var SEC = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000"
};
var reply = /* @__PURE__ */ __name((body, status = 200, extra = {}) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...SEC, ...extra } }), "reply");
var jsonReply = /* @__PURE__ */ __name((data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...SEC, ...extra } }), "jsonReply");
async function logEvent(env, ev) {
  try {
    const key = "log:" + String(9999999999999 - Date.now()).padStart(13, "0") + ":" + crypto.randomUUID().slice(0, 6);
    await env.SKINS.put(key, JSON.stringify({ t: Date.now(), ...ev }), { expirationTtl: 14 * 24 * 3600 });
  } catch (e) {
  }
}
__name(logEvent, "logEvent");
async function sessionOk(req, env) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)bc_admin=([0-9]+)\.([0-9a-f]+)\.([0-9a-f]+)/);
  if (!m)
    return false;
  if (Number(m[1]) < Date.now())
    return false;
  const want = await hmac("bc-session:" + env.ADMIN_PASSWORD, m[1] + "." + m[2]);
  return safeEq(want, m[3]);
}
__name(sessionOk, "sessionOk");
async function login(req, env, ip) {
  const rl = "rl:" + (ip || "none");
  const fails = parseInt(await env.SKINS.get(rl) || "0", 10);
  if (fails >= MAX_FAILS)
    return jsonReply({ error: "locked, try later" }, 429);
  let pw = "";
  try {
    pw = String((await req.json()).password || "");
  } catch (e) {
  }
  const ok = safeEq(await sha("bc-pw:" + pw), await sha("bc-pw:" + env.ADMIN_PASSWORD));
  if (!ok) {
    await env.SKINS.put(rl, String(fails + 1), { expirationTtl: LOCK_SECONDS });
    await logEvent(env, { type: "admin_login_failed", ip });
    await new Promise((r) => setTimeout(r, 600));
    return jsonReply({ error: "wrong password" }, 401);
  }
  await env.SKINS.delete(rl);
  const exp = Date.now() + SESSION_SECONDS * 1e3;
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const sig = await hmac("bc-session:" + env.ADMIN_PASSWORD, exp + "." + nonce);
  await logEvent(env, { type: "admin_login", ip });
  return jsonReply({ ok: true }, 200, { "set-cookie": `bc_admin=${exp}.${nonce}.${sig}; Path=/admin; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict` });
}
__name(login, "login");
var NAME = /^[A-Za-z0-9_]{3,16}$/;
var IPV = /^[0-9a-fA-F:.]{3,45}$/;
async function api(req, env, ctx, url, ip) {
  const p = url.pathname.slice("/admin/api/".length);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  if (p === "logs") {
    const page2 = await env.SKINS.list({ prefix: "log:", limit: 150 });
    const out = [];
    for (const k of page2.keys) {
      const v = await env.SKINS.get(k.name);
      if (v) {
        try {
          out.push(JSON.parse(v));
        } catch (e) {
        }
      }
    }
    return jsonReply({ logs: out });
  }
  if (p === "players") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    if (q && !/^[a-z0-9_]{1,16}$/.test(q))
      return jsonReply({ players: [] });
    const page2 = await env.SKINS.list({ prefix: "skin:" + q, limit: 200 });
    return jsonReply({ players: page2.keys.map((k) => ({ name: (k.metadata || {}).name || k.name.slice(5), t: (k.metadata || {}).t || 0, listed: !!(k.metadata || {}).listed, ip: (k.metadata || {}).ip || "" })) });
  }
  if (p === "bans") {
    const page2 = await env.SKINS.list({ prefix: "ban:", limit: 500 });
    const out = [];
    for (const k of page2.keys) {
      const [, kind, ...rest] = k.name.split(":");
      if (kind === "owner")
        continue;
      let v = {};
      try {
        v = JSON.parse(await env.SKINS.get(k.name) || "{}");
      } catch (e) {
      }
      out.push({ kind, value: rest.join(":"), reason: v.reason || "", t: v.t || 0 });
    }
    return jsonReply({ bans: out });
  }
  if (p === "ban" && req.method === "POST") {
    const kind = body.kind, reason = String(body.reason || "").slice(0, 200), now = Date.now();
    if (kind === "ip") {
      const v = String(body.value || "").trim();
      if (!IPV.test(v))
        return jsonReply({ error: "bad ip" }, 400);
      await env.SKINS.put("ban:ip:" + v, JSON.stringify({ reason, t: now }));
      await logEvent(env, { type: "ban_ip", ip, target: v, reason });
      return jsonReply({ ok: true });
    }
    if (kind === "name") {
      const v = String(body.value || "").trim();
      if (!NAME.test(v))
        return jsonReply({ error: "bad name" }, 400);
      const low = v.toLowerCase();
      const { metadata } = await env.SKINS.getWithMetadata("skin:" + low, { type: "arrayBuffer" });
      await env.SKINS.put("ban:name:" + low, JSON.stringify({ reason, t: now }));
      if (metadata && metadata.owner)
        await env.SKINS.put("ban:owner:" + metadata.owner, JSON.stringify({ reason, t: now, name: low }));
      await env.SKINS.delete("skin:" + low);
      ctx.waitUntil(caches.default.delete(new Request(url.origin + "/skins/" + v + ".png")));
      let ipBanned = "";
      if (body.alsoIp && metadata && metadata.ip) {
        await env.SKINS.put("ban:ip:" + metadata.ip, JSON.stringify({ reason: "with " + low + (reason ? ": " + reason : ""), t: now }));
        ipBanned = metadata.ip;
      }
      await logEvent(env, { type: "ban_name", ip, target: low, reason, ipBanned });
      return jsonReply({ ok: true, ipBanned });
    }
    return jsonReply({ error: "bad kind" }, 400);
  }
  if (p === "unban" && req.method === "POST") {
    const kind = body.kind, v = String(body.value || "").trim();
    if (kind === "ip" && IPV.test(v)) {
      await env.SKINS.delete("ban:ip:" + v);
    } else if (kind === "name" && NAME.test(v)) {
      const low = v.toLowerCase();
      const raw = await env.SKINS.list({ prefix: "ban:owner:", limit: 1e3 });
      for (const k of raw.keys) {
        try {
          const o = JSON.parse(await env.SKINS.get(k.name) || "{}");
          if (o.name === low)
            await env.SKINS.delete(k.name);
        } catch (e) {
        }
      }
      await env.SKINS.delete("ban:name:" + low);
    } else
      return jsonReply({ error: "bad request" }, 400);
    await logEvent(env, { type: "unban_" + kind, ip, target: v });
    return jsonReply({ ok: true });
  }
  if (p === "delete-skin" && req.method === "POST") {
    const v = String(body.value || "").trim();
    if (!NAME.test(v))
      return jsonReply({ error: "bad name" }, 400);
    await env.SKINS.delete("skin:" + v.toLowerCase());
    ctx.waitUntil(caches.default.delete(new Request(url.origin + "/skins/" + v + ".png")));
    await logEvent(env, { type: "admin_delete_skin", ip, target: v.toLowerCase() });
    return jsonReply({ ok: true });
  }
  return jsonReply({ error: "not found" }, 404);
}
__name(api, "api");
function page(nonce, authed) {
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
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
.m{color:var(--mut);font-size:12px;direction:ltr;unicode-bidi:plaintext;word-break:break-all}.tag{font-size:11px;padding:2px 6px;border-radius:6px;background:#262b36}.bad{color:var(--bad)}.ok{color:var(--ok)}
</style></head><body><h1>BlockComet \u2014 \u0644\u0648\u062D\u0629 \u0627\u0644\u0645\u0637\u0648\u0631\u064A\u0646</h1><div id="app"></div>
<script nonce="${nonce}">
const A=document.getElementById("app");
const el=(t,a={},...k)=>{const e=document.createElement(t);for(const[x,v]of Object.entries(a)){if(x==="onclick")e.onclick=v;else if(x==="class")e.className=v;else e.setAttribute(x,v)}for(const c of k)e.append(c);return e};
const call=async(p,b)=>{const r=await fetch("/admin/api/"+p,{method:b?"POST":"GET",headers:{"x-admin":"1","content-type":"application/json"},body:b?JSON.stringify(b):undefined,credentials:"same-origin"});if(r.status===401){location.reload();return{}}return r.json()};
const when=t=>t?new Date(t).toLocaleString("ar-EG"):"";
${authed ? panelJs() : loginJs()}
<\/script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, ...SEC } });
}
__name(page, "page");
function loginJs() {
  return `
const pw=el("input",{type:"password",placeholder:"\u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631",autocomplete:"current-password"});const msg=el("div",{class:"m"});
const go=async()=>{const r=await fetch("/admin/login",{method:"POST",headers:{"x-admin":"1","content-type":"application/json"},body:JSON.stringify({password:pw.value}),credentials:"same-origin"});const d=await r.json().catch(()=>({}));if(d.ok)location.reload();else msg.textContent=d.error||"error"};
pw.addEventListener("keydown",e=>{if(e.key==="Enter")go()});
A.append(el("div",{class:"card"},el("div",{class:"row"},pw,el("button",{onclick:go},"\u062F\u062E\u0648\u0644")),msg));`;
}
__name(loginJs, "loginJs");
function panelJs() {
  return `
const TY={ban_name:"\u062D\u0638\u0631 \u0644\u0627\u0639\u0628",ban_ip:"\u062D\u0638\u0631 IP",unban_name:"\u0641\u0643 \u062D\u0638\u0631 \u0644\u0627\u0639\u0628",unban_ip:"\u0641\u0643 \u062D\u0638\u0631 IP",skin_put:"\u0631\u0641\u0639/\u062A\u062D\u062F\u064A\u062B \u0633\u0643\u0646",skin_delete:"\u062D\u0630\u0641 \u0633\u0643\u0646",admin_delete_skin:"\u062D\u0630\u0641 \u0633\u0643\u0646 (\u0623\u062F\u0645\u0646)",blocked:"\u0645\u062D\u0627\u0648\u0644\u0629 \u0645\u062D\u0638\u0648\u0631\u0629",admin_login:"\u062F\u062E\u0648\u0644 \u0623\u062F\u0645\u0646",admin_login_failed:"\u062F\u062E\u0648\u0644 \u0641\u0627\u0634\u0644"};
const tabs=el("div",{class:"tabs"});const box=el("div");A.append(tabs,box);let cur="logs";
const draw=()=>{tabs.replaceChildren(...[["logs","\u0627\u0644\u0633\u062C\u0644"],["players","\u0627\u0644\u0644\u0627\u0639\u0628\u0648\u0646"],["bans","\u0627\u0644\u0645\u062D\u0638\u0648\u0631\u0648\u0646"]].map(([k,n])=>el("button",{class:cur===k?"on":"",onclick:()=>{cur=k;draw();show()}},n)))};
async function show(){box.replaceChildren(el("div",{class:"m"},"..."));({logs:logs,players:players,bans:bans})[cur]()}
async function logs(){const d=await call("logs");box.replaceChildren(el("div",{class:"row"},el("button",{class:"s",onclick:show},"\u062A\u062D\u062F\u064A\u062B"),el("button",{class:"s",onclick:async()=>{await fetch("/admin/logout",{method:"POST",headers:{"x-admin":"1"},credentials:"same-origin"});location.reload()}},"\u062E\u0631\u0648\u062C")),el("div",{class:"card"},...(d.logs||[]).map(l=>el("div",{class:"it"},el("div",{},el("span",{class:"tag"},TY[l.type]||l.type)," ",l.target||"",l.reason?" \u2014 "+l.reason:""),el("div",{class:"m"},when(l.t)+"  "+(l.ip||""))))))}
async function players(){const q=el("input",{placeholder:"\u0627\u0628\u062F\u0623 \u0628\u0627\u0633\u0645 \u0627\u0644\u0644\u0627\u0639\u0628"});const list=el("div",{class:"card"});const load=async()=>{const d=await call("players?q="+encodeURIComponent(q.value.trim()));list.replaceChildren(...(d.players||[]).map(p=>el("div",{class:"it"},el("div",{},p.name,el("div",{class:"m"},when(p.t)+"  IP: "+(p.ip||"\u2014"))),el("div",{class:"row"},el("button",{class:"d",onclick:async()=>{const r=prompt("\u0633\u0628\u0628 \u0627\u0644\u062D\u0638\u0631\u061F");if(r===null)return;const both=p.ip&&confirm("\u062A\u062D\u0638\u0631 \u0627\u0644\u0640 IP "+p.ip+" \u0643\u0645\u0627\u0646\u061F");await call("ban",{kind:"name",value:p.name,reason:r,alsoIp:!!both});load()}},"\u062D\u0638\u0631"),el("button",{class:"s",onclick:async()=>{if(confirm("\u062D\u0630\u0641 \u0627\u0644\u0633\u0643\u0646\u061F")){await call("delete-skin",{value:p.name});load()}}},"\u062D\u0630\u0641 \u0627\u0644\u0633\u0643\u0646")))))};q.addEventListener("input",()=>{clearTimeout(window._t);window._t=setTimeout(load,350)});box.replaceChildren(el("div",{class:"row"},q),list);load()}
async function bans(){const d=await call("bans");const v=el("input",{placeholder:"\u0627\u0633\u0645 \u0644\u0627\u0639\u0628 \u0623\u0648 IP"});const r=el("input",{placeholder:"\u0627\u0644\u0633\u0628\u0628"});const add=k=>async()=>{if(!v.value.trim())return;const x=await call("ban",{kind:k,value:v.value.trim(),reason:r.value});if(x.error)alert(x.error);else bans()};
box.replaceChildren(el("div",{class:"card"},el("div",{class:"row"},v,r),el("div",{class:"row"},el("button",{class:"d",onclick:add("name")},"\u062D\u0638\u0631 \u0644\u0627\u0639\u0628"),el("button",{class:"d",onclick:add("ip")},"\u062D\u0638\u0631 IP"))),el("div",{class:"card"},...(d.bans||[]).map(b=>el("div",{class:"it"},el("div",{},el("span",{class:"tag"},b.kind==="ip"?"IP":"\u0644\u0627\u0639\u0628")," ",b.value,el("div",{class:"m"},when(b.t)+(b.reason?"  "+b.reason:""))),el("button",{class:"s",onclick:async()=>{await call("unban",{kind:b.kind,value:b.value});bans()}},"\u0641\u0643")))))}
draw();show();`;
}
__name(panelJs, "panelJs");
async function admin(req, env, ctx, ip) {
  const url = new URL(req.url);
  if (!env.ADMIN_PASSWORD || String(env.ADMIN_PASSWORD).length < 12)
    return reply("not found", 404);
  const allow = (env.ADMIN_ALLOWED_IPS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allow.length && !allow.includes(ip))
    return reply("not found", 404);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/admin/login" && req.method === "POST") {
    if (req.headers.get("x-admin") !== "1")
      return reply("forbidden", 403);
    return login(req, env, ip);
  }
  const authed = await sessionOk(req, env);
  if (path === "/admin" && req.method === "GET")
    return page(crypto.randomUUID().replace(/-/g, ""), authed);
  if (!authed)
    return jsonReply({ error: "unauthorized" }, 401);
  if (req.headers.get("x-admin") !== "1")
    return reply("forbidden", 403);
  if (path === "/admin/logout" && req.method === "POST")
    return jsonReply({ ok: true }, 200, { "set-cookie": "bc_admin=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
  if (path.startsWith("/admin/api/"))
    return api(req, env, ctx, url, ip);
  return reply("not found", 404);
}
__name(admin, "admin");

// src/index.js
var NAME2 = /^[A-Za-z0-9_]{3,16}$/;
var MAX_BYTES = 24 * 1024;
var MIN_SECONDS_BETWEEN_WRITES = 10;
var CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "x-skin-token, x-skin-listed, content-type", "access-control-allow-methods": "GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS" };
var GALLERY_MAX = 40;
var GALLERY_ROUNDS = 6;
var text = /* @__PURE__ */ __name((body, status = 200, extra = {}) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...CORS, ...extra } }), "text");
var json = /* @__PURE__ */ __name((data, extra = {}) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra } }), "json");
async function gallery(url, env, ctx, req) {
  const cache = caches.default;
  const hit = await cache.match(req);
  if (hit)
    return hit;
  const q = (url.searchParams.get("q") || "").toLowerCase();
  if (q && !/^[a-z0-9_]{1,16}$/.test(q))
    return json({ skins: [], cursor: null });
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "24", 10) || 24, 1), GALLERY_MAX);
  const raw = url.searchParams.get("cursor") || "";
  let phase = raw.startsWith("s") ? "s" : "f";
  let cursor = raw.slice(1) || void 0;
  const skins = [];
  let finished = false;
  for (let round = 0; round < GALLERY_ROUNDS && !finished && skins.length < limit; round++) {
    const prefix = (phase === "f" ? "featured:" : "skin:") + q;
    const page2 = await env.SKINS.list({ prefix, cursor, limit });
    for (const k of page2.keys) {
      const meta = k.metadata || {};
      if (phase === "f")
        skins.push({ name: meta.name || k.name.slice(9), t: meta.t || 0, featured: true });
      else if (meta.listed)
        skins.push({ name: meta.name || k.name.slice(5), t: meta.t || 0, featured: false });
    }
    if (page2.list_complete) {
      if (phase === "f") {
        phase = "s";
        cursor = void 0;
      } else
        finished = true;
    } else {
      cursor = page2.cursor;
    }
  }
  const res = json({ skins, cursor: finished ? null : phase + (cursor || "") }, { "cache-control": "public, max-age=120" });
  ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}
__name(gallery, "gallery");
async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
function validSkin(buf) {
  if (buf.byteLength < 33 || buf.byteLength > MAX_BYTES)
    return false;
  const b = new Uint8Array(buf);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((v2, i) => b[i] === v2))
    return false;
  const v = new DataView(buf);
  return v.getUint32(16) === 64 && (v.getUint32(20) === 64 || v.getUint32(20) === 32);
}
__name(validSkin, "validSkin");
var src_default = {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const ip = req.headers.get("cf-connecting-ip") || "";
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))
      return admin(req, env, ctx, ip);
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS });
    if (ip && await env.SKINS.get("ban:ip:" + ip)) {
      if (!await env.SKINS.get("seen:" + ip)) {
        await env.SKINS.put("seen:" + ip, "1", { expirationTtl: 60 });
        ctx.waitUntil(logEvent(env, { type: "blocked", ip, target: "ip", reason: url.pathname.slice(0, 60) }));
      }
      return text("banned", 403);
    }
    if (url.pathname === "/")
      return text("BlockComet skin registry");
    const st = url.pathname.match(/^\/status\/([A-Za-z0-9_]{3,16})$/);
    if (st && req.method === "GET")
      return json({ banned: !!await env.SKINS.get("ban:name:" + st[1].toLowerCase()) }, { "cache-control": "no-store" });
    if (url.pathname === "/gallery")
      return req.method === "GET" ? gallery(url, env, ctx, req) : text("method not allowed", 405, { allow: "GET, OPTIONS" });
    const f = url.pathname.match(/^\/featured\/([A-Za-z0-9_]+?)(?:\.png)?$/);
    if (f && NAME2.test(f[1]) && (req.method === "GET" || req.method === "HEAD")) {
      const { value } = await env.SKINS.getWithMetadata("featured:" + f[1].toLowerCase(), { type: "arrayBuffer" });
      if (!value)
        return text("no skin", 404, { "cache-control": "public, max-age=60" });
      return new Response(req.method === "HEAD" ? null : value, { headers: { "content-type": "image/png", "cache-control": "public, max-age=3600", ...CORS } });
    }
    const m = url.pathname.match(/^\/skins\/([A-Za-z0-9_]+?)(?:\.png)?$/);
    if (!m || !NAME2.test(m[1]))
      return text("not found", 404);
    const key = "skin:" + m[1].toLowerCase();
    if (await env.SKINS.get("ban:name:" + m[1].toLowerCase())) {
      if (req.method !== "GET" && req.method !== "HEAD")
        ctx.waitUntil(logEvent(env, { type: "blocked", ip, target: m[1].toLowerCase(), reason: "banned name" }));
      return text(req.method === "GET" || req.method === "HEAD" ? "no skin" : "banned", req.method === "GET" || req.method === "HEAD" ? 404 : 403);
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const cache = caches.default;
      const hit = await cache.match(req);
      if (hit)
        return hit;
      const { value } = await env.SKINS.getWithMetadata(key, { type: "arrayBuffer" });
      if (!value)
        return text("no skin", 404, { "cache-control": "public, max-age=60" });
      const res = new Response(req.method === "HEAD" ? null : value, { headers: { "content-type": "image/png", "cache-control": "public, max-age=300", ...CORS } });
      if (req.method === "GET")
        ctx.waitUntil(cache.put(req, res.clone()));
      return res;
    }
    if (req.method === "PUT") {
      const token = req.headers.get("x-skin-token") || "";
      if (!/^[0-9a-f]{32,128}$/.test(token))
        return text("missing or bad X-Skin-Token", 401);
      const body = await req.arrayBuffer();
      if (!validSkin(body))
        return text("not a 64x64 (or 64x32) PNG skin under 24 KB", 400);
      const owner = await sha256Hex(token);
      if (await env.SKINS.get("ban:owner:" + owner)) {
        ctx.waitUntil(logEvent(env, { type: "blocked", ip, target: m[1].toLowerCase(), reason: "banned token" }));
        return text("banned", 403);
      }
      const { metadata } = await env.SKINS.getWithMetadata(key, { type: "arrayBuffer" });
      if (metadata && metadata.owner !== owner)
        return text("this name belongs to another token", 403);
      const now = Date.now();
      if (metadata && now - (metadata.t || 0) < MIN_SECONDS_BETWEEN_WRITES * 1e3)
        return text("too many updates, wait a moment", 429);
      const asked = req.headers.get("x-skin-listed");
      const listed = asked === null ? !!(metadata && metadata.listed) : asked === "1";
      await env.SKINS.put(key, body, { metadata: { owner, t: now, listed, name: m[1], ip } });
      ctx.waitUntil(logEvent(env, { type: "skin_put", ip, target: m[1].toLowerCase() }));
      ctx.waitUntil(caches.default.delete(new Request(url.origin + "/skins/" + m[1] + ".png")));
      return text("ok", 200);
    }
    if (req.method === "PATCH" || req.method === "POST") {
      const token = req.headers.get("x-skin-token") || "";
      if (!/^[0-9a-f]{32,128}$/.test(token))
        return text("missing or bad X-Skin-Token", 401);
      const asked = req.headers.get("x-skin-listed");
      if (asked !== "0" && asked !== "1")
        return text("X-Skin-Listed must be 0 or 1", 400);
      const { value, metadata } = await env.SKINS.getWithMetadata(key, { type: "arrayBuffer" });
      if (!value)
        return text("no skin", 404);
      if (!metadata || metadata.owner !== await sha256Hex(token))
        return text("this name belongs to another token", 403);
      await env.SKINS.put(key, value, { metadata: { ...metadata, listed: asked === "1", name: metadata.name || m[1] } });
      return text("ok", 200);
    }
    if (req.method === "DELETE") {
      const token = req.headers.get("x-skin-token") || "";
      if (!/^[0-9a-f]{32,128}$/.test(token))
        return text("missing or bad X-Skin-Token", 401);
      const { value, metadata } = await env.SKINS.getWithMetadata(key, { type: "arrayBuffer" });
      if (!value)
        return text("no skin", 404);
      if (!metadata || metadata.owner !== await sha256Hex(token))
        return text("this name belongs to another token", 403);
      await env.SKINS.delete(key);
      ctx.waitUntil(caches.default.delete(new Request(url.origin + "/skins/" + m[1] + ".png")));
      ctx.waitUntil(logEvent(env, { type: "skin_delete", ip, target: m[1].toLowerCase() }));
      return text("deleted", 200);
    }
    return text("method not allowed", 405, { allow: "GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS" });
  }
};
export {
  src_default as default
};
//# sourceMappingURL=index.js.map