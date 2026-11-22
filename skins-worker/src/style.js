// Shared look of the developer panel and the public report page.
export const BASE_CSS = `:root{--void:#07060f;--ink:#ecebff;--mut:#9a98c0;--glass:rgba(22,18,48,.62);--line:rgba(160,150,255,.17);--vio:#8b5cf6;--cy:#5ee7ff;--pink:#ff4fa3;--ok:#3dffb2;--bad:#ff5a7a;--r:18px;color-scheme:dark}
*{box-sizing:border-box;scrollbar-color:#3a3470 transparent}
html{background:var(--void)}
body{margin:0;min-height:100vh;color:var(--ink);font:15px/1.55 "SF Arabic","Segoe UI","Noto Sans Arabic",Tahoma,system-ui,sans-serif;padding:max(12px,env(safe-area-inset-top)) 14px 32px;position:relative;overflow-x:hidden}
body::before{content:"";position:fixed;inset:-20%;z-index:-2;background:radial-gradient(40% 35% at 15% 10%,rgba(139,92,246,.5),transparent 70%),radial-gradient(35% 30% at 90% 22%,rgba(94,231,255,.26),transparent 70%),radial-gradient(45% 40% at 70% 95%,rgba(255,79,163,.22),transparent 70%),linear-gradient(180deg,#0c0922,#07060f 62%);animation:drift 40s ease-in-out infinite alternate}
body::after{content:"";position:fixed;inset:0;z-index:-1;opacity:.55;pointer-events:none;background-image:radial-gradient(1px 1px at 20px 30px,#fff,transparent),radial-gradient(1px 1px at 120px 80px,#cfeeff,transparent),radial-gradient(1.6px 1.6px at 200px 160px,#fff,transparent),radial-gradient(1px 1px at 60px 190px,#e0d4ff,transparent),radial-gradient(1px 1px at 170px 20px,#fff,transparent);background-size:240px 240px}
@keyframes drift{to{transform:translate3d(-4%,3%,0) scale(1.08)}}
::selection{background:rgba(139,92,246,.55)}
.top{max-width:920px;margin:0 auto 14px;display:flex;align-items:center;gap:12px;padding:12px 16px;border:1px solid var(--line);border-radius:var(--r);background:var(--glass);backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);position:relative;overflow:hidden}
.top::after{content:"";position:absolute;top:0;left:-45%;width:40%;height:2px;background:linear-gradient(90deg,transparent,var(--cy),#fff,transparent);animation:streak 1.8s cubic-bezier(.2,.7,.2,1) .4s 1 both}
@keyframes streak{to{left:110%}}
.logo{width:42px;height:42px;flex:none;filter:drop-shadow(0 0 10px rgba(94,231,255,.5))}
.ttl h1{margin:0;font-size:20px;font-weight:800;line-height:1.2}
.ttl span{color:var(--mut);font-size:13px}
.live{margin-inline-start:auto;width:10px;height:10px;border-radius:50%;background:#4b4875;flex:none}
.live.on{background:var(--ok);animation:pulse 2.4s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(61,255,178,.55)}70%,100%{box-shadow:0 0 0 9px rgba(61,255,178,0)}}
#app{max-width:920px;margin:0 auto}
.card{position:relative;background:var(--glass);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px;margin-bottom:12px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 14px 34px -16px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.05)}
input,textarea,select{font:inherit;color:var(--ink);background:rgba(8,6,24,.62);border:1px solid var(--line);border-radius:12px;padding:10px 13px;min-height:44px;outline:none;transition:border-color .15s,box-shadow .15s}
input::placeholder,textarea::placeholder{color:#7471a0}
input:focus-visible,textarea:focus-visible,select:focus-visible{border-color:var(--cy);box-shadow:0 0 0 3px rgba(94,231,255,.18)}
input[type=checkbox]{flex:none;width:22px;height:22px;min-height:0;padding:0;accent-color:var(--vio)}
button{font:inherit;font-weight:700;color:#0b0820;border:0;border-radius:12px;padding:10px 16px;min-height:44px;cursor:pointer;background:linear-gradient(135deg,var(--cy),var(--vio));box-shadow:0 8px 20px -8px rgba(139,92,246,.75);transition:transform .12s,filter .15s}
button:hover{filter:brightness(1.12)}
button:active{transform:translateY(1px) scale(.98)}
button:focus-visible{outline:2px solid #fff;outline-offset:2px}
button.s{background:rgba(255,255,255,.07);color:var(--ink);border:1px solid var(--line);box-shadow:none}
button.d{background:rgba(255,90,122,.14);color:#ffa3b6;border:1px solid rgba(255,90,122,.45);box-shadow:none}button.d:hover{background:linear-gradient(135deg,var(--pink),var(--bad));color:#fff;filter:none}
.it .row{margin:0}.it .row button{min-height:38px;padding:6px 13px;font-size:13.5px}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}.row:last-child{margin-bottom:0}.row>input{flex:1;min-width:130px}
.tabs{display:flex;gap:4px;overflow-x:auto;padding:5px;margin-bottom:14px;border:1px solid var(--line);border-radius:999px;background:var(--glass);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs button{flex:0 0 auto;min-height:40px;padding:8px 17px;border-radius:999px;background:transparent;color:var(--mut);box-shadow:none;border:0;white-space:nowrap}
.tabs button.on{background:linear-gradient(135deg,rgba(94,231,255,.95),rgba(139,92,246,.98));color:#0b0820;box-shadow:0 0 24px -4px rgba(94,231,255,.7)}
.tabs button.s{margin-inline-start:auto}
.it{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:12px 0;border-bottom:1px solid var(--line)}.it:last-child{border:0}
label.it{cursor:pointer}
.m{color:var(--mut);font-size:12.5px;direction:ltr;unicode-bidi:plaintext;overflow-wrap:anywhere}
.tag{display:inline-block;font-size:11.5px;padding:2px 10px;border-radius:999px;background:rgba(139,92,246,.2);color:#d3c7ff;border:1px solid rgba(139,92,246,.38)}
.tag.bad{background:rgba(255,90,122,.15);color:#ff9fb3;border-color:rgba(255,90,122,.42)}
.bad{color:var(--bad)}.ok{color:var(--ok)}
.v{direction:ltr;unicode-bidi:plaintext;overflow-wrap:anywhere;text-align:left}.it>div>.v{font-weight:700;font-size:16px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:12px}.grid .card{margin:0;padding:14px}
@media(min-width:640px){.grid{grid-template-columns:repeat(4,1fr)}}
.big{font-size:28px;font-weight:800;line-height:1.2;color:var(--cy);text-shadow:0 0 26px rgba(94,231,255,.4);font-variant-numeric:tabular-nums}
.v.big{font-size:21px;letter-spacing:.06em;user-select:all;margin-top:6px}
.chat{display:flex;flex-direction:column;height:58vh;min-height:260px;overflow:auto;border:1px solid var(--line);border-radius:var(--r);padding:12px;background:rgba(10,8,30,.55);margin-bottom:10px}
.msg{align-self:flex-end;margin-bottom:10px;max-width:86%;padding:8px 12px;border-radius:14px 14px 14px 4px;background:rgba(255,255,255,.06);border:1px solid var(--line)}
.msg.me{background:linear-gradient(135deg,rgba(94,231,255,.16),rgba(139,92,246,.3));border-color:rgba(139,92,246,.45);align-self:flex-start;border-radius:14px 14px 4px 14px}
.msg .m{margin-bottom:2px}.msg button{min-height:28px;padding:2px 10px;font-size:12px;margin-inline-start:8px}
.tx{white-space:pre-wrap;word-break:break-word}
.perms{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}.perms .it{padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.04);font-size:13.5px;flex-wrap:nowrap}.perms .it:last-child{border:1px solid var(--line)}.perms .it:has(input:checked){border-color:rgba(139,92,246,.65);background:rgba(139,92,246,.16)}.card>button{margin-top:8px}.card>.m{margin:6px 0 8px;line-height:1.7}.card>.row{margin-top:12px}
.sk{display:block;margin:0 auto;image-rendering:pixelated;width:192px;height:192px;border:1px solid var(--line);border-radius:14px;background:conic-gradient(#1c1842 25%,#120f30 0 50%,#1c1842 0 75%,#120f30 0) 0 0/16px 16px;box-shadow:0 0 30px -8px rgba(139,92,246,.6)}
.out .top{max-width:420px;flex-direction:column;text-align:center;padding:30px 16px 24px;margin-top:9vh}
.out .logo{width:76px;height:76px}.out .ttl h1{font-size:26px}
.out #app{max-width:420px}
@supports not (backdrop-filter:blur(1px)){.card,.top,.tabs{background:rgba(22,18,48,.94)}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
.rimg{max-width:100%;border-radius:14px;border:1px solid var(--line);cursor:zoom-in;display:block}
textarea{width:100%;min-height:130px;resize:vertical;line-height:1.7}
select{min-width:140px}
`;
