import { BASE_CSS } from "./style.js";
import { logEvent } from "./admin.js";

// ---- problem reports: a public form (/report) and the staff-side API used by the "البلاغات" tab of the developer panel ----
const CATS = ["crash", "game", "perf", "login", "skins", "mods", "ui", "suggest", "other"];
const STATUSES = ["new", "review", "done", "rejected"];
const PER_DAY = 2;                         // reports per person (IP) per rolling 24 hours
const DAY_MS = 86400000;
const MAX_IMG = 1500000;                   // bytes, after the browser shrank the picture
const REPORT_TTL = 90 * 86400, IMG_TTL = 45 * 86400;
const ID_RE = /^[0-9]{13}-[0-9a-f]{8}$/;

const SEC = {
  "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "x-frame-options": "DENY",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "strict-transport-security": "max-age=31536000",
};
const json = (d, status = 200, extra = {}) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json; charset=utf-8", ...SEC, ...extra } });

// IPv6 users are counted per /64 so rotating the last bits does not bypass the limit
function personKey(ip) {
  if (!ip.includes(":")) return ip;
  const [h, t] = ip.split("::");
  const head = h ? h.split(":") : [], tail = t !== undefined && t ? t.split(":") : [];
  const full = t === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
  return full.slice(0, 4).join(":");
}

function sniff(b) {
  const u = new Uint8Array(b.slice(0, 12));
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return "image/png";
  if (u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return "image/jpeg";
  if (u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 && u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50) return "image/webp";
  return "";
}

async function quota(env, ip) {
  const v = await env.SKINS.get("rr:" + personKey(ip));
  let n = 0, reset = 0;
  if (v) { try { const o = JSON.parse(v); if (o.reset > Date.now()) { n = o.n; reset = o.reset; } } catch (e) { /* ignore */ } }
  return { used: n, left: Math.max(0, PER_DAY - n), reset };
}

// ================= public side =================
export async function reportPublic(req, env, url, ip) {
  const p = url.pathname;
  if (p === "/report" && req.method === "GET") return reportPage();
  if (p === "/report/api/quota" && req.method === "GET") {
    if (!ip) return json({ left: PER_DAY, max: PER_DAY });
    const q = await quota(env, ip);
    return json({ left: q.left, max: PER_DAY, reset: q.reset });
  }
  if (p === "/report/api/submit" && req.method === "POST") return submit(req, env, url, ip);
  return null;
}

async function submit(req, env, url, ip) {
  if (!ip) return json({ error: "تعذر تحديد جهازك" }, 400);
  if (req.headers.get("origin") !== url.origin) return json({ error: "forbidden" }, 403);
  if (Number(req.headers.get("content-length") || 0) > 2500000) return json({ error: "الصورة كبيرة" }, 413);
  let f;
  try { f = await req.formData(); } catch (e) { return json({ error: "طلب غير صالح" }, 400); }
  if (String(f.get("website") || "")) return json({ ok: true, id: "000000", left: PER_DAY }); // honeypot: bots get a fake success
  const cat = String(f.get("cat") || ""), text = String(f.get("text") || "").trim(), contact = String(f.get("contact") || "").trim().slice(0, 60);
  if (!CATS.includes(cat)) return json({ error: "اختر القسم" }, 400);
  if (text.length < 10) return json({ error: "اكتب وصفًا للمشكلة (10 أحرف على الأقل)" }, 400);
  if (text.length > 1000) return json({ error: "الوصف طويل (الحد 1000 حرف)" }, 400);
  let img = null, ctype = "";
  const file = f.get("img");
  if (file && typeof file === "object" && file.size > 0) {
    if (file.size > MAX_IMG) return json({ error: "الصورة كبيرة (الحد 1.5 ميغابايت)" }, 413);
    img = await file.arrayBuffer();
    ctype = sniff(img);
    if (!ctype) return json({ error: "الصورة لازم تكون PNG أو JPG أو WebP" }, 400);
  }
  const now = Date.now();
  // per-person limit: PER_DAY reports in any 24 hours
  const q = await quota(env, ip);
  if (q.left <= 0) return json({ error: "وصلت الحد اليومي (" + PER_DAY + " بلاغات). جرّب بعد " + Math.max(1, Math.ceil((q.reset - now) / 3600000)) + " ساعة.", left: 0, reset: q.reset }, 429);
  // global safety valve so nobody can use up the free KV write quota with many IPs
  const day = new Date(now).toISOString().slice(0, 10), gk = "rg:" + day, cap = parseInt(env.REPORT_DAILY_CAP || "100", 10);
  const g = parseInt((await env.SKINS.get(gk)) || "0", 10);
  if (g >= cap) return json({ error: "البلاغات كثيرة اليوم، جرّب بكرة" }, 429);
  const reset = q.reset || now + DAY_MS;
  await env.SKINS.put("rr:" + personKey(ip), JSON.stringify({ n: q.used + 1, reset }), { expiration: Math.ceil(reset / 1000) + 60 });
  await env.SKINS.put(gk, String(g + 1), { expirationTtl: 2 * 86400 });
  const id = String(9999999999999 - now).padStart(13, "0") + "-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  if (img) await env.SKINS.put("rimg:" + id, img, { expirationTtl: IMG_TTL, metadata: { ct: ctype } });
  const rec = { id, t: now, cat, text, contact, st: "new", img: !!img, ip };
  await env.SKINS.put("rep:" + id, JSON.stringify(rec), { expirationTtl: REPORT_TTL, metadata: { c: cat, s: "new", t: now, i: !!img, x: text.slice(0, 90) } });
  return json({ ok: true, id: id.slice(-6).toUpperCase(), left: PER_DAY - (q.used + 1) });
}

// ================= staff side (called from the admin API) =================
export async function reportAdmin(p, env, url, ip, sess, can, body, actor, no) {
  if (p === "reports") {
    const page = await env.SKINS.list({ prefix: "rep:", limit: 300 });
    return json({ reports: page.keys.map((k) => { const m = k.metadata || {}; return { id: k.name.slice(4), c: m.c || "other", s: m.s || "new", t: m.t || 0, i: !!m.i, x: m.x || "" }; }) });
  }
  if (p === "report") {
    const id = url.searchParams.get("id") || "";
    if (!ID_RE.test(id)) return json({ error: "bad id" }, 400);
    const v = await env.SKINS.get("rep:" + id);
    if (!v) return json({ error: "غير موجود (أو انتهت مدته)" }, 404);
    const r = JSON.parse(v);
    const out = { id: r.id, cat: r.cat, text: r.text, contact: r.contact || "", t: r.t, st: r.st, img: !!r.img };
    // the sender's IP is never shown here, to anyone; it is kept only so "حظر المرسل" can block it server-side
    return json({ report: out });
  }
  if (p === "report-img") {
    const id = url.searchParams.get("id") || "";
    if (!ID_RE.test(id)) return new Response("bad id", { status: 400 });
    const { value, metadata } = await env.SKINS.getWithMetadata("rimg:" + id, { type: "arrayBuffer" });
    if (!value) return new Response("not found", { status: 404 });
    return new Response(value, { headers: { "content-type": (metadata && metadata.ct) || "image/jpeg", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } });
  }
  if (p === "report-status") {
    const id = String(body.id || ""), st = String(body.status || "");
    if (!ID_RE.test(id) || !STATUSES.includes(st)) return json({ error: "bad request" }, 400);
    const v = await env.SKINS.get("rep:" + id);
    if (!v) return json({ error: "غير موجود" }, 404);
    const r = JSON.parse(v); r.st = st;
    await env.SKINS.put("rep:" + id, JSON.stringify(r), { expiration: Math.floor(r.t / 1000) + REPORT_TTL, metadata: { c: r.cat, s: st, t: r.t, i: !!r.img, x: r.text.slice(0, 90) } });
    await logEvent(env, { type: "report_status", ip, target: id.slice(-6), reason: st, by: actor });
    return json({ ok: true });
  }
  if (p === "report-delete") {
    if (!can("delete")) return no();
    const id = String(body.id || "");
    if (!ID_RE.test(id)) return json({ error: "bad request" }, 400);
    await env.SKINS.delete("rep:" + id); await env.SKINS.delete("rimg:" + id);
    await logEvent(env, { type: "report_delete", ip, target: id.slice(-6), by: actor });
    return json({ ok: true });
  }
  if (p === "report-ban") { // block the sender of a report without ever showing the IP
    if (!can("banip")) return no();
    const id = String(body.id || "");
    if (!ID_RE.test(id)) return json({ error: "bad request" }, 400);
    const v = await env.SKINS.get("rep:" + id);
    if (!v) return json({ error: "غير موجود" }, 404);
    const r = JSON.parse(v);
    if (!r.ip) return json({ error: "ما في IP محفوظ" }, 404);
    if (r.ip === ip) return json({ error: "هذا الـ IP حقك أنت" }, 400);
    await env.SKINS.put("ban:ip:" + r.ip, JSON.stringify({ reason: "report " + id.slice(-6), t: Date.now() }));
    await logEvent(env, { type: "ban_ip", ip, target: "(مخفي)", reason: "report " + id.slice(-6), by: actor });
    return json({ ok: true });
  }
  return null;
}

// ================= the public page =================
const CAT_LABELS = [["crash", "اللانشر ما يفتح"], ["game", "اللعبة تعلق أو تكرش"], ["perf", "لاق / أداء ضعيف"], ["login", "الحساب وتسجيل الدخول"], ["skins", "السكنات"], ["mods", "المودات / Meteor"], ["ui", "الواجهة والترجمة"], ["suggest", "اقتراح"], ["other", "أخرى"]];

function reportPage() {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  const logo = '<svg class="logo" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#5ee7ff"/></linearGradient></defs><path d="M3 41 24 20" stroke="url(#lg)" stroke-width="3.5" stroke-linecap="round" opacity=".35"/><path d="M2 31 17 16" stroke="url(#lg)" stroke-width="3" stroke-linecap="round" opacity=".6"/><path d="M12 43 28 27" stroke="url(#lg)" stroke-width="3" stroke-linecap="round" opacity=".6"/><rect x="22" y="6" width="19" height="19" rx="5" transform="rotate(45 31.5 15.5)" fill="url(#lg)"/><rect x="28" y="12" width="7" height="7" rx="2" transform="rotate(45 31.5 15.5)" fill="#07060f" opacity=".35"/></svg>';
  const extra = ".cats{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 14px}.pill{background:rgba(255,255,255,.06);color:var(--ink);border:1px solid var(--line);box-shadow:none;min-height:40px;padding:8px 14px;border-radius:999px;font-weight:600}.pill.on{background:linear-gradient(135deg,rgba(94,231,255,.95),rgba(139,92,246,.98));color:#0b0820;border-color:transparent;box-shadow:0 0 22px -6px rgba(94,231,255,.7)}.hp{position:absolute;opacity:0;height:0;width:0;overflow:hidden;pointer-events:none}.lbl{font-weight:700;margin:10px 0 2px}.cnt{text-align:left;direction:ltr;unicode-bidi:isolate}.thumb{position:relative;display:inline-block;margin-top:10px}.thumb img{max-width:100%;max-height:220px;border-radius:14px;border:1px solid var(--line);display:block}.thumb button{position:absolute;top:6px;inset-inline-start:6px;min-height:32px;padding:2px 10px}.ok-card{text-align:center}.ok-card .big{font-size:34px}.err{color:var(--bad);margin-top:8px}.quota{display:inline-block;margin:6px 0 2px}";
  const js = `
const A=document.getElementById("app");
const el=(t,a,...k)=>{const e=document.createElement(t);for(const x in a||{}){if(x.startsWith("on"))e[x]=a[x];else e.setAttribute(x,a[x])}for(const c of k)e.append(c);return e};
const CATS=${JSON.stringify(CAT_LABELS)};
let cat="",blob=null,url="",busy=false;
const quota=el("span",{class:"tag quota"},"...");
const msg=el("div",{class:"err"},"");
const pills=el("div",{class:"cats"});
const drawPills=()=>pills.replaceChildren(...CATS.map(([k,n])=>el("button",{type:"button",class:"pill"+(cat===k?" on":""),onclick:()=>{cat=k;drawPills()}},n)));
const ta=el("textarea",{placeholder:"اشرح المشكلة: وش صار؟ متى؟ على أي جهاز وإصدار؟",maxlength:"1000"});
const cnt=el("div",{class:"m cnt"},"0 / 1000");ta.addEventListener("input",()=>{cnt.textContent=ta.value.length+" / 1000"});
const contact=el("input",{placeholder:"اسمك أو حسابك للتواصل (اختياري)",maxlength:"60"});
const hp=el("input",{class:"hp",tabindex:"-1",autocomplete:"off","aria-hidden":"true",name:"website"});
const file=el("input",{type:"file",accept:"image/png,image/jpeg,image/webp",class:"hp"});
const prev=el("div",{});
async function shrink(f){const u=URL.createObjectURL(f);const im=await new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=no;i.src=u});const s=Math.min(1,1600/Math.max(im.width,im.height));const c=document.createElement("canvas");c.width=Math.max(1,Math.round(im.width*s));c.height=Math.max(1,Math.round(im.height*s));const x=c.getContext("2d");x.fillStyle="#fff";x.fillRect(0,0,c.width,c.height);x.drawImage(im,0,0,c.width,c.height);URL.revokeObjectURL(u);
for(const q of [0.82,0.65,0.5]){const b=await new Promise(ok=>c.toBlob(ok,"image/jpeg",q));if(b&&b.size<=1400000)return b}throw new Error("big")}
file.addEventListener("change",async()=>{msg.textContent="";const f=file.files[0];if(!f)return;if(!/^image\\/(png|jpeg|webp)$/.test(f.type)){msg.textContent="الصورة لازم تكون PNG أو JPG أو WebP";file.value="";return}
try{blob=await shrink(f)}catch(e){msg.textContent="تعذر تجهيز الصورة";file.value="";return}
if(url)URL.revokeObjectURL(url);url=URL.createObjectURL(blob);const im=el("img",{alt:""});im.setAttribute("src",url);prev.replaceChildren(el("div",{class:"thumb"},im,el("button",{type:"button",class:"s",onclick:()=>{blob=null;file.value="";prev.replaceChildren()}},"حذف")))});
const send=el("button",{type:"button",onclick:submit},"إرسال البلاغ");
async function refreshQuota(){try{const r=await fetch("/report/api/quota");const d=await r.json();quota.textContent="المتبقي لك اليوم: "+d.left+" من "+d.max;send.disabled=d.left<=0}catch(e){quota.textContent=""}}
async function submit(){if(busy)return;msg.textContent="";if(!cat){msg.textContent="اختر القسم أولًا";return}if(ta.value.trim().length<10){msg.textContent="اكتب وصفًا للمشكلة (10 أحرف على الأقل)";return}
busy=true;send.disabled=true;send.textContent="جاري الإرسال...";
const f=new FormData();f.append("cat",cat);f.append("text",ta.value.trim());f.append("contact",contact.value.trim());f.append("website",hp.value);if(blob)f.append("img",blob,"shot.jpg");
try{const r=await fetch("/report/api/submit",{method:"POST",body:f});const d=await r.json();
if(d.ok){A.replaceChildren(el("div",{class:"card ok-card"},el("div",{class:"big"},"وصل بلاغك ✅"),el("div",{class:"m"},"رقم البلاغ: "+d.id),el("div",{class:"m"},"المتبقي لك اليوم: "+d.left),el("div",{class:"row"},el("button",{class:"s",onclick:()=>location.reload()},"بلاغ جديد"))));return}
msg.textContent=d.error||"تعذر الإرسال"}catch(e){msg.textContent="تعذر الاتصال، جرّب مرة ثانية"}
busy=false;send.textContent="إرسال البلاغ";refreshQuota()}
A.append(el("div",{class:"card"},el("div",{class:"lbl"},"القسم"),pills,el("div",{class:"lbl"},"وصف المشكلة"),ta,cnt,el("div",{class:"lbl"},"صورة (اختياري)"),el("div",{class:"row"},el("button",{type:"button",class:"s",onclick:()=>file.click()},"📎 إرفاق صورة")),prev,file,el("div",{class:"lbl"},"للتواصل"),contact,hp,msg,el("div",{class:"row"},send),quota));
drawPills();refreshQuota();`;
  const html = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><meta name="theme-color" content="#07060f"><title>بلاغ عن مشكلة — BlockComet</title><style nonce="' + nonce + '">' + BASE_CSS + extra + '</style></head><body class="in"><header class="top">' + logo + '<div class="ttl"><h1>BlockComet</h1><span>بلّغ عن مشكلة في اللانشر</span></div></header><div id="app"></div><script nonce="' + nonce + '">' + js + '</script></body></html>';
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, ...SEC } });
}
