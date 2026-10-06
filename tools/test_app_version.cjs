// Offline regression: an update must load a coherent encrypted build, not loop.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

(async()=>{
  const root=path.join(__dirname,'..');
  const source=fs.readFileSync(path.join(root,'나모푸드_관리앱.html'),'utf8');
  const loader=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const version=JSON.parse(fs.readFileSync(path.join(root,'ver.json'),'utf8')).v;
  const password=process.env.NMF_PW;if(!password)throw new Error('NMF_PW is required');
  const appVersion=source.match(/id="appver">버전 ([^<\s]+)/)[1];
  assert.equal(version,appVersion,'manifest must contain the full app version');
  assert.equal(loader.match(/window\.__VER='([^']+)'/)[1],appVersion,'encrypted loader must have the same full version');
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
    const page=await browser.newPage();let documents=0;
    await page.route('**/*',route=>{
      const request=route.request();
      if(request.url().includes('/ver.json'))return route.fulfill({contentType:'application/json',body:JSON.stringify({v:version})});
      if(request.isNavigationRequest()){
        documents++;
        const body=documents===1?source.replace('버전 '+appVersion,'버전 1002-menu-recovery'):loader;
        return route.fulfill({contentType:'text/html',body});
      }
      return route.abort();
    });
    await page.goto('https://offline.namofood.test/namofood/?v=1002-#roster');
    await page.evaluate(pw=>{
      clearTimeout(cloudTimer);clearInterval(cloudPollTimer);clearTimeout(saveTimer);
      cloud.enabled=false;cloudBusy=true;
      sessionStorage.setItem('nmf_session_pw',pw);
      checkNewVersion();
    },password);
    await page.locator('#newver button').click();
    await page.waitForFunction(expected=>document.getElementById('appver')?.textContent==='버전 '+expected,version);
    assert.equal(new URL(page.url()).searchParams.get('v'),version,'manual update uses the full target version');
    assert.equal(new URL(page.url()).hash,'#roster','update preserves the selected screen');
    await page.waitForTimeout(9000);
    assert.equal(documents,2,'one update navigation, without a reload loop');
    assert.equal(await page.locator('#newver').count(),0,'current build does not show a false update notice');
    console.log('APP_VERSION_FULL_TAG / ENCRYPTED_UNLOCK / MANUAL_UPDATE / ROUTE_PRESERVED / NO_RELOAD_LOOP_PASS');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
