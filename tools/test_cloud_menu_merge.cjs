// Mocked end-to-end cloudSave regression. Run with playwright available via NODE_PATH.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const password = "cloud-menu-fixture-password";

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  try {
    const page = await browser.newPage();
    let source = fs.readFileSync(path.join(__dirname, "..", "나모푸드_관리앱.html"), "utf8");
    const mutation = process.env.NMF_MENU_MERGE_NEGATIVE_CONTROL;
    if (mutation) {
      const mutations = {
        "1": ["mergeRemoteMenus(other);", "/* menu merge deliberately omitted in disposable test page */"],
        "remote-overwrite": ["mergeRemoteMenus(other);", "S.menus=structuredClone(other.menus);S.menuPlanMeta=structuredClone(other.menuPlanMeta);S.headcountMeta=structuredClone(other.headcountMeta);"],
        "metadata-overwrite": ["mergeRemoteMenus(other);", "mergeRemoteMenus(other);S.menuPlanMeta=structuredClone(other.menuPlanMeta);"],
        "live-baseline": ["cloudMenuBase=captureCloudMenuBase(sent);", "cloudMenuBase=captureCloudMenuBase(S);"],
      };
      assert(mutations[mutation], "unknown isolated negative control");
      const [from, to] = mutations[mutation];
      assert(source.includes(from), "negative control requires its integration point");
      source = source.replace(from, to);
    }
    let remote = null, conflictRow = null, conflictOnce = false, patches = 0;
    let firstCommitted = null, routeError = null;
    await page.route("**/*", async route => {
      const req = route.request(), url = new URL(req.url());
      try {
        if (req.isNavigationRequest()) return route.fulfill({ contentType: "text/html", body: source });
        if (url.pathname.endsWith("/functions/v1/nmf-recipe-fill")) {
          assert.match(req.headers()["x-nmf-signature"] || "", /^[a-f0-9]{64}$/);
          return route.fulfill({ json: { ok: true, running: null, runs: [], last: null } });
        }
        if (url.pathname.endsWith("/rest/v1/namofood_state")) {
          if (req.method() === "GET") return route.fulfill({ json: remote ? [remote] : [] });
          if (req.method() === "PATCH") {
            patches++;
            assert.equal(url.searchParams.get("id"), "eq.namofood", "save must target only the current room");
            if (conflictOnce) {
              conflictOnce = false; remote = conflictRow;
              return route.fulfill({ json: [] });
            }
            if (url.searchParams.get("updated_at") !== "eq." + remote.updated_at) return route.fulfill({ json: [] });
            remote = { id: "namofood", ...req.postDataJSON() };
            firstCommitted ||= remote;
            return route.fulfill({ json: [{ id: "namofood" }] });
          }
          assert.equal(req.method(), "POST", "unexpected state mutation");
          assert(req.postDataJSON().every(row => row.id.startsWith("namofood@")), "backup requests must not overwrite the main room");
          return route.fulfill({ json: [] });
        }
        return route.abort();
      } catch (error) { routeError = error; return route.abort(); }
    });
    await page.goto("https://donggeonbae.github.io/namofood/");
    // Let the startup load finish against an empty mock before fixtures become available.
    await page.waitForTimeout(350);
    const base = await page.evaluate(password => {
      clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer);
      sessionStorage.setItem("nmf_session_pw", password);
      S.month = "2026-10"; cloudRemoteAt = null; cloudDirty = false; cloudBusy = false;
      S.menus = { "2026-10": { "14|중식|2": "기존제육", "14|중식|3": "삭제할반찬", "14|중식|7": "생선구이", "14|중식|n": "250" } };
      S.menuPlanMeta = { "2026-10-14|중식": { by: "manual", runId: "baseline" } };
      S.headcountMeta = { "2026-10-14|중식": { by: "photo-plan", updated: "2026-10-01" } };
      S.recipes = [{ menu: "수동차돌볶음", item: "소고기", qty: 100, unit: "g", comp: "주찬" }];
      S.methods = { "수동차돌볶음": "사용자 조리법" }; S.recipeMeta = { "수동차돌볶음": { by: "user" } };
      S.sources = {}; S.recipeAsk = {}; S.settings.customMarker = "baseline setting";
      return structuredClone(S);
    }, password);
    const suppressed = await page.evaluate(base => {
      const remote=structuredClone(base);
      Object.assign(remote.menus['2026-10'],{'15|중식|0':'쌀밥','15|중식|1':'복귀하면안되는AI국','15|중식|2':'복귀하면안되는AI주찬','15|중식|8':'복귀하면안되는AI추가주찬','15|중식|n':'275','16|석식|2':'다른기기수동주찬'});
      remote.menuPlanMeta['2026-10-15|중식']={by:'ai',runId:'stale-automatic-client'};
      remote.menuPlanMeta['2026-10-16|석식']={by:'manual',runId:'other-manual-client'};
      cloudMenuBase=captureCloudMenuBase(S);mergeRemoteMenus(remote);
      const result={menus:structuredClone(S.menus),meta:structuredClone(S.menuPlanMeta)};
      Object.assign(S,structuredClone(base));cloudMenuBase=captureCloudMenuBase(S);
      return result;
    },base);
    assert.equal(suppressed.menus['2026-10']['15|중식|1'],undefined,'a stale AI menu cannot resurrect its soup');
    assert.equal(suppressed.menus['2026-10']['15|중식|2'],undefined,'a stale AI menu cannot resurrect its primary main');
    assert.equal(suppressed.menus['2026-10']['15|중식|8'],undefined,'a stale AI menu cannot resurrect its third-main slot');
    assert.equal(suppressed.menus['2026-10']['15|중식|0'],'쌀밥','default rice is independent from retired AI menu food');
    assert.equal(suppressed.menus['2026-10']['15|중식|n'],'275','headcounts still reconcile independently of retired AI menu food');
    assert.equal(suppressed.menus['2026-10']['16|석식|2'],'다른기기수동주찬','another device manual menu continues to reconcile');
    assert.equal(suppressed.meta['2026-10-15|중식'],undefined,'stale AI provenance cannot return');
    const wrap = async (state, updatedAt) => ({ id: "namofood", data: await page.evaluate(async ({ password, state }) => encryptText(password, JSON.stringify(state)), { password, state }), updated_at: updatedAt });
    remote = await wrap(base, "2026-10-01T01:00:00.000Z");
    assert.equal(await page.evaluate(() => cloudLoad(false)), true, "a real cloud load must establish the three-way baseline");
    const local = await page.evaluate(() => {
      cloudApplying = true;
      menuSet(14, "중식", "2", "수동차돌볶음");
      menuSet(14, "중식", "3", "");
      menuSet(14, "중식", "n", "333");
      menuSet(15, "중식", "n", "321");
      S.settings.customMarker = "locally edited setting";
      clearTimeout(saveTimer); clearTimeout(cloudTimer); cloudApplying = false; cloudDirty = true;
      return structuredClone(S);
    });
    const server = structuredClone(base);
    Object.assign(server.menus["2026-10"], {
      "15|중식|1": "육개장", "15|중식|2": "돈육수육", "15|중식|7": "생선튀김", "15|중식|n": "300",
      "16|야식|1": "어묵국", "16|야식|2": "닭강정", "16|야식|7": "계란찜", "16|야식|n": "275",
    });
    for (const date of ["2026-10-15|중식", "2026-10-16|야식"]) {
      server.menuPlanMeta[date] = { by: "manual", runId: "manual-menu-server" };
      server.headcountMeta[date] = { by: "photo-plan", updated: "2026-10-02" };
    }
    server.recipes.push({ menu: "닭강정", item: "닭고기", qty: 120, unit: "g", comp: "주찬" });
    server.recipeMeta["닭강정"] = { by: "ai", cookingProfile: "institutional-v1" };
    server.methods["닭강정"] = "서버에서 완성한 대량 조리법";
    remote = await wrap(server, "2026-10-02T01:00:00.000Z");
    const newer = structuredClone(server);
    newer.menus["2026-10"]["15|중식|2"] = "돈육보쌈";
    newer.menus["2026-10"]["15|중식|n"] = "310";
    newer.menuPlanMeta["2026-10-15|중식"] = { by: "manual", runId: "concurrent-menu-revision" };
    newer.headcountMeta["2026-10-15|중식"] = { by: "photo-plan", updated: "2026-10-02T01:00:01.000Z" };
    newer.menus["2026-10"]["16|야식|n"] = "285";
    newer.headcountMeta["2026-10-16|야식"] = { by: "photo-plan", updated: "2026-10-02T01:00:01.000Z" };
    Object.assign(newer.menus["2026-10"], { "17|조식|2": "돈육장조림", "17|조식|n": "120" });
    newer.menuPlanMeta["2026-10-17|조식"] = { by: "manual", runId: "concurrent-manual-menu" };
    newer.headcountMeta["2026-10-17|조식"] = { by: "photo-plan", updated: "2026-10-02" };
    conflictRow = await wrap(newer, "2026-10-02T01:00:01.000Z"); conflictOnce = true;
    await page.evaluate(() => cloudSave(true));
    await page.waitForFunction(() => !cloudBusy && !cloudDirty && !recipeMonitor.requesting, { timeout: 12000 });
    if (routeError) throw routeError;
    assert(patches >= 2, "a concurrent server update must force a fresh CAS retry");
    assert(firstCommitted, "a successful committed state must be observed");
    const committed = await page.evaluate(async ({ password, row }) => JSON.parse(await decryptText(password, row.data)), { password, row: firstCommitted });
    const expectedMenus = structuredClone(newer.menus);
    expectedMenus["2026-10"]["14|중식|2"] = "수동차돌볶음";
    delete expectedMenus["2026-10"]["14|중식|3"];
    expectedMenus["2026-10"]["14|중식|n"] = "333";
    expectedMenus["2026-10"]["15|중식|n"] = "321";
    assert.equal(committed.menus["2026-10"]["15|중식|2"], "돈육보쌈", "CAS retry must retain revised server menus instead of treating its previous merge as a manual edit");
    assert.equal(committed.menus["2026-10"]["16|야식|2"], "닭강정", "stale local save must preserve another device's manually entered October 16 menus");
    assert.deepEqual(committed.menus, expectedMenus, "save preserves fresh server cells and exact local edits/deletions/counts");
    const expectedMeta = structuredClone(newer.menuPlanMeta);
    delete expectedMeta["2026-10-14|중식"];
    assert.deepEqual(committed.menuPlanMeta, expectedMeta, "locally edited food clears its marker, while another device's manual meals keep provenance");
    const expectedCounts = structuredClone(newer.headcountMeta);
    expectedCounts["2026-10-14|중식"] = local.headcountMeta["2026-10-14|중식"];
    expectedCounts["2026-10-15|중식"] = local.headcountMeta["2026-10-15|중식"];
    assert.deepEqual(committed.headcountMeta, expectedCounts, "manual headcount provenance survives independently of server AI menu provenance");
    assert.deepEqual(committed.settings, local.settings, "menu reconciliation must not replace unrelated local settings");
    assert.deepEqual(committed.recipes, server.recipes, "existing completed AI recipe merge remains intact without duplicating manual rows");
    assert.deepEqual(committed.recipeMeta, server.recipeMeta);
    assert.deepEqual(committed.methods, server.methods);
    const displayed = await page.evaluate(() => ({ menus: S.menus, menuPlanMeta: S.menuPlanMeta, headcountMeta: S.headcountMeta }));
    assert.deepEqual(displayed, { menus: expectedMenus, menuPlanMeta: expectedMeta, headcountMeta: expectedCounts }, "the open UI must retain the same merged menus it committed");

    // A user can edit again while an encrypted save is in flight. Its new edits
    // must not be promoted to the baseline of the older snapshot being sent.
    await page.evaluate(() => {
      const originalEncrypt = encryptText;
      encryptText = async (pw, text) => {
        const encrypted = await originalEncrypt(pw, text);
        if (window.editDuringSaveEncryption) {
          window.editDuringSaveEncryption = false;
          cloudApplying = true;
          menuSet(16, "야식", "2", "암호화 중 수동메뉴");
          menuSet(16, "야식", "n", "399");
          clearTimeout(saveTimer); clearTimeout(cloudTimer); cloudApplying = false;
        }
        return encrypted;
      };
      cloudApplying = true; menuSet(16, "야식", "2", "저장 전 수동메뉴");
      clearTimeout(saveTimer); clearTimeout(cloudTimer); cloudApplying = false;
      cloudDirty = true; window.editDuringSaveEncryption = true;
    });
    await page.evaluate(() => cloudSave(true));
    if (routeError) throw routeError;
    const sentWhileEditing = await page.evaluate(async ({ password, row }) => JSON.parse(await decryptText(password, row.data)), { password, row: remote });
    assert.equal(sentWhileEditing.menus["2026-10"]["16|야식|2"], "저장 전 수동메뉴", "first ciphertext must contain its captured snapshot, not later user edits");
    const inFlight = await page.evaluate(() => ({ local: S.menus["2026-10"]["16|야식|2"], base: cloudMenuBase.menus["2026-10"]["16|야식|2"], headcount: S.menus["2026-10"]["16|야식|n"], meta: S.headcountMeta["2026-10-16|야식"] }));
    assert.equal(inFlight.local, "암호화 중 수동메뉴");
    assert.equal(inFlight.base, "저장 전 수동메뉴", "successful saves must baseline the exact sent snapshot, not mutable live S");
    assert.equal(inFlight.headcount, "399");
    await page.waitForTimeout(50);
    await page.waitForFunction(() => !cloudBusy && !cloudDirty && !recipeMonitor.requesting, { timeout: 5000 });
    const peerUpdate = structuredClone(sentWhileEditing);
    peerUpdate.menus["2026-10"]["16|야식|2"] = "서버 동시 수정 메뉴";
    peerUpdate.menus["2026-10"]["16|야식|n"] = "350";
    peerUpdate.menuPlanMeta["2026-10-16|야식"] = { by: "manual", runId: "later-peer-update" };
    peerUpdate.headcountMeta["2026-10-16|야식"] = { by: "photo-plan", updated: "later-peer-update" };
    remote = await wrap(peerUpdate, new Date(Date.now() + 10000).toISOString());
    await page.evaluate(() => { cloudDirty = true; return cloudSave(true); });
    if (routeError) throw routeError;
    const final = await page.evaluate(async ({ password, row }) => JSON.parse(await decryptText(password, row.data)), { password, row: remote });
    assert.equal(final.menus["2026-10"]["16|야식|2"], "암호화 중 수동메뉴", "an edit made during the prior encryption must beat a later remote overwrite");
    assert.equal(final.menus["2026-10"]["16|야식|n"], "399");
    assert.equal(final.menuPlanMeta["2026-10-16|야식"], undefined, "in-flight manual food edits must not regain AI provenance");
    assert.deepEqual(final.headcountMeta["2026-10-16|야식"], inFlight.meta);
    assert.deepEqual(final.settings, local.settings);
    console.log("CLOUD_MENU_BASELINE / STALE_AI_MENU_SUPPRESSED / RICE_COUNTS_RETAINED / REMOTE_MANUAL_OCT15_16 / MANUAL_EDIT_DELETE_COUNTS / MANUAL_METADATA / CAS_REBASE / LOCAL_SETTINGS / AI_RECIPE_MERGE / IN_FLIGHT_SENT_SNAPSHOT_PASS");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
