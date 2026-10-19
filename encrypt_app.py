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
boot = 'window.NMF_ACCESS_REQUIRED=true;\n' + '\n'.join(open(os.path.join(asset_dir, name), encoding='utf-8').read() for name in ('access-policy.js','access.js'))
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
.unified-roster th small{display:block;font-size:10px}.unified-roster.roster-monthly td.code{padding:5px 1px}.unified-roster.roster-monthly td.code small{font-size:10px;white-space:nowrap;letter-spacing:-.3px}.unified-roster.roster-monthly th{font-size:10px;padding:6px 1px}.unified-roster.roster-monthly th.roster-person{padding:6px;font-size:12px}
#staff-payroll-table td:first-child{white-space:nowrap;word-break:normal;font-size:12px}#staff-payroll-table td:first-child button{font-size:12px;white-space:nowrap}
#staff-archive-table{width:100%;table-layout:fixed}#staff-archive-table th,#staff-archive-table td{min-width:0;overflow-wrap:anywhere;padding:7px 5px}#staff-archive-table input:not([type=checkbox]){width:100%!important;min-width:0!important;max-width:100%;box-sizing:border-box}#staff-archive-table td:last-child .row{display:grid;grid-template-columns:minmax(0,1fr);width:100%;gap:4px}#staff-archive-table td:last-child .btn{width:100%;min-width:0;max-width:100%;box-sizing:border-box;white-space:normal;overflow-wrap:anywhere;padding:5px 3px;font-size:11px}#staff-archive-table .payroll-paid{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:4px;font-size:11px;white-space:normal}#staff-archive-table td:last-child{width:23%}#staff-directory-table .staff-action .btn{width:100%;box-sizing:border-box}
@media screen and (max-width:900px){.common-roster .unified-roster.roster-monthly{min-width:1120px}.roster-common-toolbar .f{flex:1 1 200px}}
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
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>나모푸드 관리</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1F3864;font-family:"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo",sans-serif;color:#1B2430}
.box{background:#fff;border-radius:18px;padding:34px 30px;width:min(420px,calc(100vw - 32px));box-shadow:0 20px 60px rgba(0,0,0,.35);text-align:center}
h1{font-size:26px;margin:0 0 6px;color:#1F3864}
p{margin:0 0 18px;color:#5B6673;font-size:16px;line-height:1.5}
input{font:inherit;font-size:22px;width:100%;box-sizing:border-box;padding:14px;border:2px solid #D8CF8C;border-radius:12px;background:#FFF9C4;text-align:center;letter-spacing:.1em}
button{font:inherit;font-size:20px;font-weight:700;width:100%;margin-top:12px;padding:15px;border:0;border-radius:12px;background:#1F3864;color:#fff;cursor:pointer}
button:disabled{opacity:.6}
label.r{display:flex;gap:8px;align-items:center;justify-content:center;margin-top:14px;font-size:15px;color:#5B6673}
label.r input{width:20px;height:20px;padding:0}
.err{color:#B71C1C;font-weight:700;margin-top:12px;min-height:24px;font-size:16px}
.foot{margin-top:18px;font-size:13px;color:#8A94A0}
</style>
</head>
<body>
<form class="box" id="f">
  <h1>🍱 나모푸드 관리</h1>
  <p>비밀번호를 입력하면 이 브라우저 안에서만 파일이 열립니다.<br>입력한 내용은 이 기기에만 저장됩니다.</p>
  <input type="password" id="pw" placeholder="비밀번호" autocomplete="current-password" autofocus>
  <button id="go" type="submit">열기</button>
  <label class="r"><input type="checkbox" id="rem"> 이 기기에서 비밀번호 기억 (본인 폰·PC에서만)</label>
  <div class="err" id="err"></div>
  <div class="foot">암호화된 파일 · 비밀번호는 서버로 전송되지 않습니다</div>
</form>
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
  btn.disabled = true; btn.textContent = '여는 중…'; err.textContent = '';
  try {
    const html = await unlock(pw);
    try { sessionStorage.setItem('nmf_session_pw', pw); } catch(e){}
    if (remember) { try { localStorage.setItem('nmf_pw', pw); } catch(e){} } else { try { localStorage.removeItem('nmf_pw'); } catch(e){} }
    document.open(); document.write(html); document.close();
  } catch (e) {
    err.textContent = '비밀번호가 맞지 않습니다. 다시 입력해 주세요.'; btn.disabled = false; btn.textContent = '열기';
    try { localStorage.removeItem('nmf_pw'); } catch(x){}
  }
}
document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); tryOpen(document.getElementById('pw').value, document.getElementById('rem').checked); });
// 캐시된 옛 버전이면 새로 받아온다 (ver.json은 항상 서버에서 확인)
(async()=>{ try{ if(location.protocol==='file:') return; const r=await fetch('ver.json?t='+Date.now(),{cache:'no-store'}); if(!r.ok) return; const j=await r.json(); if(new URLSearchParams(location.search).get('v')===j.v) return; if(j.v && j.v!==window.__VER){ document.getElementById('err').textContent='새 버전으로 바꾸는 중…'; location.replace(location.pathname+'?v='+j.v+location.hash); } }catch(e){} })();
if (!window.crypto || !crypto.subtle) document.getElementById('err').textContent = '이 브라우저는 암호 해제를 지원하지 않습니다. 크롬·삼성인터넷·사파리로 열어 주세요.';
else { try { const saved = localStorage.getItem('nmf_pw'); const sess = sessionStorage.getItem('nmf_session_pw'); if (saved) { document.getElementById('rem').checked = true; tryOpen(saved, true); } else if (sess) { tryOpen(sess, false); } } catch(e){} }
</script>
</body>
</html>
'''
os.makedirs(outdir, exist_ok=True)
import re as _re
_m = _re.search(r'id="appver">버전 ([^<\s]+)', plain.decode('utf-8', 'ignore')); VER = _m.group(1) if _m else 'dev'
open(os.path.join(outdir, 'index.html'), 'w', encoding='utf-8').write(LOADER.replace('__PAYLOAD__', payload).replace('__VER__', VER))
open(os.path.join(outdir, 'ver.json'), 'w', encoding='utf-8').write(json.dumps({"v": VER}))
print(f"encrypted: {len(plain)//1024} KB -> index.html {len(payload)//1024} KB, iterations={ITER}")
