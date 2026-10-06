// Offline staff-directory layout regression. Run with Playwright via NODE_PATH.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { chromium } = require("playwright");

const baseline = process.argv.includes("--baseline");
const source = fs.readFileSync(path.join(__dirname, "..", "나모푸드_관리앱.html"), "utf8");
const sourceHash = createHash("sha256").update(source).digest("hex");
const widths = baseline ? [1280, 1024] : [1440, 1280, 1024, 900, 768, 600, 390, 320];
const longRole = "야간조리및식품위생검수담당";
const roles = ["총괄", "조리", "보조", "이송", longRole];
const fixture = {
  staff: [
    { id: "layout-long", name: "가로폭검증용긴이름직원", role: longRole, wage: 18250, bonus: 23100, def: { s: "09:00", e: "18:00", b: 60 }, off: [0, 6] },
    { id: "layout-night", name: "야간 담당", role: "조리", wage: null, bonus: 3700, def: { s: "23:00", e: "03:30", b: 30 }, off: [2] },
    { id: "layout-midday", name: "오후 담당", role: "보조", wage: 13750, bonus: 1800, def: { s: "12:00", e: "20:30", b: 45 }, off: [4] },
  ],
  staffArchive: [{ id: "layout-archive", name: "보관 검증 직원", role: "이송", wage: 12900, bonus: 2100, def: { s: "07:00", e: "11:30", b: 30 }, off: [1], archivedWage: 12900, archivedAt: "2026-09-20T00:00:00.000Z" }],
  roster: {
    "2026-09": { "layout-long|30": { s: "22:00", e: "06:00", b: 60 }, "layout-long|adj": 850, "layout-archive|10": { s: "07:00", e: "11:30", b: 30 } },
    "2026-10": { "layout-long|1": { s: "09:00", e: "18:00", b: 60 }, "layout-night|2": { s: "23:00", e: "03:30", b: 30 }, "layout-midday|3": "연차" },
  },
};

async function createPage(browser, app = "food") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  if (app === "cafe") await context.addInitScript(() => localStorage.setItem("nmf_app", "cafe"));
  const page = await context.newPage();
  let blockedWrites = 0;
  await page.route("**/*", route => {
    const request = route.request();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) blockedWrites++;
    if (request.isNavigationRequest() && request.url().startsWith("https://offline.namofood.test/")) return route.fulfill({ contentType: "text/html", body: source });
    return route.abort();
  });
  await page.goto("https://offline.namofood.test/#roster");
  await page.evaluate(({ fixture, roles, longRole }) => {
    clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer);
    cloud.enabled = false; cloudApplying = true; cloudBusy = true;
    S.month = "2026-10";
    S.staff = structuredClone(fixture.staff); S.staffArchive = structuredClone(fixture.staffArchive);
    S.roster = structuredClone(fixture.roster); S.staffEdits = {}; S.rosterEdits = {};
    S.settings.staffRoles = roles;
    S.settings.roleWages = { "총괄": 15000, "조리": 15600, "보조": 13300, "이송": 13000, [longRole]: 18900 };
    S.settings.rolePayInitialized = true;
    staffRoleSettingsOpen = false; toggleRosterBulk(false); go("roster");
  }, { fixture, roles, longRole });
  return { context, page, blockedWrites: () => blockedWrites };
}

async function snapshot(page) {
  return page.evaluate(() => structuredClone({ staff: S.staff, staffArchive: S.staffArchive, roster: S.roster, settings: S.settings }));
}

async function inspectLayout(page, allowLegacy = false) {
  return page.evaluate(allowLegacy => {
    const table = document.getElementById("staff-directory-table") || (allowLegacy ? document.querySelector('input[placeholder="이름"]')?.closest("table") : null);
    const wrapper = document.getElementById("staff-directory-wrap") || (allowLegacy ? table?.parentElement : null);
    if (!table || !wrapper) return { missing: true };
    const rectangle = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const visible = element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== "hidden"; };
    const controls = [...table.querySelectorAll('tbody input:not([type="hidden"]),tbody select,tbody button')].filter(visible).map(element => ({
      type: element.tagName + ":" + (element.type || ""), value: element.value || element.textContent.trim(),
      rect: rectangle(element), cell: rectangle(element.closest("td")),
    }));
    return {
      viewport: innerWidth,
      table: { client: table.clientWidth, scroll: table.scrollWidth, rect: rectangle(table) },
      wrapper: { client: wrapper.clientWidth, scroll: wrapper.scrollWidth, rect: rectangle(wrapper) },
      rows: [...table.tBodies[0].rows].map(row => ({
        cells: row.cells.length,
        visibleCells: [...row.cells].filter(visible).length,
        roles: [...row.cells[1].querySelector("select").options].map(option => option.value),
        timeHours: [2, 3].map(index => [...row.cells[index].querySelectorAll("select")][0].options.length),
        timeMinutes: [2, 3].map(index => [...row.cells[index].querySelectorAll("select")][1].options.length),
        checkboxes: row.querySelectorAll('input[type="checkbox"]').length,
        actions: [...row.cells[9].querySelectorAll("button")].map(button => button.textContent.trim()),
      })),
      headers: [...table.tHead.rows[0].cells].map(cell => cell.textContent.trim()), controls,
    };
  }, allowLegacy);
}

function assertFits(layout, label, print = false) {
  assert(!layout.missing, label + ": staff directory has stable table and wrapper identifiers");
  for (const target of ["table", "wrapper"]) {
    assert(layout[target].scroll <= layout[target].client + 1, `${label}: ${target} horizontal overflow ${layout[target].scroll}/${layout[target].client}`);
    assert(layout[target].rect.left >= -1 && layout[target].rect.right <= layout.viewport + 1, label + ": " + target + " stays inside the viewport");
  }
  assert(layout.table.rect.left >= layout.wrapper.rect.left - 1 && layout.table.rect.right <= layout.wrapper.rect.right + 1, label + ": the complete table is inside its wrapper");
  assert.equal(layout.rows.length, fixture.staff.length, label + ": all staff rows remain");
  assert.equal(layout.headers.length, 10, label + ": all ten headers remain");
  assert.deepEqual(layout.headers.slice(0, 9), ["이름", "역할", "기본 출근", "기본 퇴근", "휴게(분)", "1일 근무", "시급(원)", "월 고정수당(원)", "정기 휴무"], label + ": field labels remain");
  for (const row of layout.rows) {
    assert.equal(row.cells, 10, label + ": all ten data fields remain");
    if (!print) assert.equal(row.visibleCells, 10, label + ": no data field is hidden");
    assert.deepEqual(row.roles, roles, label + ": all configured roles remain selectable");
    assert.deepEqual(row.timeHours, [25, 25], label + ": both 24-hour selectors retain every hour and label");
    assert(row.timeMinutes.every(count => count >= 3), label + ": minute choices remain");
    assert.equal(row.checkboxes, 7, label + ": every weekday remains editable");
    assert.deepEqual(row.actions, ["삭제/보관"], label + ": delete/archive action remains");
  }
  for (const control of layout.controls) {
    const { rect, cell } = control;
    assert(rect.width > 0 && rect.height > 0, label + ": control has usable dimensions");
    assert(rect.left >= cell.left - 1 && rect.right <= cell.right + 1 && rect.top >= cell.top - 1 && rect.bottom <= cell.bottom + 1,
      `${label}: ${control.type} extends outside its own cell (${JSON.stringify({ rect, cell })})`);
  }
  // A scroll/overflow clamp cannot satisfy the contract by concealing controls.
  assert.equal(layout.controls.length, fixture.staff.length * (print ? 16 : 17), label + ": every editable control remains visible");
}

async function verifyEditing(page, width) {
  await page.setViewportSize({ width, height: 1000 });
  const before = await snapshot(page), expected = structuredClone(before);
  const row = () => page.locator("#staff-directory-table tbody tr").first();
  const setInput = async (cell, value) => { const input = row().locator("td").nth(cell).locator("input").first(); await input.fill(value); await input.blur(); };
  expected.staff[0].name = "수정된 긴 이름 직원"; await setInput(0, expected.staff[0].name);
  expected.staff[0].role = "이송"; await row().locator("td").nth(1).locator("select").selectOption("이송");
  expected.staff[0].def.s = "22:30"; await page.locator("#staff_0_s_h").selectOption("22"); await page.locator("#staff_0_s_m").selectOption("30");
  expected.staff[0].def.e = "06:30"; await page.locator("#staff_0_e_h").selectOption("06"); await page.locator("#staff_0_e_m").selectOption("30");
  expected.staff[0].def.b = 45; await setInput(4, "45");
  expected.staff[0].wage = 21950; await setInput(6, "21950");
  expected.staff[0].bonus = 45670; await setInput(7, "45670");
  expected.staff[0].off = [6, 3]; await row().locator('input[type="checkbox"]').nth(0).uncheck(); await row().locator('input[type="checkbox"]').nth(3).check();
  assert.deepEqual(await snapshot(page), expected, width + "px: real controls update exact fixture values and preserve every other staff/roster/settings value");
  assert.equal(await row().locator("td").nth(5).innerText(), "7.3h", width + "px: daily hours reflect edited times and break");
  expected.staff[0].wage = null; await setInput(6, "");
  assert.deepEqual(await snapshot(page), expected, width + "px: clearing personal wage restores role default without data loss");
  assertFits(await inspectLayout(page), width + "px after editing");
  await page.evaluate(before => { S.staff = before.staff; render(); }, before);
  assert.deepEqual(await snapshot(page), before, width + "px: synthetic fixture is restored exactly");
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  try {
    const setup = await createPage(browser), { page } = setup;
    const original = await snapshot(page), failures = [], dimensions = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      const layout = await inspectLayout(page, baseline);
      dimensions.push({ width, table: layout.table && `${layout.table.scroll}/${layout.table.client}`, wrapper: layout.wrapper && `${layout.wrapper.scroll}/${layout.wrapper.client}` });
      if (baseline) { try { assertFits(layout, width + "px"); } catch (error) { failures.push(error.message); } }
      else assertFits(layout, width + "px");
      assert.deepEqual(await snapshot(page), original, width + "px: layout never mutates fixture data");
      if (width === 1280 || width === 390) {
        await page.locator(baseline ? 'input[placeholder="이름"]' : "#staff-directory-table").first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: `/tmp/nmf-staff-layout${baseline ? "-baseline" : ""}-${width}.png`, fullPage: true });
      }
    }
    console.log(JSON.stringify({ sourceHash, dimensions }));
    if (baseline) {
      assert(failures.length === 0, "BASELINE_RED: " + failures.join("; "));
      return;
    }
    await verifyEditing(page, 1280); await verifyEditing(page, 390);
    await page.setViewportSize({ width: 1122, height: 794 });
    await page.emulateMedia({ media: "print" });
    assertFits(await inspectLayout(page), "landscape print", true);
    await page.emulateMedia({ media: "screen" });
    assert.deepEqual(await snapshot(page), original, "screen/print checks preserve exact fixture state");
    assert.equal(setup.blockedWrites(), 0, "cloud disabled before any outgoing write request");
    await setup.context.close();
    const cafe = await createPage(browser, "cafe");
    const cafeBefore = await snapshot(cafe.page);
    for (const width of [1024, 390]) {
      await cafe.page.setViewportSize({ width, height: 1000 });
      assertFits(await inspectLayout(cafe.page), "cafe " + width + "px");
    }
    assert.deepEqual(await snapshot(cafe.page), cafeBefore, "shared cafe staff layout preserves synthetic state");
    assert.equal(cafe.blockedWrites(), 0, "cafe cloud disabled before any outgoing write request");
    await cafe.context.close();
    console.log("STAFF_DIRECTORY_VIEWPORT_FIT / CELL_CONTROL_BOUNDS / TEN_FIELDS / ALL_ROLES / 24_HOUR_CHOICES / EXACT_EDITS / DATA_PRESERVED / CAFE_SHARED_LAYOUT / PRINT_CONTROL_BOUNDS / OFFLINE_NO_WRITES_PASS");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
