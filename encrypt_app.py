# -*- coding: utf-8 -*-
"""나모푸드 관리앱을 비밀번호로 암호화해 GitHub Pages용 index.html(잠금 페이지)로 만든다.
사용법:  python encrypt_app.py <앱.html> <출력폴더> <비밀번호>
- AES-256-GCM, 키는 PBKDF2-SHA256(300,000회)로 비밀번호에서 유도. 브라우저(Web Crypto)에서만 해제됩니다.
"""
import sys, os, json, base64, secrets
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

src, outdir, password = sys.argv[1], sys.argv[2], sys.argv[3]
ITER = 600_000
plain = open(src, 'rb').read()
import re
# The common app password must not unlock historical private seed data. Current
# private state is served separately, only after server-side admin authentication.
source = plain.decode('utf-8')
match = re.search(r'^const SEED = (.+);$', source, re.MULTILINE)
if not match:
    raise ValueError('SEED boundary missing; refusing an unsafe production build')
seed = json.loads(match.group(1))
for field in ('staff', 'purch', 'stock'):
    seed[field] = []
seed['menu30'] = {}
source = source[:match.start()] + 'const SEED = ' + json.dumps(seed, ensure_ascii=False) + ';' + source[match.end():]
source = re.sub(r"^    for\(const e of state.staff\|\|\[\]\)if\(\['최동희','배선호','최영환'\].*?$", '', source, flags=re.MULTILINE)
boot_marker = 'window.NMF_ACCESS_REQUIRED=false;/* NMF_ACCESS_BOOT */'
if source.count(boot_marker) != 1:
    raise ValueError('Access boot boundary missing; refusing an unsafe build')
asset_dir = os.path.join(os.path.dirname(os.path.abspath(src)), 'assets')
boot = 'window.NMF_ACCESS_REQUIRED=true;\n' + '\n'.join(open(os.path.join(asset_dir, name), encoding='utf-8').read() for name in ('access-policy.js','store-amounts.js','access.js'))
source = source.replace(boot_marker, boot)
source = source.replace('</head>', '''<style>
#admin-access{padding:8px 10px;border:1px solid #ffffff35;border-radius:6px;margin:0 0 10px;font-size:12px;min-width:0;max-width:100%;box-sizing:border-box;flex-shrink:0}
#admin-access form{display:grid;grid-template-columns:auto minmax(45px,1fr) auto;gap:6px;align-items:center}
#admin-access input{width:100%;min-width:0;padding:7px;font-size:13px;box-sizing:border-box;background:#fff9d9!important;color:#172e45!important;-webkit-text-fill-color:#172e45!important;caret-color:#172e45}
#admin-access input::placeholder{color:#65717c;opacity:1;-webkit-text-fill-color:#65717c}
#admin-access .btn{padding:7px 9px;font-size:12px;white-space:nowrap;width:auto;min-width:0;margin:0}
#admin-access small{display:block;overflow-wrap:anywhere;color:#ffdbac}
#admin-access.is-admin{text-align:center}#admin-access.is-admin>span{display:block}#admin-access #admin-lock{display:flex;align-items:center;justify-content:center;margin:7px auto 0;color:#19324b;background:#fff}
.common-roster .roster-common-toolbar{justify-content:space-between;align-items:center;margin-bottom:10px}.roster-common-toolbar .f{flex-direction:row;align-items:center;font-size:12px;gap:6px}.roster-common-toolbar select{font-size:12px;max-width:200px}
.unified-roster{table-layout:fixed;width:100%}.unified-roster .roster-person-col{width:90px}.unified-roster .roster-person{white-space:nowrap!important;word-break:normal!important;overflow-wrap:normal!important;font-size:12px;text-align:left;padding:6px}.unified-roster .roster-person span{white-space:nowrap!important}
.unified-roster th small{display:block;font-size:10px}.unified-roster.roster-monthly td.code{padding:6px 1px;font-size:12px}.unified-roster.roster-monthly td.code small{display:block;font-family:Arial,sans-serif;font-variant-numeric:tabular-nums;font-size:11px;line-height:1.5;white-space:nowrap;letter-spacing:-.25px}.unified-roster.roster-monthly .roster-range-separator{display:none}.unified-roster.roster-monthly th{font-size:10px;padding:6px 1px}.unified-roster.roster-monthly th.roster-person{padding:6px;font-size:12px}
.common-roster{min-width:0}.common-roster .roster-tables{display:grid;gap:16px;min-width:0}.common-roster .tbl{min-width:0;max-width:100%}.common-roster table.unified-roster{min-width:0;max-width:100%;border-collapse:collapse}.common-roster .roster-person-col{width:88px}.common-roster .roster-person{box-sizing:border-box}.common-roster .roster-common-toolbar{gap:10px}.common-roster .roster-common-toolbar>b{font-size:18px;flex:1 1 190px}.common-roster .roster-common-toolbar .f{display:flex;flex-wrap:wrap;min-width:0}.common-roster .roster-common-toolbar select{width:220px;max-width:100%;font-size:12px}.common-roster .roster-common-toolbar>.btn{white-space:normal}.common-roster .roster-time-legend{font-size:11px;margin:0 0 12px}.common-roster .roster-outside{background:#f3f5f7}.unified-roster caption{caption-side:top;text-align:left;padding:0 0 7px;font-size:13px;font-weight:700;color:#34465c}.unified-roster td.code{overflow-wrap:anywhere}.unified-roster .roster-bulk-check{display:block;width:15px;height:15px;margin:0 auto 3px}.unified-roster .roster-bulk-group{width:15px;height:15px;margin:0 2px 3px 0}.common-roster .unified-roster.roster-monthly td small{max-width:100%}
#staff-payroll-table td:first-child{white-space:nowrap;word-break:normal;font-size:12px}#staff-payroll-table td:first-child button{font-size:12px;white-space:nowrap}
@media screen and (max-width:760px){#staff-payroll-table .payroll-total td:first-child{white-space:normal;overflow-wrap:anywhere;min-width:0}#staff-payroll-table .payroll-total td:first-child small{white-space:normal;overflow-wrap:anywhere}}
#staff-archive-table{width:100%;table-layout:fixed}#staff-archive-table th,#staff-archive-table td{min-width:0;overflow-wrap:anywhere;padding:7px 5px}#staff-archive-table input:not([type=checkbox]){width:100%!important;min-width:0!important;max-width:100%;box-sizing:border-box}#staff-archive-table td:last-child .row{display:grid;grid-template-columns:minmax(0,1fr);width:100%;gap:4px}#staff-archive-table td:last-child .btn{width:100%;min-width:0;max-width:100%;box-sizing:border-box;white-space:normal;overflow-wrap:anywhere;padding:5px 3px;font-size:11px}#staff-archive-table .payroll-paid{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:4px;font-size:11px;white-space:normal}#staff-archive-table td:last-child{width:23%}#staff-directory-table .staff-action .btn{width:100%;box-sizing:border-box}
@media screen and (max-width:900px){.roster-common-toolbar .f{flex:1 1 200px}}@media screen and (max-width:600px){.common-roster .roster-person-col{width:64px}.common-roster .unified-roster .roster-person{font-size:11px;padding:4px}.common-roster .unified-roster.roster-monthly td.code small{font-size:10px}.common-roster .roster-common-toolbar select{width:100%;font-size:13px}.common-roster .roster-common-toolbar>.btn{width:100%}}
nav [hidden]{display:none!important}
#staff-archive-table input[type=checkbox]{width:16px!important;min-width:16px!important;max-width:16px!important;height:16px!important;min-height:16px!important;padding:0!important;flex:0 0 16px}#staff-archive-table .payroll-paid{flex-wrap:nowrap;justify-content:flex-start;text-align:left}@media screen and (max-width:700px){#staff-archive-table td:last-child{width:auto!important;justify-self:stretch}#staff-archive-table td:last-child .row{grid-template-columns:repeat(2,minmax(0,1fr));margin-top:7px}#staff-archive-table td:last-child .btn{min-height:34px;font-size:12px}}
.store-channel-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;margin-top:9px}.store-channel-grid .f{font-size:11px;min-width:0;white-space:nowrap}.store-channel-grid input{width:100%!important;min-width:0!important;box-sizing:border-box;padding:6px 3px;font-size:13px}.store-channel-grid input:disabled{background:#eee}
.access-switch-stack{min-width:0;max-width:100%}
@media screen and (max-width:900px){nav{align-items:center}.access-switch-stack{flex:0 0 228px;width:228px}nav .access-switch-stack .appsw{width:100%;margin:0 0 5px}#admin-access{width:100%;margin:0;padding:5px 7px}}
</style></head>''')
plain = source.encode('utf-8')
salt = secrets.token_bytes(16); iv = secrets.token_bytes(12)
key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER).derive(password.encode('utf-8'))
ct = AESGCM(key).encrypt(iv, plain, None)
b64 = lambda b: base64.b64encode(b).decode()
payload = json.dumps({"v": 1, "iter": ITER, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)})

LOADER = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#25443b">
<title>NAMO FOOD — Workspace</title>
<style>
:root{color-scheme:light;--pine:#25443b;--pine-deep:#172f28;--gold:#e4bf76;--paper:#f7f5ef;--ink:#233d35}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:32px 20px;background:var(--pine-deep);font-family:"Avenir Next","Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased}
.entrance{width:min(900px,100%)}.masthead,.signature{display:flex;justify-content:space-between;gap:16px;align-items:center;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#c6cfc6}.masthead{padding:0 0 17px}.signature{padding:17px 0 0;color:#a5b5a9}
.box{display:grid;grid-template-columns:1.08fr 1fr;min-height:480px;background:var(--paper);border:1px solid #d8b46a40;box-shadow:0 28px 80px #0003;border-radius:3px;overflow:hidden}
.brand{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 32px;background:var(--pine);color:var(--gold);position:relative;text-align:center}.brand:after{content:"";position:absolute;inset:18px;border:1px solid #e4bf7640;pointer-events:none}.emblem{height:130px;width:96px;margin-bottom:26px}.emblem svg{display:block;width:100%;height:100%}.emblem path{fill:var(--gold)}.emblem:empty{display:none}
h1{font-weight:400;font-size:29px;letter-spacing:.22em;margin:0 0 18px;padding-left:.22em;line-height:1.35}.brand-line{width:28px;height:1px;background:var(--gold);margin-bottom:17px}.brand p{margin:0;font-size:9px;letter-spacing:.22em;color:#e3cd9b;line-height:1.8}
.entry{display:flex;flex-direction:column;justify-content:center;min-width:0;padding:54px 42px}.eyebrow{font-size:10px;font-weight:600;letter-spacing:.2em;color:#5e7267;margin:0 0 14px}h2{font-family:"Iowan Old Style",Baskerville,Georgia,serif;font-size:37px;font-weight:400;letter-spacing:-.035em;line-height:1.15;margin:0 0 36px}
.password-label{font-size:12px;font-weight:600;margin:0 0 9px;display:block}.password-field{position:relative}.password-field input{display:block;font:inherit;font-size:18px;width:100%;height:51px;padding:12px 68px 12px 14px;border:1px solid #a8b5a8;border-radius:3px;background:#fffdfa;color:var(--ink);outline:none;min-width:0}.password-field input:focus{border-color:var(--pine);box-shadow:0 0 0 3px #153f3615}.password-field input::placeholder{font-size:14px;letter-spacing:0;color:#758377}
button{font:inherit;cursor:pointer}button:focus-visible,input:focus-visible{outline:2px solid #977331;outline-offset:4px}.reveal{position:absolute;right:4px;top:4px;height:43px;border:0;background:transparent;font-size:12px;color:#405c4e;padding:0 13px;font-weight:600}.submit{width:100%;min-height:51px;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 17px;margin-top:15px;background:var(--pine);border:1px solid var(--pine);border-radius:3px;color:#fffdf5;font-size:13px;font-weight:600;letter-spacing:.025em}.submit:hover{background:#204e42}.submit:disabled{cursor:wait;opacity:.65}.submit span{font-size:19px;font-weight:400;line-height:1}
label.r{display:flex;gap:9px;align-items:center;margin-top:20px;font-size:11px;line-height:1.5;color:#516558;cursor:pointer}label.r input{flex:none;width:15px;height:15px;margin:0;accent-color:var(--pine)}.err{color:#a02e24;font-size:12px;line-height:1.6;min-height:22px;margin:12px 0 0;overflow-wrap:anywhere}
@media(max-width:620px){body{padding:22px 18px}.box{grid-template-columns:1fr;min-height:0}.brand{padding:37px 24px 34px}.brand:after{inset:12px}.emblem{width:55px;height:76px;margin-bottom:16px}h1{font-size:24px;margin-bottom:12px}.brand-line{margin-bottom:11px}.brand p{font-size:8px}.entry{padding:31px 27px 24px}h2{font-size:33px;margin-bottom:25px}.eyebrow{margin-bottom:10px}.masthead,.signature{font-size:9px;letter-spacing:.12em}.signature span:last-child{display:none}}
@media(prefers-reduced-motion:no-preference){.submit{transition:background .15s}}
</style>
</head>
<body>
<main class="entrance">
<header class="masthead"><span>NAMO FOOD</span><span>Operations workspace</span></header>
<div class="box">
  <section class="brand" aria-label="NAMO FOOD"><div class="emblem">__BRAND_LOGO__</div><h1>NAMO FOOD</h1><div class="brand-line"></div><p>FOOD &nbsp;·&nbsp; CAFE &nbsp;·&nbsp; STORE</p></section>
  <form class="entry" id="f"><p class="eyebrow">TEAM ACCESS</p><h2>Welcome back.</h2>
    <label class="password-label" for="pw">Password</label><div class="password-field"><input type="password" id="pw" placeholder="Enter your password" autocomplete="current-password" required autofocus aria-describedby="err"><button class="reveal" id="reveal" type="button" aria-label="Show password" aria-pressed="false">Show</button></div>
    <button class="submit" id="go" type="submit">Enter workspace <span aria-hidden="true">↗</span></button>
    <label class="r"><input type="checkbox" id="rem"> Remember on this device</label>
    <div class="err" id="err" role="alert" aria-live="polite"></div>
  </form>
</div>
<footer class="signature"><span>Made for every day.</span><span>NAMO FOOD</span></footer>
</main>
<script id="payload" type="application/json">__PAYLOAD__</script>
<script>window.__VER='__VER__';</script>
<script>
const P = JSON.parse(document.getElementById('payload').textContent);
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function unlock(pw){
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({name:'PBKDF2', salt:b64(P.salt), iterations:P.iter, hash:'SHA-256'}, km, {name:'AES-GCM', length:256}, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({name:'AES-GCM', iv:b64(P.iv)}, key, b64(P.ct));
  return new TextDecoder().decode(pt);
}
async function tryOpen(pw, remember){
  const err = document.getElementById('err'), btn = document.getElementById('go');
  btn.disabled = true; btn.textContent = 'Opening workspace…'; err.textContent = '';
  try {
    const html = await unlock(pw);
    try { sessionStorage.setItem('nmf_session_pw', pw); } catch(e){}
    if (remember) { try { localStorage.setItem('nmf_pw', pw); } catch(e){} } else { try { localStorage.removeItem('nmf_pw'); } catch(e){} }
    document.open(); document.write(html); document.close();
  } catch (e) {
    err.textContent = 'That password is not correct. Please try again.'; btn.disabled = false; btn.textContent = 'Enter workspace';
    try { localStorage.removeItem('nmf_pw'); } catch(x){}
  }
}
document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); tryOpen(document.getElementById('pw').value, document.getElementById('rem').checked); });
document.getElementById('reveal').addEventListener('click', e => { const input=document.getElementById('pw'),show=input.type==='password';input.type=show?'text':'password';e.currentTarget.textContent=show?'Hide':'Show';e.currentTarget.setAttribute('aria-label',show?'Hide password':'Show password');e.currentTarget.setAttribute('aria-pressed',String(show)); });
// 캐시된 옛 버전이면 새로 받아온다 (ver.json은 항상 서버에서 확인)
(async()=>{ try{ if(location.protocol==='file:') return; const r=await fetch('ver.json?t='+Date.now(),{cache:'no-store'}); if(!r.ok) return; const j=await r.json(); if(new URLSearchParams(location.search).get('v')===j.v) return; if(j.v && j.v!==window.__VER){ document.getElementById('err').textContent='Updating workspace…'; location.replace(location.pathname+'?v='+j.v+location.hash); } }catch(e){} })();
if (!window.crypto || !crypto.subtle) document.getElementById('err').textContent = 'Please open this page in an up-to-date browser.';
else { try { const saved = localStorage.getItem('nmf_pw'); const sess = sessionStorage.getItem('nmf_session_pw'); if (saved) { document.getElementById('rem').checked = true; tryOpen(saved, true); } else if (sess) { tryOpen(sess, false); } } catch(e){} }
</script>
</body>
</html>
'''
os.makedirs(outdir, exist_ok=True)
import re as _re
_m = _re.search(r'id="appver">버전 ([^<\s]+)', plain.decode('utf-8', 'ignore')); VER = _m.group(1) if _m else 'dev'
logo_path = os.path.join(asset_dir, 'namofood-emblem.svg')
logo = open(logo_path, encoding='utf-8').read() if os.path.isfile(logo_path) else ''
if logo:
    import xml.etree.ElementTree as ET
    root = ET.fromstring(logo)
    if any(e.tag.split('}')[-1] not in ('svg','path','g','title','desc') or any(k.lower().startswith('on') or k.split('}')[-1] in ('href','style') for k in e.attrib) for e in root.iter()):
        raise ValueError('Brand logo contains unsupported active content')
    logo = re.sub(r'<\?xml[^>]*\?>', '', logo).strip()
open(os.path.join(outdir, 'index.html'), 'w', encoding='utf-8').write(LOADER.replace('__PAYLOAD__', payload).replace('__VER__', VER).replace('__BRAND_LOGO__',logo))
open(os.path.join(outdir, 'ver.json'), 'w', encoding='utf-8').write(json.dumps({"v": VER}))
print(f"encrypted: {len(plain)//1024} KB -> index.html {len(payload)//1024} KB, iterations={ITER}")
