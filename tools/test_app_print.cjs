// Run with playwright + pdf-lib available through NODE_PATH.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { chromium } = require("playwright");
const { PDFDocument } = require("pdf-lib");

async function readPdf(bytes) {
  const pdfjs = await import(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true }).promise;
  const texts = [];
  try {
    for (let p = 1; p <= document.numPages; p++) texts.push((await (await document.getPage(p)).getTextContent()).items.map(item => item.str).join(" "));
    return { pages: document.numPages, text: texts.join(" ") };
  } finally { await document.destroy(); }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  try {
    const page = await browser.newPage();
    const alerts = [];
    page.on("dialog", async dialog => { alerts.push({ type: dialog.type(), text: dialog.message() }); await dialog.accept(); });
    const source = fs.readFileSync(path.join(__dirname, "..", "나모푸드_관리앱.html"), "utf8");
    for (const m of source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new Function(m[1]);
    let remote = null, runRequests = 0, stateWrites = 0, conflictsRejected = 0, conflictOnce = false;
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
          if (conflictOnce) { conflictOnce = false; conflictsRejected++; return route.fulfill({ json: [] }); }
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
      clearTimeout(cloudTimer); cloudApplying = true;
      sessionStorage.setItem("nmf_session_pw", "fixture-password");
      S.month = "2026-09"; S.menus = { [S.month]: {} }; S.menuPlanMeta = {}; S.headcountMeta = {};
      const foods = { "조식": "조식검증불고기", "중식": "중식검증돈까스", "석식": "석식검증제육", "야식": "야식검증치킨" };
      for (let d=1; d<=30; d++) for (const meal of MEALS) {
        for (let ci=1; ci<=18; ci++) S.menus[S.month][d+"|"+meal+"|"+ci] = foods[meal]+" "+ci;
        S.menus[S.month][d+"|"+meal+"|n"] = 100 + MEALS.indexOf(meal) * 17;
        S.menuPlanMeta["2026-09-"+String(d).padStart(2,"0")+"|"+meal] = { by:"ai" };
        S.headcountMeta["2026-09-"+String(d).padStart(2,"0")+"|"+meal] = { by:"photo-plan" };
      }
      go("menu");
    });
    const meals = ["조식", "중식", "석식", "야식"], foods = ["조식검증불고기", "중식검증돈까스", "석식검증제육", "야식검증치킨"];
    const stateBeforePrint = await page.evaluate(() => JSON.stringify({ menus: S.menus, menuPlanMeta: S.menuPlanMeta, headcountMeta: S.headcountMeta, settings: S.settings }));
    let pdfCount = 0;
    for (const chosen of [meals, ["중식", "석식"], ["야식"]]) for (const range of ["day", "week", "month"]) for (const mode of ["public", "internal"]) {
      await page.evaluate(({range,mode}) => { S.view={range,mode,ing:false};selDay=24;render(); }, {range,mode});
      assert.equal(await page.locator("input[data-print-meal]").count(), 4, "print filter offers every meal");
      assert.deepEqual(await page.locator("input[data-print-meal]:checked").evaluateAll(inputs => inputs.map(input => input.dataset.printMeal)), meals, "missing print filter defaults to all meals");
      for (const meal of meals.filter(meal => !chosen.includes(meal))) await page.locator(`input[data-print-meal="${meal}"]`).uncheck();
      assert.deepEqual(await page.locator("input[data-print-meal]:checked").evaluateAll(inputs => inputs.map(input => input.dataset.printMeal)), chosen, "actual checkboxes update the requested print subset");
      assert.deepEqual(await page.locator(".editor .mealbox .mealbar").allTextContents(), meals, "print subset does not hide any of the four editing meals");
      assert.equal(await page.evaluate(() => JSON.stringify({ menus: S.menus, menuPlanMeta: S.menuPlanMeta, headcountMeta: S.headcountMeta, settings: S.settings })), stateBeforePrint, "printing selection cannot modify meals, headcounts, AI markings, or settings");
      const text = await page.locator("#menu-print-sheet").innerText();
      assert.equal(text.includes("🤖"), false, range+" "+mode+" contains no AI menu badge");
      for (let mi = 0; mi < meals.length; mi++) assert.equal(text.includes(foods[mi]), chosen.includes(meals[mi]), range+" "+mode+" preview food inclusion: "+meals[mi]);
      const bytes = await page.pdf({preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false});
      const pdf = await PDFDocument.load(bytes);
      assert.equal(pdf.getPageCount(), 1, range+" "+mode+" PDF must fit one page");
      const printed = await readPdf(bytes);
      assert.equal(printed.pages, 1, "independent PDF parser confirms the single page");
      for (let mi = 0; mi < meals.length; mi++) assert.equal(printed.text.includes(foods[mi]), chosen.includes(meals[mi]), range+" "+mode+" actual PDF food inclusion: "+meals[mi]);
      assert.equal(printed.text.includes("🤖"), false, range+" "+mode+" actual PDF has no AI menu badge");
      if (chosen.length === 2 && range === "day" && mode === "public") {
        fs.writeFileSync("/tmp/nmf-print-subset-preview.pdf", bytes);
        await page.locator("#menu-print-sheet").screenshot({ path: "/tmp/nmf-print-subset-preview.png" });
      }
      pdfCount++;
    }
    const beforeEmptyFilter = alerts.length;
    // click, not uncheck: the product intentionally restores the last checkbox.
    await page.locator('input[data-print-meal="야식"]').click();
    assert(alerts.length > beforeEmptyFilter && alerts.at(-1).type === "alert", "unchecking the last meal gives a clear alert");
    assert.deepEqual(await page.locator("input[data-print-meal]:checked").evaluateAll(inputs => inputs.map(input => input.dataset.printMeal)), ["야식"], "at least one meal remains selected");
    assert.equal(await page.evaluate(() => JSON.stringify({ menus: S.menus, menuPlanMeta: S.menuPlanMeta, headcountMeta: S.headcountMeta, settings: S.settings })), stateBeforePrint, "rejected empty selection preserves every original food and headcount");
    await page.evaluate(() => go("sales"));
    const salesDetails = page.locator("details").filter({ has: page.locator("summary", { hasText: "식권 금액 · 끼니별 실적" }) });
    assert.equal(await salesDetails.count(), 1, "sales price/per-meal results has one expandable section");
    assert.equal(await salesDetails.evaluate(element => element.open), false, "sales price/per-meal results starts collapsed");
    await salesDetails.locator("summary").click();
    assert.equal(await salesDetails.evaluate(element => element.open), true, "sales section opens on real user click");
    assert.equal(await salesDetails.locator('input[onchange*="settings.tickets"]').count(), 4, "expanded sales section exposes all four ticket prices");
    await page.evaluate(() => go("menu"));
    // Server finished one recipe while the user was still editing another dish.
    runRequests = 0; stateWrites = 0;
    remote = await page.evaluate(async () => {
      clearTimeout(cloudTimer); clearTimeout(saveTimer); cloudApplying = false;
      S.recipes=[];S.methods={};S.sources={};S.recipeMeta={};S.recipeAsk={};
      S.menus={"2026-09":{"24|중식|2":"대기음식","24|중식|3":"완성음식"}};
      S.menuPlanMeta={}; // These are freshly entered manual foods, not the retired print-fixture AI meals.
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
    assert.equal(conflictsRejected, 1, "the fake server actually rejected the first save with a CAS conflict");
    assert(runRequests >= 1, "successful save must request recipe fill immediately");
    const rows = await page.evaluate(() => S.recipes.filter(r=>r.menu==="완성음식"));
    assert.equal(rows.length,1,"server-generated recipe survives local save without duplicates");
    const savedRows = await page.evaluate(async data => JSON.parse(await decryptText("fixture-password", data)).recipes.filter(r => r.menu === "완성음식"), remote.data);
    assert.equal(savedRows.length, 1, "the retry persisted the merged AI recipe in the encrypted server snapshot");
    const signedStatus = await page.evaluate(async () => {await refreshRecipeMonitor(true);return recipeMonitor.error;});
    assert.equal(signedStatus,"");
    const version = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "ver.json"), "utf8")).v;
    assert.equal(await page.locator("#appver").textContent(), "버전 " + version, "visible full version tag exactly matches the deployed ver.json tag");
    console.log(`PRINT_${pdfCount}_ALL_SUBSET_MODES_ONE_PAGE / PDF_FOOD_EXCLUSION / FOUR_MEAL_EDITOR_DATA_PROTECTED / MINIMUM_ONE_MEAL / ALL_MENU_AI_BADGES_HIDDEN / SALES_COLLAPSED / FULL_VERSION_MATCH / CAS_RETRY / AI_RECIPE_PRESERVED / IMMEDIATE_REQUEST_PASS`);
    console.log("APP_SOURCE_SHA256 " + createHash("sha256").update(source).digest("hex"));
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
