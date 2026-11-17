// Developer-only admin panel for the BlockComet skin service. Lives at /admin on the same worker.
// Protection: secret password (ADMIN_PASSWORD), login rate limit per IP, signed HttpOnly session cookie,
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

async function sessionOk(req, env) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)bc_admin=([0-9]+)\.([0-9a-f]+)\.([0-9a-f]+)/);
  if (!m) return false;
  if (Number(m[1]) < Date.now()) return false;
  const want = await hmac("bc-session:" + env.ADMIN_PASSWORD, m[1] + "." + m[2]);
  return safeEq(want, m[3]);
}

async function login(req, env, ip) {
  const rl = "rl:" + (ip || "none");
  const fails = parseInt((await env.SKINS.get(rl)) || "0", 10);
  if (fails >= MAX_FAILS) return jsonReply({ error: "locked, try later" }, 429);
  let pw = "";
  try { pw = String((await req.json()).password || ""); } catch (e) { /* bad body */ }
  const ok = safeEq(await sha("bc-pw:" + pw), await sha("bc-pw:" + env.ADMIN_PASSWORD));
  if (!ok) {
    await env.SKINS.put(rl, String(fails + 1), { expirationTtl: LOCK_SECONDS });
    await logEvent(env, { type: "admin_login_failed", ip });
    await new Promise((r) => setTimeout(r, 600));
    return jsonReply({ error: "wrong password" }, 401);
  }
  await env.SKINS.delete(rl);
  const exp = Date.now() + SESSION_SECONDS * 1000;
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const sig = await hmac("bc-session:" + env.ADMIN_PASSWORD, exp + "." + nonce);
  await logEvent(env, { type: "admin_login", ip });
  return jsonReply({ ok: true }, 200, { "set-cookie": `bc_admin=${exp}.${nonce}.${sig}; Path=/admin; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict` });
}

const NAME = /^[A-Za-z0-9_]{3,16}$/;
const IPV = /^[0-9a-fA-F:.]{3,45}$/;

async function api(req, env, ctx, url, ip) {
  const p = url.pathname.slice("/admin/api/".length);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  if (p === "logs") {
    const page = await env.SKINS.list({ prefix: "log:", limit: 150 });
    const out = [];
    for (const k of page.keys) { const v = await env.SKINS.get(k.name); if (v) { try { out.push(JSON.parse(v)); } catch (e) { /* skip */ } } }
    return jsonReply({ logs: out });
  }
  if (p === "players") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    if (q && !/^[a-z0-9_]{1,16}$/.test(q)) return jsonReply({ players: [] });
    const page = await env.SKINS.list({ prefix: "skin:" + q, limit: 200 });
    return jsonReply({ players: page.keys.map((k) => ({ name: (k.metadata || {}).name || k.name.slice(5), t: (k.metadata || {}).t || 0, listed: !!(k.metadata || {}).listed, ip: (k.metadata || {}).ip || "" })) });
  }
  if (p === "bans") {
    const page = await env.SKINS.list({ prefix: "ban:", limit: 500 });
    const out = [];
    for (const k of page.keys) {
      const [, kind, ...rest] = k.name.split(":");
      if (kind === "owner") continue; // internal: the token behind a banned name
      let v = {}; try { v = JSON.parse((await env.SKINS.get(k.name)) || "{}"); } catch (e) { /* skip */ }
      out.push({ kind, value: rest.join(":"), reason: v.reason || "", t: v.t || 0 });
    }
    return jsonReply({ bans: out });
  }
  if (p === "ban" && req.method === "POST") {
    const kind = body.kind, reason = String(body.reason || "").slice(0, 200), now = Date.now();
    if (kind === "ip") {
      const v = String(body.value || "").trim();
      if (!IPV.test(v)) return jsonReply({ error: "bad ip" }, 400);
      await env.SKINS.put("ban:ip:" + v, JSON.stringify({ reason, t: now }));
      await logEvent(env, { type: "ban_ip", ip, target: v, reason });
      return jsonReply({ ok: true });
    }
    if (kind === "name") {
      const v = String(body.value || "").trim();
      if (!NAME.test(v)) return jsonReply({ error: "bad name" }, 400);
      const low = v.toLowerCase();
      const { metadata } = await env.SKINS.getWithMetadata("skin:" + low, { type: "arrayBuffer" });
      await env.SKINS.put("ban:name:" + low, JSON.stringify({ reason, t: now }));
      if (metadata && metadata.owner) await env.SKINS.put("ban:owner:" + metadata.owner, JSON.stringify({ reason, t: now, name: low }));
      await env.SKINS.delete("skin:" + low);
      ctx.waitUntil(caches.default.delete(new Request(url.origin + "/skins/" + v + ".png")));
      let ipBanned = "";
      if (body.alsoIp && metadata && metadata.ip) { await env.SKINS.put("ban:ip:" + metadata.ip, JSON.stringify({ reason: "with " + low + (reason ? ": " + reason : ""), t: now })); ipBanned = metadata.ip; }
      await logEvent(env, { type: "ban_name", ip, target: low, reason, ipBanned });
      return jsonReply({ ok: true, ipBanned });
    }
    return jsonReply({ error: "bad kind" }, 400);
  }
  if (p === "unban" && req.method === "POST") {
    const kind = body.kind, v = String(body.value || "").trim();
    if (kind === "ip" && IPV.test(v)) { await env.SKINS.delete("ban:ip:" + v); }
    else if (kind === "name" && NAME.test(v)) {
      const low = v.toLowerCase();
      const raw = await env.SKINS.list({ prefix: "ban:owner:", limit: 1000 });
      for (const k of raw.keys) { try { const o = JSON.parse((await env.SKINS.get(k.name)) || "{}"); if (o.name === low) await env.SKINS.delete(k.name); } catch (e) { /* skip */ } }
      await env.SKINS.delete("ban:name:" + low);
    } else return jsonReply({ error: "bad request" }, 400);
    await logEvent(env, { type: "unban_" + kind, ip, target: v });
    return jsonReply({ ok: true });
  }
  if (p === "delete-skin" && req.method === "POST") {
    const v = String(body.value || "").trim();
    if (!NAME.test(v)) return jsonReply({ error: "bad name" }, 400);
    await env.SKINS.delete("skin:" + v.toLowerCase());
    ctx.waitUntil(caches.default.delete(new Request(url.origin + "/skins/" + v + ".png")));
    await logEvent(env, { type: "admin_delete_skin", ip, target: v.toLowerCase() });
    return jsonReply({ ok: true });
  }
  return jsonReply({ error: "not found" }, 404);
}

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
</style></head><body><h1>BlockComet — لوحة المطورين</h1><div id="app"></div>
<script nonce="${nonce}">
const A=document.getElementById("app");
const el=(t,a={},...k)=>{const e=document.createElement(t);for(const[x,v]of Object.entries(a)){if(x==="onclick")e.onclick=v;else if(x==="class")e.className=v;else e.setAttribute(x,v)}for(const c of k)e.append(c);return e};
const call=async(p,b)=>{const r=await fetch("/admin/api/"+p,{method:b?"POST":"GET",headers:{"x-admin":"1","content-type":"application/json"},body:b?JSON.stringify(b):undefined,credentials:"same-origin"});if(r.status===401){location.reload();return{}}return r.json()};
const when=t=>t?new Date(t).toLocaleString("ar-EG"):"";
${authed ? panelJs() : loginJs()}
</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, ...SEC } });
}

function loginJs() {
  return `
const pw=el("input",{type:"password",placeholder:"كلمة السر",autocomplete:"current-password"});const msg=el("div",{class:"m"});
const go=async()=>{const r=await fetch("/admin/login",{method:"POST",headers:{"x-admin":"1","content-type":"application/json"},body:JSON.stringify({password:pw.value}),credentials:"same-origin"});const d=await r.json().catch(()=>({}));if(d.ok)location.reload();else msg.textContent=d.error||"error"};
pw.addEventListener("keydown",e=>{if(e.key==="Enter")go()});
A.append(el("div",{class:"card"},el("div",{class:"row"},pw,el("button",{onclick:go},"دخول")),msg));`;
}

function panelJs() {
  return `
const TY={ban_name:"حظر لاعب",ban_ip:"حظر IP",unban_name:"فك حظر لاعب",unban_ip:"فك حظر IP",skin_put:"رفع/تحديث سكن",skin_delete:"حذف سكن",admin_delete_skin:"حذف سكن (أدمن)",blocked:"محاولة محظورة",admin_login:"دخول أدمن",admin_login_failed:"دخول فاشل"};
const tabs=el("div",{class:"tabs"});const box=el("div");A.append(tabs,box);let cur="logs";
const draw=()=>{tabs.replaceChildren(...[["logs","السجل"],["players","اللاعبون"],["bans","المحظورون"]].map(([k,n])=>el("button",{class:cur===k?"on":"",onclick:()=>{cur=k;draw();show()}},n)))};
async function show(){box.replaceChildren(el("div",{class:"m"},"..."));({logs:logs,players:players,bans:bans})[cur]()}
async function logs(){const d=await call("logs");box.replaceChildren(el("div",{class:"row"},el("button",{class:"s",onclick:show},"تحديث"),el("button",{class:"s",onclick:async()=>{await fetch("/admin/logout",{method:"POST",headers:{"x-admin":"1"},credentials:"same-origin"});location.reload()}},"خروج")),el("div",{class:"card"},...(d.logs||[]).map(l=>el("div",{class:"it"},el("div",{},el("span",{class:"tag"},TY[l.type]||l.type)," ",l.target||"",l.reason?" — "+l.reason:""),el("div",{class:"m"},when(l.t)+"  "+(l.ip||""))))))}
async function players(){const q=el("input",{placeholder:"ابدأ باسم اللاعب"});const list=el("div",{class:"card"});const load=async()=>{const d=await call("players?q="+encodeURIComponent(q.value.trim()));list.replaceChildren(...(d.players||[]).map(p=>el("div",{class:"it"},el("div",{},p.name,el("div",{class:"m"},when(p.t)+"  IP: "+(p.ip||"—"))),el("div",{class:"row"},el("button",{class:"d",onclick:async()=>{const r=prompt("سبب الحظر؟");if(r===null)return;const both=p.ip&&confirm("تحظر الـ IP "+p.ip+" كمان؟");await call("ban",{kind:"name",value:p.name,reason:r,alsoIp:!!both});load()}},"حظر"),el("button",{class:"s",onclick:async()=>{if(confirm("حذف السكن؟")){await call("delete-skin",{value:p.name});load()}}},"حذف السكن")))))};q.addEventListener("input",()=>{clearTimeout(window._t);window._t=setTimeout(load,350)});box.replaceChildren(el("div",{class:"row"},q),list);load()}
async function bans(){const d=await call("bans");const v=el("input",{placeholder:"اسم لاعب أو IP"});const r=el("input",{placeholder:"السبب"});const add=k=>async()=>{if(!v.value.trim())return;const x=await call("ban",{kind:k,value:v.value.trim(),reason:r.value});if(x.error)alert(x.error);else bans()};
box.replaceChildren(el("div",{class:"card"},el("div",{class:"row"},v,r),el("div",{class:"row"},el("button",{class:"d",onclick:add("name")},"حظر لاعب"),el("button",{class:"d",onclick:add("ip")},"حظر IP"))),el("div",{class:"card"},...(d.bans||[]).map(b=>el("div",{class:"it"},el("div",{},el("span",{class:"tag"},b.kind==="ip"?"IP":"لاعب")," ",b.value,el("div",{class:"m"},when(b.t)+(b.reason?"  "+b.reason:""))),el("button",{class:"s",onclick:async()=>{await call("unban",{kind:b.kind,value:b.value});bans()}},"فك")))))}
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
  const authed = await sessionOk(req, env);
  if (path === "/admin" && req.method === "GET") return page(crypto.randomUUID().replace(/-/g, ""), authed);
  if (!authed) return jsonReply({ error: "unauthorized" }, 401);
  if (req.headers.get("x-admin") !== "1") return reply("forbidden", 403);
  if (path === "/admin/logout" && req.method === "POST") return jsonReply({ ok: true }, 200, { "set-cookie": "bc_admin=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
  if (path.startsWith("/admin/api/")) return api(req, env, ctx, url, ip);
  return reply("not found", 404);
}
