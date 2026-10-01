// Run with playwright, pdf-lib and pdfjs-dist available through NODE_PATH. Network is mocked.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { PDFDocument } = require("pdf-lib");

const upgradedMethod = "1. 300명 기준 전처리한다. 2. 대형 솥에 배치 분할 조리한다. 3. 배식 직전 마무리한다.";

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  try {
    const page = await browser.newPage();
    const source = fs.readFileSync(path.join(__dirname, "..", "나모푸드_관리앱.html"), "utf8");
    for (const m of source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new Function(m[1]);
    let statusRequests = 0;
    await page.route("**/*", async route => {
      const req = route.request();
      if (req.isNavigationRequest()) return route.fulfill({ contentType: "text/html", body: source });
      if (req.url().includes("/functions/v1/nmf-recipe-fill")) {
        assert.equal(req.postDataJSON().action, "status", "the suite must not request recipe generation");
        assert.match(req.headers()["x-nmf-signature"] || "", /^[a-f0-9]{64}$/);
        statusRequests++;
        return route.fulfill({ json: {
          ok: true, running: null, upgradePending: 17,
          last: { status: "done", started_at: new Date().toISOString(), added: [], note: "대량 조리 조리법 전환 3개 완료" },
          nextCheckAt: new Date(Date.now() + 60000).toISOString(), runs: [],
        } });
      }
      if (req.url().includes("/rest/v1/namofood_state")) {
        assert.equal(req.method(), "GET", "the suite must not write even to mocked cloud state");
        return route.fulfill({ json: [] });
      }
      return route.abort();
    });
    page.on("dialog", dialog => dialog.accept());
    await page.goto("https://donggeonbae.github.io/namofood/");
    await page.evaluate(() => {
      clearInterval(cloudPollTimer); clearTimeout(cloudTimer);
      cloudApplying = true;
      sessionStorage.setItem("nmf_session_pw", "fixture-password");
      S.recipes = [
        { menu: "단체급식돈까스", item: "돈육", qty: 90, unit: "g", loss: 0.1, comp: "주찬" },
        { menu: "단체급식돈까스", item: "소스", qty: 18, unit: "ml", loss: 0.1, comp: "주찬" },
        { menu: "단체급식돈까스", item: "포장김", qty: 0.5, unit: "ea", loss: 0, comp: "주찬" },
        { menu: "기존제육볶음", item: "돼지고기", qty: 100, unit: "g", loss: 0, comp: "주찬" },
      ];
      S.methods = { "단체급식돈까스": "대형 튀김기에 배치 분할하여 조리한다.", "기존제육볶음": "프라이팬으로 볶는다." };
      S.recipeMeta = { "단체급식돈까스": { by: "ai", cookingProfile: "institutional-v1" }, "기존제육볶음": { by: "ai" } };
      S.recipeAsk = {}; S.sources = {}; S.menus = {}; recipeQ = ""; rCat = "전체"; rSel = "단체급식돈까스";
      go("recipe");
    });
    assert.equal(await page.locator("#main h1").innerText(), "대량 조리 레시피");
    assert.equal(await page.locator("#rdetail .chip").filter({ hasText: /^대량 조리 기준$/ }).count(), 1);
    const originalRows = await page.evaluate(() => JSON.stringify(S.recipes));
    for (const [count, expected] of [[100, ["10 kg", "2 L", "50 ea"]], [300, ["30 kg", "6 L", "150 ea"]], [500, ["50 kg", "10 L", "250 ea"]]]) {
      await page.locator("#rdetail").getByRole("button", { name: `${count}명`, exact: true }).click();
      assert.equal(await page.evaluate(() => portion), count);
      assert.equal(await page.locator("#rdetail th").nth(6).innerText(), `${count}인분 필요량`);
      assert.deepEqual(await page.locator("#rdetail tbody td.au").allTextContents(), expected);
      assert.equal(await page.evaluate(() => JSON.stringify(S.recipes)), originalRows, "portion presets must never rewrite per-person ingredient quantities");
    }
    await page.evaluate(() => rPick("기존제육볶음"));
    assert.equal(await page.locator("#rdetail .chip").filter({ hasText: /^대량 조리 기준$/ }).count(), 0, "AI authorship alone must not claim institutional verification");
    assert.match(await page.locator("#rdetail").innerText(), /기존 조리법/);
    await page.locator("#rdetail").getByRole("button", { name: "＋ 재료 추가", exact: true }).click();
    assert.equal(await page.evaluate(() => S.recipeMeta["기존제육볶음"].by), "user", "adding an ingredient protects the recipe as user-edited");
    await page.evaluate(() => { S.recipeMeta["기존제육볶음"].by = "ai"; });
    await page.locator("#rdetail tbody tr").last().getByRole("button", { name: "✕", exact: true }).click();
    assert.equal(await page.evaluate(() => S.recipeMeta["기존제육볶음"].by), "user", "deleting an ingredient protects the recipe as user-edited");
    assert.equal(await page.evaluate(() => S.recipes.filter(r => r.menu === "기존제육볶음").length), 1);
    await page.evaluate(() => rPick("단체급식돈까스"));
    await page.locator("#rdetail textarea.method").fill("사용자가 장비에 맞춰 직접 고친 조리 순서");
    await page.locator("#rdetail textarea.method").blur();
    assert.deepEqual(await page.evaluate(() => ({ by: S.recipeMeta["단체급식돈까스"].by, profile: S.recipeMeta["단체급식돈까스"].cookingProfile ?? null, method: S.methods["단체급식돈까스"] })),
      { by: "user", profile: null, method: "사용자가 장비에 맞춰 직접 고친 조리 순서" });
    assert.equal(await page.locator("#rdetail .chip").filter({ hasText: /^대량 조리 기준$/ }).count(), 0, "manual method edits must repaint the confirmed badge immediately");
    await page.evaluate(async () => { await refreshRecipeMonitor(true); });
    const monitorText = await page.locator("#recipe-monitor").innerText();
    assert.match(monitorText, /기존 AI 조리법 17개를 대량 조리 기준으로 순차 전환 중/);
    assert.match(monitorText, /대량 조리 조리법 전환 3개 완료/);
    assert(statusRequests > 0, "monitor evidence must come from the mocked signed server response");

    const checkMerge = async (negativeControl = false) => page.evaluate(({ upgradedMethod, negativeControl }) => {
      const names = ["원본AI", "직접수정", "재료변경", "전환완료", "프로필없는서버", "빈조리법"];
      const rows = names.map(menu => ({ menu, item: "돼지고기", qty: 100, unit: "g", loss: 0, comp: "주찬" }));
      const other = { recipes: structuredClone(rows), methods: {}, recipeMeta: {} };
      S.recipes = structuredClone(rows); S.methods = {}; S.recipeMeta = {};
      for (const name of names) {
        S.methods[name] = "로컬 조리법"; S.recipeMeta[name] = { by: "ai" };
        other.methods[name] = upgradedMethod; other.recipeMeta[name] = { by: "ai", cookingProfile: "institutional-v1", updated: "2026-09-30" };
      }
      S.recipeMeta["직접수정"].by = "user";
      S.recipes.find(r => r.menu === "재료변경").qty = 110;
      S.recipeMeta["전환완료"].cookingProfile = "institutional-v1";
      delete other.recipeMeta["프로필없는서버"].cookingProfile;
      other.methods["빈조리법"] = "   ";
      const beforeRows = JSON.stringify(S.recipes), originalMerge = mergeRemoteInstitutionalMethods;
      try {
        if (negativeControl) mergeRemoteInstitutionalMethods = () => {};
        mergeRemoteInstitutionalMethods(other);
        return { methods: structuredClone(S.methods), metadata: structuredClone(S.recipeMeta), rowsUnchanged: JSON.stringify(S.recipes) === beforeRows };
      } finally { mergeRemoteInstitutionalMethods = originalMerge; }
    }, { upgradedMethod, negativeControl });
    const assertMergedUpgrade = result => assert.equal(result.methods["원본AI"], upgradedMethod, "identical AI ingredient rows must receive the server institutional method");
    const merged = await checkMerge();
    assertMergedUpgrade(merged);
    assert.equal(merged.metadata["원본AI"].cookingProfile, "institutional-v1");
    assert.equal(merged.metadata["원본AI"].updated, "2026-09-30");
    for (const name of ["직접수정", "재료변경", "전환완료", "프로필없는서버", "빈조리법"]) {
      assert.equal(merged.methods[name], "로컬 조리법", `${name}: remote upgrades must preserve protected local data`);
    }
    assert.equal(merged.metadata["직접수정"].by, "user");
    assert(merged.rowsUnchanged, "method upgrades must not rewrite ingredient rows");
    const mutation = await checkMerge(true);
    assert.throws(() => assertMergedUpgrade(mutation), assert.AssertionError, "the upgrade oracle must reject a no-op merge negative control");

    const removedBeer = await page.evaluate(() => {
      const remote={recipes:[],menus:{"2026-10":{"14|야식|10":"치즈핫도그","14|야식|n":"250"}}};
      S.recipes=[{menu:"맥주",item:"캔옥수수"},{menu:"콘치즈",item:"캔옥수수"}];
      S.recipeMeta={"맥주":{by:"ai"},"콘치즈":{by:"user"}};
      S.methods={"맥주":"잘못된 조리법","콘치즈":"수동 조리법"};S.sources={"맥주":"오류"};S.recipeAsk={"맥주":{question:"오류"}};
      S.menus={"2026-10":{"14|야식|10":"치즈핫도그","14|야식|11":"맥주","14|야식|n":"250"}};
      S.menuPlanMeta={"2026-10-14|야식":{by:"ai"}};
      discardRemovedAiBeer(remote);
      const ai={recipes:structuredClone(S.recipes),methods:structuredClone(S.methods),menus:structuredClone(S.menus),meta:structuredClone(S.recipeMeta),sources:structuredClone(S.sources),ask:structuredClone(S.recipeAsk)};
      S.recipes.push({menu:"맥주",item:"수동 입력"});S.recipeMeta["맥주"]={by:"user"};delete S.menuPlanMeta["2026-10-14|야식"];S.menus["2026-10"]["14|야식|11"]="맥주";
      discardRemovedAiBeer(remote);
      return {ai,manualKept:S.recipes.some(r=>r.menu==="맥주")&&S.menus["2026-10"]["14|야식|11"]==="맥주"};
    });
    assert.deepEqual(removedBeer.ai.recipes,[{menu:"콘치즈",item:"캔옥수수"}]);
    assert.deepEqual(removedBeer.ai.methods,{"콘치즈":"수동 조리법"});
    assert.deepEqual(removedBeer.ai.meta,{"콘치즈":{by:"user"}});
    assert.deepEqual(removedBeer.ai.sources,{});assert.deepEqual(removedBeer.ai.ask,{});
    assert.deepEqual(removedBeer.ai.menus,{"2026-10":{"14|야식|10":"치즈핫도그","14|야식|n":"250"}});
    assert(removedBeer.manualKept,"server cleanup must not silently remove manual local entries");

    const checkRestore = async (protect = true, staleOpenPage = false) => page.evaluate(({ upgradedMethod, protect, staleOpenPage }) => {
      const rows = ["복원한옛AI", "복원해도동일AI"].map(menu => ({ menu, item: "돈육", qty: 100, unit: "g", loss: 0, comp: "주찬" }));
      const server = { recipes: structuredClone(rows), methods: {}, recipeMeta: {} };
      for (const row of rows) { server.methods[row.menu] = upgradedMethod; server.recipeMeta[row.menu] = { by: "ai", cookingProfile: "institutional-v1" }; }
      S.recipes = structuredClone(rows); S.methods = structuredClone(server.methods); S.recipeMeta = structuredClone(server.recipeMeta);
      const restored = { recipes: structuredClone(rows), methods: { "복원한옛AI": "복원하기로 선택한 이전 조리법", "복원해도동일AI": upgradedMethod }, recipeMeta: { "복원한옛AI": { by: "ai" }, "복원해도동일AI": { by: "ai" } } };
      if (staleOpenPage) S.methods["복원한옛AI"] = restored.methods["복원한옛AI"];
      if (protect) protectRestoredRecipeMethods(restored);
      const afterProtection = structuredClone(restored.recipeMeta);
      Object.assign(S, restored); mergeRemoteInstitutionalMethods(server);
      return { afterProtection, methods: structuredClone(S.methods), metadata: structuredClone(S.recipeMeta) };
    }, { upgradedMethod, protect, staleOpenPage });
    const assertRestoredMethod = result => assert.equal(result.methods["복원한옛AI"], "복원하기로 선택한 이전 조리법", "a deliberately restored legacy AI method must not be silently re-upgraded during cloud save");
    const restored = await checkRestore();
    assertRestoredMethod(restored);
    assert.equal(restored.afterProtection["복원한옛AI"].by, "user");
    assert.equal(restored.metadata["복원한옛AI"].cookingProfile, undefined);
    assert.equal(restored.afterProtection["복원해도동일AI"].by, "user", "explicit snapshot restore is a manual selection even when the local method happens to match");
    assert.equal(restored.methods["복원해도동일AI"], upgradedMethod);
    assert.equal(restored.metadata["복원해도동일AI"].cookingProfile, undefined);
    const staleRestore = await checkRestore(true, true);
    assertRestoredMethod(staleRestore);
    assert.equal(staleRestore.afterProtection["복원한옛AI"].by, "user", "stale open pages must not let a later server method override an explicitly restored old method");
    const unprotectedRestore = await checkRestore(false);
    assert.throws(() => assertRestoredMethod(unprotectedRestore), assert.AssertionError, "the restore oracle must reject omission of the restore protection step");

    await page.evaluate(() => {
      S.recipes = Array.from({ length: 13 }, (_, i) => ({
        menu: "조리 작업서 인쇄 검증", item: `재료 ${i + 1}`, qty: 5 + i, unit: "g", loss: 0.05,
        comp: "주찬", storage: "냉장", form: "전처리", allergy: "대두",
      }));
      S.methods = { "조리 작업서 인쇄 검증": "저장된 짧은 조리법" };
      S.recipeMeta = { "조리 작업서 인쇄 검증": { by: "ai", cookingProfile: "institutional-v1" } };
      S.menus = {}; S.recipeAsk = {}; portion = 300; rSel = "조리 작업서 인쇄 검증"; render();
    });
    assert.equal(await page.locator("#rdetail").getByRole("button", { name: "이 음식 인쇄", exact: true }).count(), 1);
    const longStep = "전체 식수에 맞춰 계량한 재료를 작업 용기별로 구분하고, 대형 솥의 실제 작업 용량에 맞춰 배치를 나눈다. 담당자가 각 배치의 투입 순서와 조리 상태를 확인하고 조리 완료 시간과 배식 시간을 기록한다. ";
    const fullMethod = Array.from({ length: 10 }, (_, i) => `${i + 1}. ${longStep.repeat(2)}${i === 9 ? "배식 최종 확인 마침표" : "다음 작업자에게 배치 상태를 인계한다."}`).join("\n");
    assert(fullMethod.length > 2000, "print fixture must contain ten substantial steps rather than a short smoke-test method");
    // Set an uncommitted textarea value without firing onchange/blur, so the print
    // hook itself must copy the current editor contents rather than saved state.
    await page.evaluate(method => { document.querySelector("#rdetail textarea.method").value = method; }, fullMethod);
    assert.equal(await page.evaluate(() => S.methods["조리 작업서 인쇄 검증"]), "저장된 짧은 조리법", "print must also handle input that has not yet fired onchange");
    await page.emulateMedia({ media: "print" });
    assert.equal(await page.evaluate(() => S.methods["조리 작업서 인쇄 검증"]), "저장된 짧은 조리법", "print-media emulation must not commit the unsaved method fixture before the beforeprint check");
    assert.equal(await page.locator("#rlist").isVisible(), false, "recipe list must not consume printed pages");
    assert.equal(await page.locator("#recipe-monitor").isVisible(), false, "background monitor must not appear on the cooking worksheet");
    assert.equal(await page.locator("#rdetail textarea.method").isVisible(), false, "scrolling textarea must be replaced by the full printable method");
    assert.equal(await page.locator(".recipe-print-method").isVisible(), true);
    assert.equal(await page.locator(".recipe-print-header").isVisible(), true);
    const previewDir = process.env.NMF_BULK_PREVIEW_DIR;
    const pdfBytes = await page.pdf({ preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false,
      ...(previewDir ? { path: path.join(previewDir, "nmf-bulk-recipe-preview.pdf") } : {}),
    });
    const pdf = await PDFDocument.load(pdfBytes);
    assert.equal(pdf.getPageCount(), 1, "13 ingredients and ten long steps must fit on a single recipe worksheet");
    const size = pdf.getPage(0).getSize();
    assert(Math.abs(size.width - 595.28) < 1 && Math.abs(size.height - 841.89) < 1, "recipe worksheet must use A4 portrait");
    assert.equal(await page.locator(".recipe-print-method").textContent(), fullMethod, "beforeprint must capture every unsaved textarea step, including the final step");
    assert.match(await page.locator(".recipe-print-method").textContent(), /배식 최종 확인 마침표$/);
    const pdfjs = await import(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
    const parsedPdf = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes), disableFontFace: true }).promise;
    const printedText = (await (await parsedPdf.getPage(1)).getTextContent()).items.map(item => item.str || "").join("").replace(/\s+/g, "");
    await parsedPdf.destroy();
    assert(printedText.includes(fullMethod.replace(/\s+/g, "")), "the PDF itself must contain the complete method, not only a scroll-clipped prefix");
    if (previewDir) {
      await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
      await page.locator("#rdetailwrap").screenshot({ path: path.join(previewDir, "nmf-bulk-recipe-preview.png") });
    }
    console.log("BULK_RECIPE_TITLE / PROFILE_BADGE / 100_300_500_SCALING / MANUAL_EDIT_PROTECTION / SERVER_METHOD_MERGE / UPGRADE_MONITOR / RESTORE_PROTECTION / NEGATIVE_CONTROLS / RECIPE_A4_ONE_PAGE_FULL_UNSAVED_METHOD_PASS");
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
