// Run with playwright + pdf-lib available through NODE_PATH.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { PDFDocument } = require("pdf-lib");

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  try {
    const page = await browser.newPage();
    const source = fs.readFileSync(path.join(__dirname, "..", "나모푸드_관리앱.html"), "utf8");
    for (const m of source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new Function(m[1]);
    let remote = null, runRequests = 0, stateWrites = 0, conflictOnce = false;
    await page.route("**/*", async route => {
      const req = route.request(), url = req.url();
      if (req.isNavigationRequest()) return route.fulfill({ contentType: "text/html", body: source });
      if (url.includes("/functions/v1/nmf-recipe-fill")) {
        const { action } = req.postDataJSON();
        assert(req.headers()["x-nmf-signature"]);
        if (action === "run") runRequests++;
        return route.fulfill({ json: { ok: true, running: null, last: { status: "done", started_at: new Date().toISOString(), added: [] }, nextCheckAt: new Date(Date.now() + 60000).toISOString(), runs: [] } });
      }
      if (url.includes("/rest/v1/namofood_state")) {
        if (req.method() === "GET") return route.fulfill({ json: remote ? [remote] : [] });
        if (req.method() === "PATCH") {
          stateWrites++;
          if (conflictOnce) { conflictOnce = false; return route.fulfill({ json: [] }); }
          remote = { id: "namofood", ...req.postDataJSON() };
          return route.fulfill({ json: [{ id: "namofood" }] });
        }
        return route.fulfill({ json: [] });
      }
      return route.abort();
    });
    await page.goto("https://donggeonbae.github.io/namofood/");
    await page.evaluate(() => {
      clearInterval(cloudPollTimer);
      sessionStorage.setItem("nmf_session_pw", "fixture-password");
      S.month = "2026-09"; S.menus[S.month] ||= {};
      for (let d=1; d<=30; d++) for (const meal of MEALS) {
        for (let ci=1; ci<=18; ci++) S.menus[S.month][d+"|"+meal+"|"+ci] = "소고기버섯불고기 "+ci;
        S.menuPlanMeta ||= {}; S.menuPlanMeta["2026-09-"+String(d).padStart(2,"0")+"|"+meal] = { by:"ai" };
      }
      go("menu");
    });
    for (const range of ["day", "week", "month"]) for (const mode of ["public", "internal"]) {
      await page.evaluate(({range,mode}) => { S.view={range,mode,ing:false};selDay=24;render(); }, {range,mode});
      const text = await page.locator("#menu-print-sheet").innerText();
      assert.equal(text.includes("🤖"), mode === "internal", range+" "+mode);
      const pdf = await PDFDocument.load(await page.pdf({preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false}));
      assert.equal(pdf.getPageCount(), 1, range+" "+mode+" PDF must fit one page");
    }
    // Server finished one recipe while the user was still editing another dish.
    remote = await page.evaluate(async () => {
      S.recipes=[];S.methods={};S.sources={};S.recipeMeta={};S.recipeAsk={};
      S.menus={"2026-09":{"24|중식|2":"대기음식","24|중식|3":"완성음식"}};
      S.month="2026-09";cloudRemoteAt=null;cloudBusy=false;cloudDirty=true;
      const other=structuredClone(S);
      other.recipes=[{menu:"완성음식",item:"감자",qty:100,unit:"g",comp:"부찬"}];
      other.recipeMeta={"완성음식":{by:"ai"}};other.methods={"완성음식":"삶는다"};
      return {id:"namofood",data:await encryptText("fixture-password",JSON.stringify(other)),updated_at:new Date().toISOString()};
    });
    conflictOnce = true;
    await page.evaluate(() => cloudSave(true));
    await page.waitForFunction(() => !cloudDirty && !cloudBusy && !recipeMonitor.requesting, {timeout:12000});
    await page.waitForTimeout(250);
    assert(stateWrites >= 2, "CAS conflict must be retried");
    assert(runRequests >= 1, "successful save must request recipe fill immediately");
    const rows = await page.evaluate(() => S.recipes.filter(r=>r.menu==="완성음식"));
    assert.equal(rows.length,1,"server-generated recipe survives local save without duplicates");
    const signedStatus = await page.evaluate(async () => {await refreshRecipeMonitor(true);return recipeMonitor.error;});
    assert.equal(signedStatus,"");
    console.log("PRINT_6_MODES_ONE_PAGE / PUBLIC_AI_HIDDEN / CAS_RETRY / AI_RECIPE_PRESERVED / IMMEDIATE_REQUEST_PASS");
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
