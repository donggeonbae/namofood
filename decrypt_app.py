# -*- coding: utf-8 -*-
"""index.html(암호화 배포본)에서 앱 원본 HTML을 복원한다. encrypt_app.py의 역방향.
사용법:  python decrypt_app.py [index.html] [출력파일]
비밀번호: 환경변수 NMF_PW 또는 %USERPROFILE%\.namofood_pw 파일 (nmf_cloud.mjs와 동일)
"""
import sys, os, re, json, base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

src = sys.argv[1] if len(sys.argv) > 1 else "index.html"
out = sys.argv[2] if len(sys.argv) > 2 else "나모푸드_관리앱.html"
pw = os.environ.get("NMF_PW")
if not pw:
    f = os.path.join(os.path.expanduser("~"), ".namofood_pw")
    if os.path.exists(f): pw = open(f, encoding="utf-8").read().strip()
if not pw: sys.exit("비밀번호가 없습니다. NMF_PW 환경변수 또는 ~/.namofood_pw 파일을 만들어 주세요.")

html = open(src, encoding="utf-8").read()
P = json.loads(re.search(r'<script id="payload" type="application/json">(.*?)</script>', html, re.S).group(1))
b64 = base64.b64decode
key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=b64(P["salt"]), iterations=P["iter"]).derive(pw.encode("utf-8"))
plain = AESGCM(key).decrypt(b64(P["iv"]), b64(P["ct"]), None)
open(out, "wb").write(plain)
print(f"decrypted: {len(plain)//1024} KB -> {out}")
