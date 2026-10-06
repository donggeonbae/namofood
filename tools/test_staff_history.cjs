// Run with Playwright available through NODE_PATH. All requests are offline mocks.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { chromium } = require("playwright");

async function printedText(page) {
  await page.emulateMedia({ media: "print" });
  const bytes = await page.pdf({ preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
  const pdfjs = await import(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true }).promise;
  const texts = [];
  for (let i = 1; i <= pdf.numPages; i++) texts.push((await (await pdf.getPage(i)).getTextContent()).items.map(item => item.str).join(" "));
  await pdf.destroy();
  await page.emulateMedia({ media: "screen" });
  return texts.join(" ");
}

async function csvText(page) {
  return page.evaluate(async () => {
    const create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = blob => { window.__staffCsv = blob; return "blob:offline-staff-csv"; };
    HTMLAnchorElement.prototype.click = function () {};
    try { csvRoster(); return await window.__staffCsv.text(); }
    finally { URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click; delete window.__staffCsv; }
  });
}

(async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "나모푸드_관리앱.html"), "utf8");
  // Private migration targets are read only at runtime from the ignored app source.
  const namedList = source.match(/for\(const e of state\.staff\|\|\[\]\)if\((\[[^\]]+\])\.includes\(e\.name\)\)e\.wage=20000/);
  assert(namedList, "the private source contains the named wage initialization rule");
  const namedTargets = JSON.parse(namedList[1].replace(/'/g, '"'));
  assert.equal(namedTargets.length, 3, "the private initialization rule has three targets");
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  try {
    const page = await browser.newPage();
    let rejectNextConfirm = false;
    const dialogs = [];
    page.on("dialog", async dialog => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      if (dialog.type() === "confirm" && rejectNextConfirm) { rejectNextConfirm = false; await dialog.dismiss(); }
      else await dialog.accept();
    });
    await page.route("**/*", route => route.request().isNavigationRequest()
      ? route.fulfill({ contentType: "text/html", body: source })
      : route.abort());
    await page.goto("https://offline.namofood.test/");
    await page.evaluate(() => {
      clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer);
      cloud.enabled = false; cloudApplying = true;
      S.month = "2026-10"; S.staffArchive = [];
      S.settings.wage = 9000; S.settings.night = .5; S.settings.burden = .1; S.settings.vacancy = .05;
      S.staff = [
        { id: "history", name: "보관 직원", role: "조리", wage: 12000, bonus: 5000, def: { s: "09:00", e: "18:00", b: 60 }, off: [6] },
        { id: "active", name: "현직 직원", role: "배식", wage: 10000, bonus: 1000, def: { s: "09:00", e: "18:00", b: 60 }, off: [] },
      ];
      S.roster = {
        "2026-09": { "history|2": { s: "23:00", e: "03:00", b: 0 }, "history|adj": 300, "active|3": { s: "09:00", e: "11:00", b: 0 } },
        "2026-10": { "history|1": { s: "22:00", e: "06:00", b: 60 }, "history|2": { s: "09:00", e: "18:00", b: 60 }, "history|8": { s: "00:00", e: "04:00", b: 0 }, "history|9": "연차", "history|adj": 1000, "active|1": { s: "09:00", e: "18:00", b: 60 }, "active|8": { s: "09:00", e: "12:00", b: 0 } },
      };
      go("roster");
    });
    const read = () => page.evaluate(() => laborRows().map(r => ({ id: r.e.id, days: r.daysW, hours: r.h, nightHours: r.nh, wage: r.wage, base: r.base, night: r.night, bonus: r.bonus, adjustment: r.adj, pay: r.pay, total: Math.round(r.total) })).sort((a,b) => a.id.localeCompare(b.id)));
    const weeks = () => page.evaluate(() => [...document.querySelectorAll("table.roster")].map(table => {
      const row = [...table.querySelectorAll("tr")].find(tr => tr.querySelector("td.name")?.textContent.includes("보관 직원"));
      if (!row) return null;
      const dates = [...table.querySelectorAll("th")].slice(1).map(th => Number(th.textContent.match(/^(\d+)일/)?.[1] || 0));
      const cells = [...row.querySelectorAll("td.code")].map(td => td.innerText.trim());
      const sums = dates.filter(Boolean).reduce((sum, day) => { const value = cellHours(rosterGet("history", day)); return { hours: sum.hours + value.h, night: sum.night + value.night }; }, { hours: 0, night: 0 });
      return { dates, cells, ...sums };
    }));
    const month = async value => { await page.evaluate(value => { S.month = value; render(); }, value); };
    const before = await read();
    assert.deepEqual(before.find(r => r.id === "history"), { id: "history", days: 3, hours: 19, nightHours: 11, wage: 12000, base: 228000, night: 66000, bonus: 5000, adjustment: 1000, pay: 300000, total: 345000 });
    const beforeWeeks = await weeks();
    assert.deepEqual(beforeWeeks.map(w => [w.hours, w.night]), [[15, 7], [4, 4], [0, 0], [0, 0], [0, 0]], "weekly hours have an independently known oracle");
    const stable = await page.evaluate(() => ({ roster: structuredClone(S.roster), settings: structuredClone(S.settings), staff: structuredClone(S.staff[0]) }));
    await month("2026-09");
    const september = await read();
    assert.deepEqual(september.find(r => r.id === "history"), { id: "history", days: 1, hours: 4, nightHours: 4, wage: 12000, base: 48000, night: 24000, bonus: 5000, adjustment: 300, pay: 77300, total: 88895 });
    await month("2026-10");
    await page.evaluate(() => staffDel(S.staff.findIndex(e => e.id === "history")));
    assert.deepEqual(await read(), before, "archiving staff must preserve exact historical hours/night/pay/total");
    assert.deepEqual(await weeks(), beforeWeeks, "every weekly shift and weekly hours survive archive");
    const archived = await page.evaluate(() => ({ roster: structuredClone(S.roster), settings: structuredClone(S.settings), staff: findStaff("history"), active: S.staff.map(e => e.id), archive: S.staffArchive.map(e => e.id) }));
    assert.deepEqual(archived.roster, stable.roster, "archive cannot edit any month's roster");
    assert.deepEqual(archived.settings, stable.settings, "archive cannot change global payroll rules");
    for (const key of ["id", "name", "role", "wage", "bonus", "def", "off"]) assert.deepEqual(archived.staff[key], stable.staff[key], "preserved staff field " + key);
    assert(!archived.active.includes("history") && archived.archive.includes("history"), "staff management excludes archived staff without losing their identity");
    assert.equal(await page.locator('input[placeholder="이름"]').count(), 1, "only active staff have editable staff-management rows");
    const csv = await csvText(page);
    const csvHistory = csv.split(/\r?\n/).find(line => line.includes("보관 직원"));
    assert(csvHistory, "actual CSV contains archived employee");
    const csvHeaders = csv.split(/\r?\n/)[0].split(","), csvFields = csvHistory.split(",");
    assert.deepEqual(["출근일", "실근로h", "야간h", "지급총액", "총인건비"].map(column => csvFields[csvHeaders.indexOf(column)]), ["3", "19.0", "11.0", "300000", "345000"], "CSV retains exact payroll and hours");
    assert.equal(csvFields[csvHeaders.indexOf("직원상태")], "보관", "CSV distinguishes archived employees");
    const print = await printedText(page);
    assert(print.includes("보관 직원") && print.includes("345,000원") && print.includes("472,650원"), "actual PDF includes archived employee's payroll and the unchanged monthly total");
    await month("2026-09");
    assert.deepEqual(await read(), september, "previous-month payroll survives archive");
    await month("2026-10");
    await page.evaluate(() => save());
    await page.waitForFunction(() => JSON.parse(localStorage.getItem(KEY) || "{}").staffArchive?.some(e => e.id === "history"));
    await page.reload();
    await page.evaluate(() => { clearInterval(cloudPollTimer); clearTimeout(cloudTimer); cloudApplying = true; S.month = "2026-10"; go("roster"); });
    assert.deepEqual(await read(), before, "reload preserves archived staff and historical payroll");
    assert.deepEqual(await weeks(), beforeWeeks, "reload preserves weekly cells and hours");

    await page.evaluate(() => {
      S.month = "2026-11";
      S.roster[S.month] = { "active|1": { s: "12:00", e: "14:00", b: 0 }, "history|15": { s: "18:00", e: "21:00", b: 0 } };
      S.roster["2026-10"]["active|31"] = { s: "13:00", e: "15:00", b: 0 };
      copyRosterMonth();
    });
    const copied = await page.evaluate(() => structuredClone(S.roster[S.month]));
    assert.deepEqual(copied["active|1"], { s: "12:00", e: "14:00", b: 0 }, "last-month copy cannot overwrite existing manual shifts");
    assert.deepEqual(copied["active|8"], { s: "09:00", e: "12:00", b: 0 }, "active employee's prior empty slot is copied");
    assert.deepEqual(copied["history|15"], { s: "18:00", e: "21:00", b: 0 }, "copy preserves pre-existing archived history");
    assert.deepEqual(Object.keys(copied).filter(k => k.startsWith("history|")), ["history|15"], "copy cannot generate archived shifts in a new month");
    assert(!Object.hasOwn(copied, "active|31"), "copy cannot create dates outside the destination month");
    await page.evaluate(() => fillDefault());
    assert.deepEqual(await page.evaluate(() => Object.keys(S.roster[S.month]).filter(k => k.startsWith("history|"))), ["history|15"], "default fill cannot create any archived shifts");
    await page.evaluate(() => { S.month = "2026-12"; S.roster[S.month] = {}; render(); });
    assert.deepEqual(await read(), [], "a month with no actual shifts has no payroll rows, even for active staff");
    await page.evaluate(() => fillDefault());
    assert.deepEqual(await page.evaluate(() => rosterStaff().map(e => e.id)), ["active"], "archived employee without monthly history is absent from new roster");
    assert.equal(await page.evaluate(() => Object.keys(S.roster[S.month]).some(k => k.startsWith("history|"))), false, "blank-month fill only creates active staff shifts");

    await month("2026-10");
    const cellBefore = await page.evaluate(() => structuredClone(S.roster[S.month]));
    const firstDayColumn = await page.locator("table.roster").first().evaluate(table => [...table.querySelectorAll("th")].slice(1).findIndex(th => th.textContent.startsWith("1일")));
    await page.locator("table.roster").first().locator("tr").filter({ hasText: "보관 직원" }).locator("td.code").nth(firstDayColumn).click();
    await page.getByRole("button", { name: "지우기", exact: true }).click();
    const cellAfter = await page.evaluate(() => structuredClone(S.roster[S.month]));
    delete cellBefore["history|1"];
    assert.deepEqual(cellAfter, cellBefore, "explicit picker deletion removes only the selected historical shift");
    const deleted = (await read()).find(r => r.id === "history");
    assert.deepEqual([deleted.days, deleted.hours, deleted.nightHours, deleted.pay, deleted.total], [2, 12, 4, 174000, 200100], "explicit shift deletion updates payroll by the independently known amount");
    await page.evaluate(() => { rosterSet("history", 1, { s: "22:00", e: "06:00", b: 60 }); render(); });
    assert.deepEqual((await read()).find(r => r.id === "history"), before.find(r => r.id === "history"), "explicit re-entry restores historical payroll");
    await page.evaluate(() => staffRestore("history"));
    assert.equal(await page.evaluate(() => S.staff.filter(e => e.id === "history").length), 1, "restore reactivates exactly one matching employee");
    assert.equal(await page.evaluate(() => S.staffArchive.some(e => e.id === "history")), false, "restore removes duplicate archive entry");
    assert.deepEqual((await read()).find(r => r.id === "history"), before.find(r => r.id === "history"), "restore cannot rewrite payroll");

    await page.evaluate(() => {
      const incoming = structuredClone(S);
      incoming.staff = incoming.staff.filter(e => e.id !== "history"); incoming.staffArchive = [];
      incoming.roster["2026-10"]["orphan|4"] = { s: "01:00", e: "07:00", b: 0 };
      incoming.roster["2026-10"]["orphan|5"] = "확인 필요한 옛 코드";
      applyState(incoming); render();
    });
    const orphan = await page.evaluate(() => ({ employee: findStaff("orphan"), cells: structuredClone(S.roster["2026-10"]), row: laborRows().find(r => r.e.id === "orphan") }));
    assert(orphan.employee && orphan.row, "orphan roster ID remains visible through a placeholder employee");
    assert.deepEqual(orphan.cells["orphan|4"], { s: "01:00", e: "07:00", b: 0 }, "orphan real-time shift is preserved");
    assert.equal(orphan.cells["orphan|5"], "확인 필요한 옛 코드", "unknown legacy shift strings cannot be silently erased by normalization");
    assert.deepEqual([orphan.row.h, orphan.row.nh], [6, 5], "orphan hours remain measurable without inventing original payroll metadata");
    await page.evaluate(() => {
      S.month = "2027-01";
      S.staffArchive.push({ id: "idleArchive", name: "무근무 보관직원", wage: 20000, bonus: 9999, def: { s: "09:00", e: "18:00", b: 60 }, off: [] });
      S.roster[S.month] = { "active|1": "휴", "active|3": { s: "09:00", e: "09:00", b: 0 }, "active|4": { s: "09:00", e: "10:00", b: 60 }, "idleArchive|2": "연차", "idleArchive|3": { s: "22:00", e: "22:00", b: 0 }, "idleArchive|adj": 5000 };
      render();
    });
    assert.deepEqual(await read(), [], "leave, adjustment, and zero-hour active/archived shifts cannot create attendance, bonuses, or payroll rows");
    const emptyCsv = await csvText(page);
    assert(!emptyCsv.includes("현직 직원") && !emptyCsv.includes("무근무 보관직원"), "no-work staff are excluded from payroll CSV");
    const payrollText = await page.evaluate(() => [...document.querySelectorAll(".card")].find(card => card.querySelector("h2")?.textContent.startsWith("직원별 인건비"))?.textContent);
    assert(payrollText && !payrollText.includes("현직 직원") && !payrollText.includes("무근무 보관직원"), "no-work staff are excluded from the payroll table");
    await page.evaluate(() => { rosterSet("active", 5, { s: "09:00", e: "11:00", b: 0 }); render(); });
    const positiveWithZero = (await read()).find(row => row.id === "active");
    assert.deepEqual([positiveWithZero.days, positiveWithZero.hours, positiveWithZero.bonus, positiveWithZero.pay], [1, 2, 1000, 21000], "zero-hour cells cannot inflate a positive employee's attendance or payroll");

    const cloudResult = await page.evaluate(() => {
      S.month = "2026-10";
      const active = { id: "syncActive", name: "동기 현직", wage: 11000, bonus: 0, def: { s: "09:00", e: "18:00", b: 60 }, off: [] };
      const former = { id: "syncFormer", name: "동기 보관", wage: 14000, bonus: 500, def: { s: "22:00", e: "06:00", b: 60 }, off: [] };
      const original = { s: "09:00", e: "18:00", b: 60 }, manual = { s: "10:00", e: "17:00", b: 30 };
      S.staff = [active, former]; S.staffArchive = [];
      S.roster = { "2026-10": { "syncActive|1": original, "syncActive|2": original, "syncFormer|4": original } }; S.rosterEdits = {};
      cloudStaffBase = captureCloudStaffBase(S);
      const remote = structuredClone(S);
      rosterSet("syncActive", 1, manual); rosterSet("syncActive", 2, "");
      remote.staff = [active]; remote.staffArchive = [{ ...former, archivedAt: new Date().toISOString() }];
      remote.roster["2026-10"]["syncActive|3"] = { s: "23:00", e: "03:00", b: 0 };
      delete remote.roster["2026-10"]["syncFormer|4"];
      remote.rosterEdits = { "2026-10": { "syncFormer|4": { at: new Date().toISOString(), deleted: true } } };
      mergeRemoteStaffHistory(remote);
      const merged = structuredClone({ staff: S.staff, staffArchive: S.staffArchive, roster: S.roster, rosterEdits: S.rosterEdits });
      cloudStaffBase = captureCloudStaffBase(S);
      const stale = structuredClone(S);
      rosterSet("syncActive", 2, { s: "12:00", e: "16:00", b: 0 });
      mergeRemoteStaffHistory(stale);
      const reentered = structuredClone({ roster: S.roster, rosterEdits: S.rosterEdits });
      const prior = structuredClone(S), incoming = structuredClone(S);
      incoming.staffArchive = []; incoming.roster = { "2026-10": {} }; incoming.rosterEdits = {};
      preserveRosterHistory(incoming, prior);
      const missingPreserved = structuredClone({ roster: incoming.roster, archive: incoming.staffArchive });
      const explicitlyDeleted = structuredClone(prior);
      delete explicitlyDeleted.roster["2026-10"]["syncActive|3"];
      explicitlyDeleted.rosterEdits["2026-10"]["syncActive|3"] = { at: new Date(Date.now() + 1000).toISOString(), deleted: true };
      applyState(explicitlyDeleted);
      const imported = structuredClone({ roster: S.roster, rosterEdits: S.rosterEdits });
      const beforeClear = structuredClone(S);
      clearRoster();
      const cleared = structuredClone({ roster: S.roster, rosterEdits: S.rosterEdits });
      applyState(beforeClear);
      return { merged, reentered, missingPreserved, priorRoster: prior.roster, imported, cleared, afterStaleImport: structuredClone(S.roster) };
    });
    assert.deepEqual(cloudResult.merged.roster["2026-10"]["syncActive|1"], { s: "10:00", e: "17:00", b: 30 }, "stale cloud save preserves local shift edit");
    assert(!Object.hasOwn(cloudResult.merged.roster["2026-10"], "syncActive|2"), "stale cloud save cannot resurrect an explicitly deleted local shift");
    assert.deepEqual(cloudResult.merged.roster["2026-10"]["syncActive|3"], { s: "23:00", e: "03:00", b: 0 }, "remote newly entered shift survives a stale local save");
    assert(!Object.hasOwn(cloudResult.merged.roster["2026-10"], "syncFormer|4"), "remote explicit deletion marker is respected");
    assert(cloudResult.merged.staffArchive.some(e => e.id === "syncFormer") && !cloudResult.merged.staff.some(e => e.id === "syncFormer"), "remote employee archive transition is retained");
    assert.deepEqual(cloudResult.reentered.roster["2026-10"]["syncActive|2"], { s: "12:00", e: "16:00", b: 0 }, "manual re-entry wins over stale deletion snapshot");
    assert.equal(cloudResult.reentered.rosterEdits["2026-10"]["syncActive|2"].deleted, false, "re-entry clears the local deletion marker");
    assert.deepEqual(cloudResult.missingPreserved.roster, cloudResult.priorRoster, "load/import/restore missing cells cannot delete historical shifts");
    assert(cloudResult.missingPreserved.archive.some(e => e.id === "syncFormer"), "missing import metadata preserves historical employee identity");
    assert(!Object.hasOwn(cloudResult.imported.roster["2026-10"], "syncActive|3"), "incoming explicit deletion is respected during applyState");
    assert.deepEqual(cloudResult.cleared.roster["2026-10"], {}, "explicit whole-month clear still deletes all selected-month shifts");
    assert(Object.values(cloudResult.cleared.rosterEdits["2026-10"]).every(edit => edit.deleted), "whole-month clear records explicit tombstones");
    assert.deepEqual(cloudResult.afterStaleImport["2026-10"], {}, "stale import cannot resurrect a month explicitly cleared in the roster");
    await page.evaluate(() => {
      S.staffArchive = Array.from({ length: 13 }, (_, i) => ({ id: "page-" + (i + 1), name: "검색 직원 " + String(i + 1).padStart(2, "0"), role: i === 12 ? "특수배식" : "조리", wage: 15000, bonus: 0, def: { s: "09:00", e: "18:00", b: 60 }, off: [] }));
      S.staffArchive.push({ id: "page-alias", name: "복구 이름", role: "배식", historyNames: ["옛 별칭"], wage: 16000, bonus: 0, def: { s: "09:00", e: "18:00", b: 60 }, off: [] });
      staffArchiveOpen = false; staffArchiveSearch = ""; staffArchivePage = 1; render();
    });
    const directory = page.locator("details#staffArchive");
    assert.equal(await directory.evaluate(element => element.open), false, "archive directory starts collapsed");
    await directory.locator("summary").click();
    const restoreButtons = () => directory.getByRole("button", { name: "명단으로 복귀", exact: true });
    const pageIds = () => restoreButtons().evaluateAll(buttons => buttons.map(button => JSON.parse(button.getAttribute("onclick").match(/staffRestore\(([^)]+)\)/)[1])));
    assert.equal(await restoreButtons().count(), 10, "archive directory shows ten employees per page");
    const firstPage = await pageIds();
    await directory.getByRole("button", { name: /다음/ }).click();
    assert.equal(await restoreButtons().count(), 4, "second archive page shows the remaining four employees");
    assert((await pageIds()).every(id => !firstPage.includes(id)), "archive pagination does not repeat first-page employees");
    await directory.getByRole("button", { name: /이전/ }).click();
    assert.deepEqual(await pageIds(), firstPage, "previous-page navigation returns the original employees");
    const search = directory.locator("#staffArchiveSearch");
    for (const [query, id] of [["검색 직원 03", "page-3"], ["특수배식", "page-13"], ["옛 별칭", "page-alias"]]) {
      await search.fill(query);
      assert.deepEqual(await pageIds(), [id], "archive search matches name, role, or historical alias: " + query);
    }
    await search.fill("");
    assert.equal(await restoreButtons().count(), 10, "clearing archive search resets pagination");
    await directory.getByRole("button", { name: /다음/ }).click();
    const selectedId = (await pageIds())[0];
    await restoreButtons().first().click();
    const restoredFromPage = await page.evaluate(id => ({ active: S.staff.filter(e => e.id === id).length, archive: S.staffArchive.filter(e => e.id === id).length }), selectedId);
    assert.deepEqual(restoredFromPage, { active: 1, archive: 0 }, "second-page restore targets the selected employee ID, not the first page index");

    const staleActive = await page.evaluate(() => {
      S.month = "2026-11"; S.staffArchive = []; S.staffEdits = {}; S.rosterEdits = {};
      S.staff = [{ id: "restart", name: "재시작 직원", role: "조리", wage: 13000, bonus: 777, def: { s: "09:00", e: "18:00", b: 60 }, off: [] }];
      S.roster = { "2026-11": { "restart|1": { s: "22:00", e: "06:00", b: 60 } } }; cloudStaffBase = null; render();
      return structuredClone(S);
    });
    const restartPay = await read();
    await page.evaluate(() => { staffDel(0); save(); });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem(KEY) || "{}").staffEdits?.restart?.status === "archive");
    const restart = async () => {
      await page.reload();
      await page.evaluate(() => { clearInterval(cloudPollTimer); clearTimeout(cloudTimer); cloud.enabled = false; cloudApplying = true; S.month = "2026-11"; go("roster"); });
      assert.equal(await page.evaluate(() => cloudStaffBase), null, "restart begins without a cloud merge baseline");
    };
    await restart();
    await page.evaluate(remote => { mergeRemoteStaffHistory(remote); render(); }, staleActive);
    assert.deepEqual(await page.evaluate(() => ({ active: S.staff.map(e => e.id), archive: S.staffArchive.map(e => e.id), status: S.staffEdits.restart.status })), { active: [], archive: ["restart"], status: "archive" }, "persisted archive intent survives stale remote active state after restart");
    assert.deepEqual(await read(), restartPay, "restart/remerge retains exact archived payroll");
    const staleArchive = await page.evaluate(() => structuredClone(S));
    await page.evaluate(() => { staffRestore("restart"); save(); });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem(KEY) || "{}").staffEdits?.restart?.status === "active");
    await restart();
    await page.evaluate(remote => { mergeRemoteStaffHistory(remote); render(); }, staleArchive);
    assert.deepEqual(await page.evaluate(() => ({ active: S.staff.map(e => e.id), archive: S.staffArchive.map(e => e.id), status: S.staffEdits.restart.status })), { active: ["restart"], archive: [], status: "active" }, "persisted restore intent survives stale remote archive state after restart");
    assert.deepEqual(await read(), restartPay, "restore/remerge cannot change historical pay");

    await page.evaluate(() => {
      // October's first week contains days 1-4, so the snapshot oracle fits one real week.
      S.month = "2026-10"; S.staffEdits = {}; S.rosterEdits = {};
      const employee = id => ({ id, name: id === "bulkA" ? "일괄 현직" : "일괄 보관", role: "조리", wage: 10000, bonus: 0, def: { s: "09:00", e: "18:00", b: 60 }, off: [] });
      S.staff = [employee("bulkA")]; S.staffArchive = [{ ...employee("bulkB"), archivedAt: new Date().toISOString() }];
      S.roster = { "2026-09": { "bulkA|30": { s: "22:00", e: "06:00", b: 60 }, "bulkB|30": "휴" }, "2026-10": { "bulkA|1": { s: "09:00", e: "11:00", b: 0 }, "bulkA|2": { s: "12:00", e: "15:00", b: 0 }, "bulkA|3": { s: "09:00", e: "09:00", b: 0 }, "bulkA|5": { s: "17:00", e: "19:00", b: 0 }, "bulkB|4": { s: "00:00", e: "05:00", b: 0 } } };
      toggleRosterBulk(false); go("roster");
    });
    const protectedData = () => page.evaluate(() => structuredClone({ roster: S.roster, edits: S.rosterEdits, staff: S.staff, archive: S.staffArchive, settings: S.settings }));
    const selectedKeys = () => page.evaluate(() => [...rosterBulk.selected].sort());
    const checkCell = (id, day) => page.locator(`input.roster-bulk-check[data-staff="${id}"][data-day="${day}"]`).check();
    const setBulkTime = async (start, end, rest) => {
      await page.locator("#rb_s_h").selectOption(start.slice(0, 2)); await page.locator("#rb_s_m").selectOption(start.slice(3));
      await page.locator("#rb_e_h").selectOption(end.slice(0, 2)); await page.locator("#rb_e_m").selectOption(end.slice(3));
      await page.locator("#rb_b").fill(String(rest));
    };
    await page.locator('button[data-roster-bulk-week="0"]').click();
    await checkCell("bulkA", 1); await checkCell("bulkA", 2);
    assert.deepEqual(await selectedKeys(), ["bulkA|1", "bulkA|2"], "real checkboxes select only the requested staff/day IDs");
    const beforeBulk = await protectedData();
    const apply = page.getByRole("button", { name: "선택 칸에 시간 적용", exact: true });
    for (const [start, end, rest] of [["09:00", "09:00", 0], ["09:00", "10:00", 60], ["09:00", "18:00", -5]]) {
      await setBulkTime(start, end, rest); const dialogCount = dialogs.length; await apply.click();
      assert(dialogs.length > dialogCount && dialogs.at(-1).type === "alert", "invalid bulk time is explicitly rejected");
      assert.deepEqual(await protectedData(), beforeBulk, "zero actual hours or negative break cannot mutate selected or unrelated history");
      assert.deepEqual(await selectedKeys(), ["bulkA|1", "bulkA|2"], "validation failure preserves the user's selection");
    }
    await setBulkTime("22:00", "06:00", 60); rejectNextConfirm = true;
    await apply.click();
    assert.equal(rejectNextConfirm, false, "overwrite path really asked for confirmation");
    assert.deepEqual(await protectedData(), beforeBulk, "canceling overwrite is fully non-mutating, including deletion/edit markers");
    assert.deepEqual(await selectedKeys(), ["bulkA|1", "bulkA|2"], "canceling overwrite preserves selection");
    await apply.click();
    const afterBulk = await protectedData();
    const expectedBulk = structuredClone(beforeBulk);
    for (const key of ["bulkA|1", "bulkA|2"]) expectedBulk.roster["2026-10"][key] = { s: "22:00", e: "06:00", b: 60 };
    assert.deepEqual(afterBulk.roster, expectedBulk.roster, "overnight bulk input changes only selected cells across all months");
    assert.deepEqual([afterBulk.staff, afterBulk.archive, afterBulk.settings], [beforeBulk.staff, beforeBulk.archive, beforeBulk.settings], "bulk edits cannot alter staff metadata or payroll settings");
    assert.deepEqual(Object.keys(afterBulk.edits["2026-10"]).sort(), ["bulkA|1", "bulkA|2"], "bulk input records only selected-cell edit markers");
    assert(Object.values(afterBulk.edits["2026-10"]).every(edit => edit.deleted === false), "bulk input creates re-entry markers, not deletions");
    assert.deepEqual(await selectedKeys(), [], "successful apply clears selection");
    await page.evaluate(() => {
      S.roster["2026-10"]["bulkA|1"] = { s: "09:00", e: "11:00", b: 0 };
      S.roster["2026-10"]["bulkA|2"] = { s: "12:00", e: "15:00", b: 0 }; S.rosterEdits = {}; render();
    });
    for (const [id, day] of [["bulkA", 1], ["bulkA", 2], ["bulkA", 3], ["bulkA", 4], ["bulkB", 1], ["bulkB", 2]]) await checkCell(id, day);
    const beforePrevious = await protectedData();
    await page.getByRole("button", { name: "각 칸에 전날 근무시간 적용", exact: true }).click();
    const afterPrevious = await protectedData(), expectedPrevious = structuredClone(beforePrevious.roster);
    expectedPrevious["2026-10"]["bulkA|1"] = beforePrevious.roster["2026-09"]["bulkA|30"];
    expectedPrevious["2026-10"]["bulkA|2"] = beforePrevious.roster["2026-10"]["bulkA|1"];
    expectedPrevious["2026-10"]["bulkA|3"] = beforePrevious.roster["2026-10"]["bulkA|2"];
    assert.deepEqual(afterPrevious.roster, expectedPrevious, "previous-day copy crosses the month boundary, uses the old snapshot, skips leave/missing/zero-hour sources, and protects all unselected cells");
    assert.deepEqual(Object.keys(afterPrevious.edits["2026-10"]).sort(), ["bulkA|1", "bulkA|2", "bulkA|3"], "skipped selections do not create edit markers");
    await page.getByRole("checkbox", { name: "일괄 현직 1주 전체 선택", exact: true }).check();
    assert.deepEqual(await selectedKeys(), ["bulkA|1", "bulkA|2", "bulkA|3", "bulkA|4"], "employee group selects only valid dates in the active week");
    await page.getByRole("button", { name: "선택 해제", exact: true }).click();
    await page.getByRole("checkbox", { name: "2일 전체 선택", exact: true }).check();
    assert.deepEqual(await selectedKeys(), ["bulkA|2", "bulkB|2"], "day group includes the visible archived employee without extra dates");
    await page.getByRole("button", { name: "선택 해제", exact: true }).click();
    await page.getByRole("button", { name: "이 주 전체 선택/해제", exact: true }).click();
    assert.deepEqual(await selectedKeys(), ["bulkA|1", "bulkA|2", "bulkA|3", "bulkA|4", "bulkB|1", "bulkB|2", "bulkB|3", "bulkB|4"], "first October week selects only its four valid dates");
    const beforeMonthSwitch = await protectedData();
    await month("2026-12");
    assert.deepEqual(await selectedKeys(), [], "changing month resets bulk selection");
    assert.deepEqual(await protectedData(), beforeMonthSwitch, "selection and month navigation cannot change history");

    const initialRolePay = await page.evaluate(namedTargets => {
      S.month = "2026-11"; S.staffEdits = {}; S.rosterEdits = {}; S.settings.roleWages = {}; delete S.settings.rolePayInitialized;
      const employee = (id, name, role) => ({ id, name, role, wage: null, bonus: 0, def: { s: "09:00", e: "18:00", b: 60 }, off: [] });
      S.staff = [employee("name-1", namedTargets[0], "총괄"), employee("name-2", namedTargets[1], "참모"), employee("name-3", namedTargets[2], ""), employee("legacy-cook", "역할 조리 직원", "참모"), employee("legacy-empty", "역할 보조 직원", "")];
      S.staffArchive = [{ ...employee("legacy-archive", "기존 보관 시급", "참모"), archivedAt: new Date().toISOString() }, { ...employee("same-name-archive", namedTargets[0], "조리"), wage: 11000, archivedAt: new Date().toISOString() }];
      S.roster = { "2026-11": { "legacy-archive|1": { s: "09:00", e: "11:00", b: 0 } } };
      const oldArchiveWage = staffWage(S.staffArchive[0]);
      initializeStaffPay(S); toggleRosterBulk(false); go("roster");
      return { roles: staffRoles(), wages: structuredClone(S.settings.roleWages), staff: structuredClone(S.staff), archiveWage: staffWage(S.staffArchive[0]), oldArchiveWage, sameNameArchivedWage: staffWage(findStaff("same-name-archive")) };
    }, namedTargets);
    assert.deepEqual(initialRolePay.roles, ["총괄", "조리", "보조", "이송"], "first migration installs the four requested editable roles");
    assert.deepEqual(initialRolePay.wages, { "총괄": 15000, "조리": 15000, "보조": 13000, "이송": 13000 }, "requested role wage defaults are exact");
    assert(initialRolePay.staff.filter(e => e.id.startsWith("name-")).every(e => e.wage === 20000), "the three named employees receive the one-time 20,000 won personal wage");
    assert.equal(initialRolePay.staff.find(e => e.id === "legacy-cook").role, "조리", "legacy 참모 migrates to 조리");
    assert.equal(initialRolePay.staff.find(e => e.id === "legacy-empty").role, "보조", "empty role migrates to 보조");
    assert.equal(initialRolePay.archiveWage, initialRolePay.oldArchiveWage, "role migration cannot retroactively change archived effective wage");
    assert.equal(initialRolePay.sameNameArchivedWage, 11000, "the named active employee migration cannot overwrite an archived employee with the same name");
    const namedSelector = await page.evaluate(name => `input[placeholder="이름"][value="${CSS.escape(name)}"]`, namedTargets[0]);
    const namedRow = page.locator('tr').filter({ has: page.locator(namedSelector) });
    // moneyify changes number inputs to decimal text inputs after rendering.
    await namedRow.locator('input[placeholder^="역할"]').fill("21000");
    await namedRow.locator('input[placeholder^="역할"]').blur();
    await page.evaluate(() => { initializeStaffPay(S); save(); });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem(KEY) || "{}").staff?.find(e => e.id === "name-1")?.wage === 21000);
    await restart();
    assert.equal(await page.evaluate(() => findStaff("name-1").wage), 21000, "later personal wage edits survive reinitialization and real reload");
    await page.evaluate(() => staffRoleAdd("검수", 17500));
    assert(await page.evaluate(() => staffRoles().includes("검수")), "adding a role makes it available to employee role selection");
    const roleSettings = page.locator("details#staffRoleSettings");
    if (!await roleSettings.evaluate(element => element.open)) await roleSettings.locator("summary").click();
    const customRate = page.locator('input[data-role-wage="검수"]');
    await customRate.fill("18000"); await customRate.blur();
    assert.equal(await page.evaluate(() => S.settings.roleWages["검수"]), 18000, "a custom role's default wage is editable through the real input");
    await page.evaluate(() => {
      findStaff("legacy-empty").role = "검수";
      S.staff.push({ id: "custom-archive", name: "검수 보관 직원", role: "검수", wage: null, bonus: 0, def: { s: "09:00", e: "18:00", b: 60 }, off: [] });
      S.roster["2026-11"]["custom-archive|2"] = { s: "22:00", e: "06:00", b: 60 };
      staffDel(S.staff.findIndex(e => e.id === "custom-archive"));
    });
    assert.equal(await page.evaluate(() => staffWage(findStaff("custom-archive"))), 18000, "archiving freezes a role-derived effective wage");
    const beforeRoleDelete = await page.evaluate(() => structuredClone({ staff: S.staff, archive: S.staffArchive, settings: S.settings, roster: S.roster, staffEdits: S.staffEdits }));
    await page.evaluate(() => staffRoleDelete("검수"));
    assert.deepEqual(await page.evaluate(() => structuredClone({ staff: S.staff, archive: S.staffArchive, settings: S.settings, roster: S.roster, staffEdits: S.staffEdits })), beforeRoleDelete, "deleting an in-use role without a replacement is non-mutating");
    await page.evaluate(() => staffRoleDelete("검수", "보조"));
    const movedRole = await page.evaluate(() => ({ roles: staffRoles(), activeRole: findStaff("legacy-empty").role, activeWage: staffWage(findStaff("legacy-empty")), archiveRole: findStaff("custom-archive").role, archiveWage: staffWage(findStaff("custom-archive")), roster: structuredClone(S.roster), namedWage: findStaff("name-1").wage }));
    assert(!movedRole.roles.includes("검수"), "deleted role is removed from the selectable catalogue");
    assert.deepEqual([movedRole.activeRole, movedRole.activeWage, movedRole.archiveRole, movedRole.archiveWage, movedRole.namedWage], ["보조", 18000, "보조", 18000, 21000], "role deletion moves active and archived staff while freezing their prior effective wages and preserving unrelated personal overrides");
    assert.deepEqual(movedRole.roster, beforeRoleDelete.roster, "role changes cannot alter any historical shift");

    // Optional offline mutation: restoring the old missing-role-merge defect must fail.
    if (process.env.NMF_TEST_ROLE_PAY_NEGATIVE_CONTROL === "1") await page.evaluate(() => { mergeRolePaySettings = () => {}; });
    const readRolePay = () => page.evaluate(() => structuredClone({ roles: S.settings.staffRoles, wages: S.settings.roleWages, initialized: S.settings.rolePayInitialized, at: S.settings.rolePayEditedAt }));
    const cloudRoleFixture = await page.evaluate(() => {
      S.month = "2026-11"; S.staffEdits = {}; S.staffFieldEdits = {}; S.rosterEdits = {};
      S.settings.staffRoles = ["총괄", "조리", "보조", "이송"];
      S.settings.roleWages = { "총괄": 15000, "조리": 15000, "보조": 13000, "이송": 13000 };
      S.settings.rolePayInitialized = true; S.settings.rolePayEditedAt = new Date(Date.now() - 60000).toISOString();
      S.staff = [{ id: "multi-device", name: "동기화 시급 직원", role: "조리", wage: 15000, bonus: 0, def: { s: "09:00", e: "18:00", b: 60 }, off: [] }];
      S.staffArchive = [{ id: "multi-archive", name: "동기화 보관 직원", role: "보조", wage: null, archivedWage: 17000, archivedAt: new Date().toISOString(), bonus: 0, def: { s: "09:00", e: "18:00", b: 60 }, off: [] }];
      S.roster = { "2026-11": { "multi-device|1": { s: "22:00", e: "06:00", b: 60 }, "multi-archive|2": { s: "09:00", e: "11:00", b: 0 } } };
      cloudStaffBase = captureCloudStaffBase(S);
      const remote = structuredClone(S);
      remote.settings.staffRoles.push("검수"); remote.settings.roleWages["검수"] = 17500;
      remote.settings.roleWages["조리"] = 18500;
      remote.settings.rolePayEditedAt = new Date(Date.now() - 30000).toISOString();
      S.notes = "동기화 때 보존할 로컬 메모";
      return { remote, roster: structuredClone(S.roster), archiveWage: staffWage(findStaff("multi-archive")) };
    });
    await page.evaluate(remote => { mergeRemoteStaffHistory(remote); render(); }, cloudRoleFixture.remote);
    assert.deepEqual(await readRolePay(), { roles: cloudRoleFixture.remote.settings.staffRoles, wages: cloudRoleFixture.remote.settings.roleWages, initialized: true, at: cloudRoleFixture.remote.settings.rolePayEditedAt }, "a stale page saving an unrelated note must preserve the server's newly added roles and rates");
    assert.equal(await page.evaluate(() => S.notes), "동기화 때 보존할 로컬 메모", "remote role configuration cannot overwrite unrelated local notes");
    assert.deepEqual(await page.evaluate(() => structuredClone(S.roster)), cloudRoleFixture.roster, "role configuration synchronization cannot edit any shift");
    assert.equal(await page.evaluate(() => staffWage(findStaff("multi-archive"))), cloudRoleFixture.archiveWage, "server role rate changes cannot rewrite frozen archived wage");
    const staleRoleConfig = await page.evaluate(() => { cloudStaffBase = captureCloudStaffBase(S); return structuredClone(S); });
    await page.evaluate(() => { setRoleWage("조리", 19000); staffRoleAdd("운영", 16000); });
    const localRolePay = await readRolePay();
    await page.evaluate(remote => mergeRemoteStaffHistory(remote), staleRoleConfig);
    assert.deepEqual(await readRolePay(), localRolePay, "local role addition and wage edit win over an older server configuration");
    const stalePersonal = await page.evaluate(() => structuredClone(S));
    await page.evaluate(() => { setStaffField("multi-device", "wage", 23000); setStaffField("multi-device", "role", "운영"); save(); });
    await page.waitForFunction(() => {
      const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
      return saved.staff?.find(e => e.id === "multi-device")?.wage === 23000 && saved.staffFieldEdits?.["multi-device"]?.wage?.at && saved.staffFieldEdits?.["multi-device"]?.role?.at;
    });
    await restart();
    const personalEdits = await page.evaluate(() => structuredClone(S.staffFieldEdits["multi-device"]));
    await page.evaluate(remote => { mergeRemoteStaffHistory(remote); render(); }, stalePersonal);
    assert.deepEqual(await page.evaluate(() => ({ role: findStaff("multi-device").role, wage: findStaff("multi-device").wage, edits: S.staffFieldEdits["multi-device"] })), { role: "운영", wage: 23000, edits: personalEdits }, "restart without a baseline preserves newer local role/wage values and their persisted field timestamps");
    await page.evaluate(remote => { applyState(remote); render(); }, stalePersonal);
    assert.deepEqual(await page.evaluate(() => ({ role: findStaff("multi-device").role, wage: findStaff("multi-device").wage, edits: S.staffFieldEdits["multi-device"] })), { role: "운영", wage: 23000, edits: personalEdits }, "loading an older state cannot overwrite newer local personal role/wage edits");
    assert.deepEqual(await readRolePay(), localRolePay, "stale state load preserves the latest local role configuration too");
    const newerPersonal = await page.evaluate(() => {
      const remote = structuredClone(S), employee = remote.staff.find(e => e.id === "multi-device");
      employee.wage = 24000; employee.role = "조리";
      const at = new Date(Math.max(Date.parse(S.staffFieldEdits[employee.id].wage.at), Date.parse(S.staffFieldEdits[employee.id].role.at)) + 5000).toISOString();
      remote.staffFieldEdits[employee.id] = { wage: { at }, role: { at } };
      return remote;
    });
    await page.evaluate(remote => { mergeRemoteStaffHistory(remote); render(); }, newerPersonal);
    assert.deepEqual(await page.evaluate(() => ({ role: findStaff("multi-device").role, wage: findStaff("multi-device").wage, edits: S.staffFieldEdits["multi-device"] })), { role: "조리", wage: 24000, edits: newerPersonal.staffFieldEdits["multi-device"] }, "a genuinely newer remote personal edit is not blocked by an older local timestamp");
    await page.evaluate(() => setStaffField("multi-device", "wage", null));
    await page.evaluate(remote => { mergeRemoteStaffHistory(remote); applyState(remote); render(); }, newerPersonal);
    assert.deepEqual(await page.evaluate(() => ({ stored: findStaff("multi-device").wage, effective: staffWage(findStaff("multi-device")) })), { stored: null, effective: 19000 }, "explicitly clearing a personal override is preserved against an older nonempty wage and uses the current role rate");
    assert.deepEqual(await page.evaluate(() => structuredClone(S.roster)), cloudRoleFixture.roster, "all multi-device salary scenarios preserve the full historical roster");
    assert.equal(await page.evaluate(() => staffWage(findStaff("multi-archive"))), 17000, "all multi-device edits preserve archived salary");

    // Revert only either legacy normalization gate in a disposable browser context.
    if (process.env.NMF_TEST_LEGACY_PAY_NEGATIVE_CONTROL === "save") await page.evaluate(() => {
      const previous = mergeRemoteStaffHistory.toString(), reverted = previous.replace(/if\(other\.settings\)initializeStaffPay\(other\);/, "");
      if (previous === reverted) throw new Error("legacy save negative control did not match");
      mergeRemoteStaffHistory = eval("(" + reverted + ")");
    });
    const legacyMerge = await page.evaluate(namedTarget => {
      const raw = structuredClone(S);
      raw.staff = [{ id: "legacy-target", name: namedTarget, role: "참모", wage: null, bonus: 0, def: { s: "09:00", e: "18:00", b: 60 }, off: [] }];
      raw.staffArchive = []; raw.staffEdits = {}; raw.staffFieldEdits = {}; raw.rosterEdits = {};
      raw.roster = { "2026-11": { "legacy-target|1": { s: "09:00", e: "11:00", b: 0 } } }; raw.settings.wage = 16000;
      for (const key of ["rolePayInitialized", "rolePayEditedAt", "roleWages", "staffRoles"]) delete raw.settings[key];
      S = structuredClone(raw); initializeStaffPay(S); cloudStaffBase = captureCloudStaffBase(S);
      mergeRemoteStaffHistory(raw); render();
      const e = findStaff("legacy-target");
      return { role: e.role, stored: e.wage, effective: staffWage(e), initialized: S.settings.rolePayInitialized, selectable: staffRoles().includes(e.role), roster: structuredClone(S.roster) };
    }, namedTargets[0]);
    assert.deepEqual({ role: legacyMerge.role, stored: legacyMerge.stored, effective: legacyMerge.effective, initialized: legacyMerge.initialized, selectable: legacyMerge.selectable }, { role: "조리", stored: 20000, effective: 20000, initialized: true, selectable: true }, "the first normalized save cannot be undone by an uninitialized raw legacy server snapshot");
    assert.deepEqual(legacyMerge.roster, { "2026-11": { "legacy-target|1": { s: "09:00", e: "11:00", b: 0 } } }, "initial wage normalization never edits historical shifts");
    if (process.env.NMF_TEST_LEGACY_PAY_NEGATIVE_CONTROL === "load") await page.evaluate(() => {
      const previous = preserveRosterHistory.toString(), reverted = previous.replace(/initializeStaffPay\(next\);/, "");
      if (previous === reverted) throw new Error("legacy load negative control did not match");
      preserveRosterHistory = eval("(" + reverted + ")");
    });
    const legacyLoad = await page.evaluate(() => {
      S.staff = [{ id: "legacy-backup", name: "옛 역할 백업 직원", role: "조리", wage: null, bonus: 0, def: { s: "09:00", e: "18:00", b: 60 }, off: [] }];
      S.staffArchive = []; S.staffEdits = {}; S.staffFieldEdits = {}; S.rosterEdits = {};
      S.roster = { "2026-11": { "legacy-backup|2": { s: "22:00", e: "06:00", b: 60 } } };
      setRoleWage("조리", 19500);
      const backup = structuredClone(S), roster = structuredClone(S.roster), localAt = S.settings.rolePayEditedAt;
      backup.staff[0].role = "참모";
      for (const key of ["rolePayInitialized", "rolePayEditedAt", "roleWages", "staffRoles"]) delete backup.settings[key];
      applyState(backup); render();
      const e = findStaff("legacy-backup");
      return { role: e.role, effective: staffWage(e), selectable: staffRoles().includes(e.role), initialized: S.settings.rolePayInitialized, rate: S.settings.roleWages["조리"], at: S.settings.rolePayEditedAt, localAt, roster: structuredClone(S.roster), originalRoster: roster };
    });
    assert.deepEqual([legacyLoad.role, legacyLoad.effective, legacyLoad.selectable, legacyLoad.initialized, legacyLoad.rate, legacyLoad.at], ["조리", 19500, true, true, 19500, legacyLoad.localAt], "loading a raw legacy backup maps its old role before preserving newer local role settings");
    assert.deepEqual(legacyLoad.roster, legacyLoad.originalRoster, "legacy backup normalization preserves every original shift");
    const archiveMetadataFixture = await page.evaluate(namedTargets => {
      S.staff = []; S.staffArchive = [{ id: "archive-target", name: namedTargets[0], role: "조리", wage: null, archivedWage: 16000, archivedAt: new Date().toISOString(), bonus: 5000, def: { s: "22:00", e: "06:00", b: 60 }, off: [0, 6], historyNames: ["이전 보관 표시", "보관 확인 이름"] }];
      S.staffEdits = { "archive-target": { at: new Date().toISOString(), status: "archive" } }; S.staffFieldEdits = {}; S.rosterEdits = {};
      S.roster = { "2026-11": { "archive-target|1": { s: "22:00", e: "06:00", b: 60 } } };
      cloudStaffBase = captureCloudStaffBase(S);
      const archived = structuredClone(S.staffArchive[0]);
      const raw = structuredClone(S), oldActive = { ...raw.staffArchive[0], name: namedTargets[1], role: "찬모", wage: null, bonus: 0, def: { s: "09:00", e: "15:00", b: 30 }, off: [], historyNames: ["옛 화면 별칭"] };
      delete oldActive.archivedWage; delete oldActive.archivedAt;
      raw.staff = [oldActive]; raw.staffArchive = []; raw.staffEdits = {}; raw.staffFieldEdits = {};
      for (const key of ["rolePayInitialized", "rolePayEditedAt", "roleWages", "staffRoles"]) delete raw.settings[key];
      return { raw, archived };
    }, namedTargets);
    const staleNamedActive = archiveMetadataFixture.raw;
    const archivedPayBeforeLegacy = await read();
    assert.deepEqual(archivedPayBeforeLegacy, [{ id: "archive-target", days: 1, hours: 7, nightHours: 7, wage: 16000, base: 112000, night: 56000, bonus: 5000, adjustment: 0, pay: 173000, total: 198950 }], "the archive fixture has independently known hours, allowance, and total payroll");
    const archivedSalary = () => page.evaluate(() => ({ active: S.staff.map(e => e.id), archive: S.staffArchive.map(e => e.id), stored: findStaff("archive-target").wage, frozen: findStaff("archive-target").archivedWage, effective: staffWage(findStaff("archive-target")) }));
    const archiveMatches = expected => page.evaluate(expected => {
      const actual = findStaff(expected.id), keys = Object.keys(expected);
      return !!actual && Object.keys(actual).length === keys.length && keys.every(key => JSON.stringify(actual[key]) === JSON.stringify(expected[key]));
    }, expected);
    await page.evaluate(remote => { mergeRemoteStaffHistory(remote); render(); }, staleNamedActive);
    assert.deepEqual(await archivedSalary(), { active: [], archive: ["archive-target"], stored: null, frozen: 16000, effective: 16000 }, "raw old active named initialization cannot rewrite the archived employee's frozen wage during save merge");
    assert.equal(await archiveMatches(archiveMetadataFixture.archived), true, "save merge preserves the entire local archive snapshot, including name, bonus, default times, off days, and aliases");
    assert.deepEqual(await read(), archivedPayBeforeLegacy, "the raw active save merge preserves exact archived hours/night/pay/total");
    await page.evaluate(remote => { applyState(remote); render(); }, staleNamedActive);
    assert.deepEqual(await archivedSalary(), { active: [], archive: ["archive-target"], stored: null, frozen: 16000, effective: 16000 }, "loading a raw old active named backup preserves the newer archive status and original frozen wage");
    assert.equal(await archiveMatches(archiveMetadataFixture.archived), true, "loading the old active backup preserves every local archived employee field");
    assert.deepEqual(await read(), archivedPayBeforeLegacy, "the raw active backup load preserves exact archived hours/night/pay/total");
    const explicitNewerSalary = await page.evaluate(() => {
      const remote = structuredClone(S), e = { ...remote.staffArchive[0], wage: 18000 };
      delete e.archivedWage; delete e.archivedAt; remote.staff = [e]; remote.staffArchive = []; remote.staffEdits = {};
      remote.staffFieldEdits = { "archive-target": { wage: { at: new Date(Date.parse(S.staffEdits["archive-target"].at) + 5000).toISOString() } } };
      return remote;
    });
    await page.evaluate(remote => { mergeRemoteStaffHistory(remote); render(); }, explicitNewerSalary);
    assert.deepEqual(await archivedSalary(), { active: [], archive: ["archive-target"], stored: 18000, frozen: 16000, effective: 18000 }, "archive protection still permits a genuinely newer explicit personal wage edit without reactivating the employee");
    assert.equal(await archiveMatches({ ...archiveMetadataFixture.archived, wage: 18000 }), true, "a newer explicit wage edit cannot change the other archived employee fields");
    const remoteArchive = await page.evaluate(({ raw, archived }) => {
      S = structuredClone(raw); initializeStaffPay(S); cloudStaffBase = captureCloudStaffBase(S);
      const remote = structuredClone(S);
      remote.staff = []; remote.staffArchive = [structuredClone(archived)]; remote.staffFieldEdits = {};
      remote.staffEdits = { [archived.id]: { at: new Date(Date.now() + 5000).toISOString(), status: "archive" } };
      return remote;
    }, archiveMetadataFixture);
    await page.evaluate(remote => { mergeRemoteStaffHistory(remote); render(); }, remoteArchive);
    assert.equal(await archiveMatches(archiveMetadataFixture.archived), true, "a stale local active page adopts the full newer remote archive snapshot, not its own old name/bonus/defaults/aliases");
    assert.deepEqual(await archivedSalary(), { active: [], archive: ["archive-target"], stored: null, frozen: 16000, effective: 16000 }, "remote archive transition cannot retain a stale local active wage");
    assert.deepEqual(await read(), archivedPayBeforeLegacy, "remote archive transition preserves the independently known archived payroll including its 5,000 won bonus");
    await page.evaluate(({ raw, remote }) => { S = structuredClone(raw); initializeStaffPay(S); applyState(remote); render(); }, { raw: staleNamedActive, remote: remoteArchive });
    assert.equal(await archiveMatches(archiveMetadataFixture.archived), true, "loading newer archived data over stale local active data preserves the full incoming archive snapshot");
    assert.deepEqual(await archivedSalary(), { active: [], archive: ["archive-target"], stored: null, frozen: 16000, effective: 16000 }, "incoming archive load keeps the archive state and original frozen salary");
    assert.deepEqual(await read(), archivedPayBeforeLegacy, "incoming archive load keeps exact hours/night/base/bonus/pay/total");
    const restoredActiveFixture = await page.evaluate(() => {
      const at = Date.now();
      S.staff = [{ id: "restored-snapshot", name: "복귀 당시 이름", role: "조리", wage: 12000, bonus: 5000, def: { s: "09:00", e: "18:00", b: 60 }, off: [6], historyNames: ["복귀 당시 별칭"] }];
      S.staffArchive = []; S.staffEdits = { "restored-snapshot": { at: new Date(at).toISOString(), status: "active" } }; S.staffFieldEdits = {}; S.rosterEdits = {};
      S.roster = { "2026-11": { "restored-snapshot|1": { s: "22:00", e: "06:00", b: 60 } } }; cloudStaffBase = captureCloudStaffBase(S);
      const snapshot = structuredClone(S.staff[0]), remote = structuredClone(S);
      remote.staff = []; remote.staffArchive = [{ ...snapshot, name: "과거 보관 이름", role: "보조", wage: 10000, archivedWage: 10000, bonus: 0, def: { s: "22:00", e: "06:00", b: 0 }, off: [], historyNames: ["옛 별칭"], archivedAt: new Date(at - 5000).toISOString() }];
      remote.staffEdits = { "restored-snapshot": { at: new Date(at - 5000).toISOString(), status: "archive" } };
      return { snapshot, remote };
    });
    const restoredPay = await read();
    assert.deepEqual(restoredPay, [{ id: "restored-snapshot", days: 1, hours: 7, nightHours: 7, wage: 12000, base: 84000, night: 42000, bonus: 5000, adjustment: 0, pay: 131000, total: 150650 }], "restored active fixture has independently known salary and bonus");
    await page.evaluate(remote => { mergeRemoteStaffHistory(remote); render(); }, restoredActiveFixture.remote);
    assert.equal(await archiveMatches(restoredActiveFixture.snapshot), true, "a newer local restore protects the entire active snapshot against an old remote archive");
    assert.deepEqual(await page.evaluate(() => ({ active: S.staff.map(e => e.id), archive: S.staffArchive.map(e => e.id) })), { active: ["restored-snapshot"], archive: [] }, "old remote archive cannot undo a newer local restore");
    assert.deepEqual(await read(), restoredPay, "restore-winning save merge preserves exact active payroll and bonus");
    await page.evaluate(remote => { applyState(remote); render(); }, restoredActiveFixture.remote);
    assert.equal(await archiveMatches(restoredActiveFixture.snapshot), true, "loading the old archive protects the whole newer active snapshot");
    assert.deepEqual(await read(), restoredPay, "restore-winning old backup load preserves exact active hours/night/pay/total");
    await page.evaluate(() => {
      S.staff = []; S.staffArchive = [{ id: "inherited-restore", name: "기본시급 복귀 직원", role: "조리", wage: null, archivedWage: 16000, bonus: 5000, archivedAt: new Date().toISOString(), def: { s: "22:00", e: "06:00", b: 60 }, off: [6] }];
      S.staffEdits = {}; S.staffFieldEdits = {}; S.rosterEdits = {};
      S.roster = { "2026-11": { "inherited-restore|1": { s: "22:00", e: "06:00", b: 60 } } };
      setRoleWage("조리", 19500);
      S = normalize(S); cloudStaffBase = null; render();
    });
    assert.deepEqual(await page.evaluate(() => S.staffEdits["inherited-restore"]), await page.evaluate(() => ({ at: findStaff("inherited-restore").archivedAt, status: "archive" })), "recovered archive records without status markers are seeded from their actual archivedAt");
    const inheritedPay = await read(), inheritedSnapshot = await page.evaluate(() => structuredClone(findStaff("inherited-restore")));
    const staleRecoveredActive = await page.evaluate(() => {
      const remote = structuredClone(S), e = { ...remote.staffArchive[0], name: "과거 재직 화면", wage: 10000, bonus: 0 };
      delete e.archivedAt; delete e.archivedWage; remote.staff = [e]; remote.staffArchive = []; remote.staffEdits = {};
      return remote;
    });
    await page.evaluate(remote => { mergeRemoteStaffHistory(remote); render(); }, staleRecoveredActive);
    assert.equal(await archiveMatches(inheritedSnapshot), true, "a seeded recovered archive survives a stale active merge without a cloud baseline");
    assert.deepEqual(await read(), inheritedPay, "seeded archive status preserves exact historical payroll");
    await page.evaluate(() => staffRestore("inherited-restore"));
    assert.deepEqual(await page.evaluate(() => ({ wage: findStaff("inherited-restore").wage, effective: staffWage(findStaff("inherited-restore")), archive: S.staffArchive.length })), { wage: 16000, effective: 16000, archive: 0 }, "restoring a role-derived archive transfers its frozen wage into the active personal override");
    assert.deepEqual(await read(), inheritedPay, "restoring inherited wage cannot silently reprice historical payroll");
    await page.evaluate(() => setStaffField("inherited-restore", "wage", null));
    assert.equal(await page.evaluate(() => staffWage(findStaff("inherited-restore"))), 19500, "explicit personal override clearing after restore intentionally uses the current role wage");
    console.log("STAFF_HISTORY_ARCHIVE_EXACT_PAYROLL / WEEK_MONTH_RELOAD / CSV_PDF / ACTIVE_ONLY_FILL_COPY / MANUAL_DELETE_REENTRY / RESTORE / ORPHAN_LEGACY / ZERO_HOUR_PAYROLL / CLOUD_THREE_WAY_TOMBSTONES / IMPORT_HISTORY / ARCHIVE_SEARCH_PAGING / RESTART_ARCHIVE_RESTORE_INTENT / BULK_REAL_SELECTION_CANCEL_VALIDATION_SNAPSHOT_BOUNDARY_PROTECTION / ROLE_MIGRATION_EDIT_ADD_DELETE_ARCHIVE_WAGE / ROLE_CONFIG_THREE_WAY / PERSONAL_ROLE_WAGE_RESTART_LOAD_TIMESTAMPS / LEGACY_FIRST_SAVE_BACKUP_LOAD / PRIVATE_NAMES_RUNTIME_ONLY / ARCHIVE_BIDIRECTIONAL_FULL_METADATA_BONUS_PAYROLL_EXPLICIT_EDIT / RESTORED_ACTIVE_SNAPSHOT / RECOVERED_ARCHIVE_STATUS_SEED_INHERITED_WAGE_RESTORE_PASS");
    console.log("APP_SOURCE_SHA256 " + createHash("sha256").update(source).digest("hex"));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
