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
    return jsonReply({ players: page.keys.map((k) => ({ name: (k.metadata || {}).name || k.name.slice(5), t: (k.metadata || {}).t || 0, listed: !!(k.metadata || {}).listed, ip: (k.metadata || {}).ip || "", f: (k.metadata || {}).f || (k.metadata || {}).t || 0, c: (k.metadata || {}).c || "", cy: (k.metadata || {}).cy || "", dv: (k.metadata || {}).dv || "", os: (k.metadata || {}).os || "" })) });
  }
  if (p === "player") {
    const n = (url.searchParams.get("name") || "").toLowerCase();
    if (!/^[a-z0-9_]{3,16}$/.test(n)) return jsonReply({ error: "bad name" }, 400);
    const l = await env.SKINS.list({ prefix: "skin:" + n, limit: 5 });
    const k = l.keys.find((x) => x.name === "skin:" + n);
    const m = (k && k.metadata) || null;
    let ban = null;
    try { const b = await env.SKINS.get("ban:name:" + n); if (b) ban = JSON.parse(b); } catch (e) { ban = {}; }
    let client = null, ipBanned = false, sameIp = [];
    if (m && m.ip) {
      const c = await env.SKINS.list({ prefix: "cl:" + m.ip, limit: 5 });
      const ck = c.keys.find((x) => x.name === "cl:" + m.ip);
      client = ck ? ck.metadata || {} : null;
      ipBanned = !!(await env.SKINS.get("ban:ip:" + m.ip));
      const all = await env.SKINS.list({ prefix: "skin:", limit: 1000 });
      sameIp = all.keys.filter((x) => x.metadata && x.metadata.ip === m.ip && x.name !== "skin:" + n).map((x) => x.metadata.name || x.name.slice(5)).slice(0, 20);
    }
    const lp = await env.SKINS.list({ prefix: "log:", limit: 100 });
    const events = [];
    for (const lk of lp.keys) {
      if (events.length >= 20) break;
      const v = await env.SKINS.get(lk.name);
      if (!v) continue;
      try { const e = JSON.parse(v); if (e.target === n || (m && m.ip && e.ip === m.ip)) events.push(e); } catch (e) { /* skip */ }
    }
    const skin = m ? { t: m.t || 0, f: m.f || m.t || 0, listed: !!m.listed, ip: m.ip || "", c: m.c || "", cy: m.cy || "", dv: m.dv || "", os: m.os || "" } : null;
    return jsonReply({ name: n, skin, ban, client, ipBanned, sameIp, events });
  }
  if (p === "clients") {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const page = await env.SKINS.list({ prefix: "cl:", limit: 1000 });
    let out = page.keys.map((k) => ({ ip: k.name.slice(3), ...(k.metadata || {}) }));
    if (q) out = out.filter((c) => (c.ip + " " + (c.nm || []).join(" ") + " " + (c.dv || "") + " " + (c.os || "") + " " + (c.c || "") + " " + (c.cy || "") + " " + (c.asn || "")).toLowerCase().includes(q));
    out.sort((a, b) => (b.l || 0) - (a.l || 0));
    const bl = await env.SKINS.list({ prefix: "ban:ip:", limit: 1000 });
    const bset = new Set(bl.keys.map((k) => k.name.slice(7)));
    return jsonReply({ clients: out.slice(0, 200).map((c) => ({ ...c, banned: bset.has(c.ip) })), total: page.keys.length });
  }
  if (p === "stats") {
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
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
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
.m{color:var(--mut);font-size:12px;direction:ltr;unicode-bidi:plaintext;word-break:break-all}.tag{font-size:11px;padding:2px 6px;border-radius:6px;background:#262b36}.bad{color:var(--bad)}.ok{color:var(--ok)}.v{direction:ltr;unicode-bidi:plaintext;word-break:break-all;text-align:left}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:12px}.grid .card{margin:0}.big{font-size:24px;font-weight:700;color:var(--ac)}.sk{image-rendering:pixelated;width:192px;height:192px;background:#0b0d11;border:1px solid var(--line);border-radius:8px}
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
const ago=t=>{if(!t)return "—";const s=Math.floor((Date.now()-t)/1000);if(s<60)return "قبل لحظات";if(s<3600)return "قبل "+Math.floor(s/60)+" دقيقة";if(s<86400)return "قبل "+Math.floor(s/3600)+" ساعة";return "قبل "+Math.floor(s/86400)+" يوم"};
const devOf=o=>[o.dv,o.os].filter(Boolean).join(" · ")||"غير معروف";
const locOf=o=>[o.cy,o.c].filter(Boolean).join(", ")||"—";
const tabs=el("div",{class:"tabs"});const box=el("div");A.append(tabs,box);let cur="stats";
const draw=()=>{tabs.replaceChildren(...[["stats","الإحصاءات"],["logs","السجل"],["players","اللاعبون"],["clients","الأجهزة"],["bans","المحظورون"]].map(([k,n])=>el("button",{class:cur===k?"on":"",onclick:()=>{cur=k;draw();show()}},n)))};
async function show(){box.replaceChildren(el("div",{class:"m"},"..."));({stats:stats,logs:logs,players:players,clients:clients,bans:bans})[cur]()}
const kv=(k,v)=>el("div",{class:"it"},el("span",{class:"m"},k),el("span",{class:"v"},v||"—"));
const stat=(n,v)=>el("div",{class:"card"},el("div",{class:"m"},n),el("div",{class:"big"},String(v)));
async function stats(){const d=await call("stats");box.replaceChildren(el("div",{class:"grid"},stat("اللاعبون (سكنات)",d.players),stat("ظاهرة في المعرض",d.listed),stat("الأجهزة (IP)",d.clients),stat("أجهزة جديدة خلال 24 ساعة",d.new24),stat("أجهزة جديدة خلال 7 أيام",d.new7),stat("نشطة خلال 24 ساعة",d.act24),stat("سكنات مرفوعة خلال 24 ساعة",d.uploads24),stat("محظورون (أسماء / IP)",d.bannedNames+" / "+d.bannedIps)),el("div",{class:"card"},el("div",{class:"m"},"أكثر الدول"),...(d.countries||[]).map(([c,n])=>kv(c,n))),el("div",{class:"card"},el("div",{class:"m"},"أكثر الأجهزة"),...(d.devices||[]).map(([c,n])=>kv(c,n))),el("div",{class:"m"},"الأرقام تحسب من سجل الأجهزة اللي اتصلت بالخدمة (آخر 120 يومًا)."))}
async function logs(){const d=await call("logs");box.replaceChildren(el("div",{class:"row"},el("button",{class:"s",onclick:show},"تحديث"),el("button",{class:"s",onclick:async()=>{await fetch("/admin/logout",{method:"POST",headers:{"x-admin":"1"},credentials:"same-origin"});location.reload()}},"خروج")),el("div",{class:"card"},...(d.logs||[]).map(l=>el("div",{class:"it"},el("div",{},el("span",{class:"tag"},TY[l.type]||l.type)," ",l.target||"",l.reason?" — "+l.reason:""),el("div",{class:"m"},when(l.t)+"  "+(l.ip||""))))))}
async function banName(name,ip){const r=prompt("سبب الحظر؟");if(r===null)return false;const both=ip&&confirm("تحظر الـ IP "+ip+" كمان؟");const x=await call("ban",{kind:"name",value:name,reason:r,alsoIp:!!both});if(x.error)alert(x.error);return true}
async function banIp(ip){const r=prompt("سبب حظر الـ IP؟");if(r===null)return false;const x=await call("ban",{kind:"ip",value:ip,reason:r});if(x.error)alert(x.error);return true}
async function detail(name){box.replaceChildren(el("div",{class:"m"},"..."));const d=await call("player?name="+encodeURIComponent(name));
if(d.error){box.replaceChildren(el("div",{class:"card"},d.error));return}
const s=d.skin,c=d.client||{};const back=el("button",{class:"s",onclick:()=>{cur="players";draw();show()}},"رجوع");
const acts=el("div",{class:"row"},back);
if(d.ban){acts.append(el("button",{class:"s",onclick:async()=>{await call("unban",{kind:"name",value:name});detail(name)}},"فك حظر اللاعب"))}
else{acts.append(el("button",{class:"d",onclick:async()=>{if(await banName(name,s&&s.ip))detail(name)}},"حظر اللاعب"))}
if(s&&s.ip){if(d.ipBanned)acts.append(el("button",{class:"s",onclick:async()=>{await call("unban",{kind:"ip",value:s.ip});detail(name)}},"فك حظر الـ IP"));else acts.append(el("button",{class:"d",onclick:async()=>{if(await banIp(s.ip))detail(name)}},"حظر الـ IP فقط"))}
if(s)acts.append(el("button",{class:"s",onclick:async()=>{if(confirm("حذف السكن؟")){await call("delete-skin",{value:name});detail(name)}}},"حذف السكن"));
const info=el("div",{class:"card"},kv("الاسم",name),kv("الحالة",d.ban?"محظور"+(d.ban.reason?" — "+d.ban.reason:"")+(d.ban.t?" ("+when(d.ban.t)+")":""):"نشط"));
if(s){info.append(kv("أول ظهور للسكن",when(s.f)+" ("+ago(s.f)+")"),kv("آخر تحديث للسكن",when(s.t)+" ("+ago(s.t)+")"),kv("ظاهر في المعرض",s.listed?"نعم":"لا"),kv("الـ IP",s.ip+(d.ipBanned?" (محظور)":"")),kv("الموقع التقريبي",locOf(c.c||c.cy?c:s)),kv("الجهاز",devOf(c.dv||c.os?c:s)))}
if(d.client){info.append(kv("مزود الإنترنت",c.asn),kv("أول اتصال من هذا الجهاز/الشبكة",when(c.f)+" ("+ago(c.f)+")"),kv("آخر اتصال",when(c.l)+" ("+ago(c.l)+")"),kv("User-Agent",c.ua))}
if((d.sameIp||[]).length)info.append(kv("أسماء أخرى من نفس الـ IP",d.sameIp.join(", ")));
const head=[acts];if(s){const img=el("img",{class:"sk",alt:""});img.setAttribute("src","/skins/"+name+".png");head.push(el("div",{class:"card"},img))}
const ev=el("div",{class:"card"},el("div",{class:"m"},"آخر الأحداث المرتبطة"),...(d.events||[]).map(l=>el("div",{class:"it"},el("div",{},el("span",{class:"tag"},TY[l.type]||l.type)," ",l.target||"",l.reason?" — "+l.reason:""),el("div",{class:"m"},when(l.t)+"  "+(l.ip||"")))));
box.replaceChildren(...head,info,ev)}
async function players(){const q=el("input",{placeholder:"ابدأ باسم اللاعب"});const list=el("div",{class:"card"});const load=async()=>{const d=await call("players?q="+encodeURIComponent(q.value.trim()));list.replaceChildren(...(d.players||[]).map(p=>el("div",{class:"it"},el("div",{},p.name,el("div",{class:"m"},"أول ظهور: "+when(p.f)+"  ·  IP: "+(p.ip||"—")),el("div",{class:"m"},devOf(p)+"  ·  "+locOf(p))),el("div",{class:"row"},el("button",{onclick:()=>detail(p.name)},"تفاصيل"),el("button",{class:"d",onclick:async()=>{if(await banName(p.name,p.ip))load()}},"حظر")))))};q.addEventListener("input",()=>{clearTimeout(window._t);window._t=setTimeout(load,350)});box.replaceChildren(el("div",{class:"row"},q),list);load()}
async function clients(){const q=el("input",{placeholder:"بحث: IP، اسم، جهاز، دولة، مدينة"});const list=el("div",{class:"card"});const note=el("div",{class:"m"},"أول ظهور = أول مرة اتصل فيها اللانشر بالخدمة من هذا الـ IP (قريب من وقت أول تشغيل، مو وقت التحميل الفعلي).");const load=async()=>{const d=await call("clients?q="+encodeURIComponent(q.value.trim()));list.replaceChildren(...(d.clients||[]).map(c=>el("div",{class:"it"},el("div",{},el("span",{class:"v"},c.ip),c.banned?el("span",{class:"tag bad"},"محظور"):"",el("div",{class:"m"},devOf(c)+"  ·  "+locOf(c)+(c.asn?"  ·  "+c.asn:"")),el("div",{class:"m"},"أول ظهور: "+when(c.f)+"  ·  آخر ظهور: "+ago(c.l)),(c.nm||[]).length?el("div",{class:"m"},"لاعبون: "+c.nm.join(", ")):""),el("div",{class:"row"},c.banned?el("button",{class:"s",onclick:async()=>{await call("unban",{kind:"ip",value:c.ip});load()}},"فك حظر"):el("button",{class:"d",onclick:async()=>{if(await banIp(c.ip))load()}},"حظر IP")))))};q.addEventListener("input",()=>{clearTimeout(window._t);window._t=setTimeout(load,350)});box.replaceChildren(el("div",{class:"row"},q),note,list);load()}
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
