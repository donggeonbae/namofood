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
if (!window.crypto || !crypto.subtle) document.getElementById('err').textContent = '이 브라우저는 암호 해제를 지원하지 않습니다. 크롬·삼성인터넷·사파리로 열어 주세요.';
else { try { const saved = localStorage.getItem('nmf_pw'); if (saved) { document.getElementById('rem').checked = true; tryOpen(saved, true); } } catch(e){} }
</script>
</body>
</html>
'''
os.makedirs(outdir, exist_ok=True)
open(os.path.join(outdir, 'index.html'), 'w', encoding='utf-8').write(LOADER.replace('__PAYLOAD__', payload))
print(f"encrypted: {len(plain)//1024} KB -> index.html {len(payload)//1024} KB, iterations={ITER}")
