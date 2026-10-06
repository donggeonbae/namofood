// Real weekly bulk-input UI, fully offline and with synthetic staff/history only.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { chromium } = require("playwright");

const source = fs.readFileSync(path.join(__dirname, "..", "나모푸드_관리앱.html"), "utf8");
const sourceHash = createHash("sha256").update(source).digest("hex");
const people = ["weekA", "weekB", "weekC"];
const employee = (id, name) => ({ id, name, role: "조리", wage: 15750, bonus: 1234, def: { s: "09:00", e: "18:00", b: 60 }, off: [6] });
const fixture = {
  staff: [employee("weekA", "주차 검증 A"), employee("weekB", "주차 검증 B")],
  archive: [{ ...employee("weekC", "주차 검증 보관 C"), archivedWage: 15750, archivedAt: "2026-09-20T00:00:00.000Z" }],
  roster: {
    "2026-09": { "weekA|30": { s: "22:00", e: "06:00", b: 60 }, "weekB|30": "휴", "weekA|adj": 500 },
    "2026-10": {
      "weekA|1": { s: "09:00", e: "11:00", b: 0 }, "weekA|2": { s: "12:00", e: "15:00", b: 0 },
      "weekA|3": { s: "09:00", e: "09:00", b: 0 }, "weekA|4": "연차",
      "weekA|5": { s: "09:00", e: "17:00", b: 30 }, "weekA|8": "휴", "weekA|adj": 975,
      "weekB|1": { s: "09:00", e: "09:00", b: 0 }, "weekB|3": { s: "13:00", e: "15:00", b: 0 },
      "weekB|5": { s: "11:00", e: "15:00", b: 0 }, "weekC|10": { s: "07:00", e: "11:30", b: 30 },
    },
    "2026-11": { "weekC|10": { s: "07:00", e: "11:30", b: 30 }, "weekA|11": "병가" },
  },
  edits: {
    "2026-09": { "weekA|15": { at: "2026-09-25T00:00:00.000Z", deleted: true } },
    "2026-10": { "weekA|6": { at: "2026-09-25T00:00:00.000Z", deleted: true }, "weekB|20": { at: "2026-09-26T00:00:00.000Z", deleted: true } },
  },
};

async function installFixture(page) {
  await page.evaluate(fixture => {
    clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer);
    cloud.enabled = false; cloudApplying = true; cloudBusy = true;
    S.month = "2026-10"; S.staff = structuredClone(fixture.staff); S.staffArchive = structuredClone(fixture.archive);
    S.roster = structuredClone(fixture.roster); S.rosterEdits = structuredClone(fixture.edits);
    S.staffEdits = {}; S.staffFieldEdits = {}; S.settings.rolePayInitialized = true;
    staffRoleSettingsOpen = false; staffArchiveOpen = false; toggleRosterBulk(false); go("roster");
  }, fixture);
}

const protectedData = page => page.evaluate(() => structuredClone({ roster: S.roster, edits: S.rosterEdits, staff: S.staff, archive: S.staffArchive, settings: S.settings, staffEdits: S.staffEdits, staffFieldEdits: S.staffFieldEdits }));
const selectedKeys = page => page.evaluate(() => [...rosterBulk.selected].sort());
const groupKeys = days => people.flatMap(id => days.map(day => `${id}|${day}`)).sort();
const openWeek = (page, week) => page.locator(`button[data-roster-bulk-week="${week}"]`).click();
const checkCell = (page, id, day) => page.locator(`input.roster-bulk-check[data-staff="${id}"][data-day="${day}"]`).check();
const clearSelection = page => page.getByRole("button", { name: "선택 해제", exact: true }).click();
const apply = page => page.getByRole("button", { name: "선택 칸에 시간 적용", exact: true }).click();
const previous = page => page.getByRole("button", { name: "각 칸에 전날 근무시간 적용", exact: true }).click();

async function assertSelection(page, keys, label) {
  assert.deepEqual(await selectedKeys(page), [...keys].sort(), label + ": exact staff/day keys");
  assert.equal((await page.locator("#rosterBulkCount").innerText()).trim(), `${keys.length}칸 선택`, label + ": visible count");
  assert.equal(await page.locator("input.roster-bulk-check:checked").count(), keys.length, label + ": visible checked cells match count");
}

async function assertActiveWeek(page, week, days, label) {
  assert.deepEqual(await page.evaluate(() => ({ enabled: rosterBulk.enabled, activeWeek: rosterBulk.activeWeek })), { enabled: true, activeWeek: week }, label + ": active week state");
  assert.equal(await page.locator("#rosterBulkPanel").count(), 1, label + ": exactly one real input panel");
  assert.equal(await page.locator(`.roster-week-card[data-week="${week}"] #rosterBulkPanel`).count(), 1, label + ": panel belongs to its visible week card");
  const month = await page.evaluate(() => S.month), range = page.locator("#rosterBulkWeekRange");
  assert.equal(await range.getAttribute("data-start"), `${month}-${String(days[0]).padStart(2, "0")}`, label + ": visible range starts on first valid date");
  assert.equal(await range.getAttribute("data-end"), `${month}-${String(days.at(-1)).padStart(2, "0")}`, label + ": visible range ends on last valid date");
  assert.equal((await range.innerText()).trim(), `${week + 1}주 · ${Number(month.slice(5))}월 ${days[0]}일 ~ ${Number(month.slice(5))}월 ${days.at(-1)}일`, label + ": displayed week and date range are exact");
  const available = await page.locator("input.roster-bulk-check").evaluateAll(inputs => inputs.map(input => `${input.dataset.staff}|${input.dataset.day}`).sort());
  assert.deepEqual(available, groupKeys(days), label + ": only active-week cells are selectable, including archived staff");
  assert.equal(await page.locator("#rb_s_h").count(), 1, label + ": one 24-hour start field");
  assert.equal(await page.locator("#rb_e_h").count(), 1, label + ": one 24-hour end field");
  assert.equal(await page.locator("#rosterBulkEnabled").count(), 0, label + ": month-wide toggle was removed");
}

async function setTime(page, start, end, rest) {
  await page.locator("#rb_s_h").selectOption(start.slice(0, 2)); await page.locator("#rb_s_m").selectOption(start.slice(3));
  await page.locator("#rb_e_h").selectOption(end.slice(0, 2)); await page.locator("#rb_e_m").selectOption(end.slice(3));
  await page.locator("#rb_b").fill(String(rest));
}

function assertOnlyUpdates(before, after, updates, label) {
  const expected = structuredClone(before);
  for (const [month, key, value] of updates) {
    expected.roster[month][key] = value;
    const marker = after.edits[month]?.[key];
    assert(marker && marker.deleted === false && Number.isFinite(Date.parse(marker.at)), label + ": selected work creates a dated re-entry marker " + key);
    if (before.edits[month]?.[key]) assert(Date.parse(marker.at) > Date.parse(before.edits[month][key].at), label + ": selected tombstone is superseded " + key);
    expected.edits[month] ||= {}; expected.edits[month][key] = marker;
  }
  assert.deepEqual(after, expected, label + ": all other month cells, tombstones, staff metadata, and payroll settings remain exact");
}

async function verifyWidth(browser, width) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } }), page = await context.newPage();
  let blockedWrites = 0, dismissNextConfirm = false;
  const dialogs = [];
  page.on("dialog", async dialog => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    if (dialog.type() === "confirm" && dismissNextConfirm) { dismissNextConfirm = false; await dialog.dismiss(); }
    else await dialog.accept();
  });
  await page.route("**/*", route => {
    const request = route.request();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) blockedWrites++;
    if (request.isNavigationRequest() && request.url().startsWith("https://offline.namofood.test/")) return route.fulfill({ contentType: "text/html", body: source });
    return route.abort();
  });
  await page.goto("https://offline.namofood.test/#roster"); await installFixture(page);
  const initial = await protectedData(page);
  assert.equal(await page.locator(".roster-week-card").count(), 5, width + "px: October has five real week cards");
  assert.equal(await page.locator("button[data-roster-bulk-week]").count(), 5, width + "px: each week has its own entry button");
  assert.equal(await page.locator("#rosterBulkPanel").count(), 0, width + "px: normal view has no detached bulk editor");
  await openWeek(page, 1); await assertActiveWeek(page, 1, [5, 6, 7, 8, 9, 10, 11], width + "px second week");
  await assertSelection(page, [], "opening second week");
  assert.deepEqual(await protectedData(page), initial, "opening a week never changes data");

  await page.getByRole("checkbox", { name: "주차 검증 A 2주 전체 선택", exact: true }).check();
  await assertSelection(page, [5, 6, 7, 8, 9, 10, 11].map(day => `weekA|${day}`), "row selection is scoped to active week");
  await clearSelection(page);
  await page.getByRole("checkbox", { name: "7일 전체 선택", exact: true }).check();
  await assertSelection(page, people.map(id => `${id}|7`), "day selection includes active and archived staff");
  await page.locator('input.roster-bulk-check[data-staff="weekA"][data-day="7"]').uncheck();
  await assertSelection(page, ["weekB|7", "weekC|7"], "one checkbox can deselect one cell");
  await clearSelection(page);
  await page.getByRole("button", { name: "이 주 전체 선택/해제", exact: true }).click();
  await assertSelection(page, groupKeys([5, 6, 7, 8, 9, 10, 11]), "whole week selects 21 valid cells");
  await page.getByRole("button", { name: "이 주 전체 선택/해제", exact: true }).click();
  await assertSelection(page, [], "whole week can be toggled off");
  const keyboardCell = page.locator('input.roster-bulk-check[data-staff="weekA"][data-day="7"]');
  await keyboardCell.focus(); await page.keyboard.press("Space");
  await assertSelection(page, ["weekA|7"], "keyboard Space checks the real cell checkbox");
  assert.equal(await keyboardCell.evaluate(element => element === document.activeElement), true, width + "px: checked checkbox keeps keyboard focus after rerender");
  await page.keyboard.press("Space");
  await assertSelection(page, [], "keyboard Space can uncheck the same focused cell");
  assert.equal(await keyboardCell.evaluate(element => element === document.activeElement), true, width + "px: unchecked checkbox keeps keyboard focus after rerender");
  for (const [id, day] of [["weekA", 5], ["weekA", 6], ["weekB", 8], ["weekA", 9]]) await checkCell(page, id, day);
  await assertSelection(page, ["weekA|5", "weekA|6", "weekB|8", "weekA|9"], "individual selection");

  await page.locator("#rb_s_h").focus();
  const focusBefore = await page.evaluate(() => ({ top: document.getElementById("main").scrollTop, rect: document.getElementById("rb_s_h").getBoundingClientRect().top }));
  await page.locator("#rb_s_h").selectOption("00");
  const focusAfter = await page.evaluate(() => ({ id: document.activeElement?.id, top: document.getElementById("main").scrollTop, rect: document.getElementById("rb_s_h").getBoundingClientRect().top }));
  assert.equal(focusAfter.id, "rb_s_h", width + "px: changing time keeps the genuine field focused");
  assert(Math.abs(focusAfter.top - focusBefore.top) <= 1 && Math.abs(focusAfter.rect - focusBefore.rect) <= 1, width + "px: changing time does not jump away from the active week");
  await setTime(page, "00:00", "12:00", 30);
  assert.equal(await page.locator('[data-time="rb_s"] .timehint').innerText(), "자정", "00:00 is explicitly midnight");
  assert.equal(await page.locator('[data-time="rb_e"] .timehint').innerText(), "정오", "12:00 is explicitly noon");
  const panelBounds = await page.locator("#rosterBulkPanel").evaluate(panel => ({ client: panel.clientWidth, scroll: panel.scrollWidth, left: panel.getBoundingClientRect().left, right: panel.getBoundingClientRect().right, viewport: innerWidth }));
  assert(panelBounds.scroll <= panelBounds.client + 1 && panelBounds.left >= -1 && panelBounds.right <= panelBounds.viewport + 1, width + "px: local editor fits inside viewport");
  await page.screenshot({ path: `/tmp/nmf-weekly-bulk-${width}.png`, fullPage: true });
  const beforeApply = await protectedData(page), selectedBefore = await selectedKeys(page);
  for (const [start, end, rest] of [["00:00", "00:00", 0], ["09:00", "10:00", 60], ["09:00", "18:00", -5]]) {
    await setTime(page, start, end, rest); const count = dialogs.length; await apply(page);
    assert.equal(dialogs[count]?.type, "alert", "invalid work time prompts an explicit validation alert");
    assert.deepEqual(await protectedData(page), beforeApply, "invalid work time preserves all data and tombstones");
    await assertSelection(page, selectedBefore, "invalid time retains selection");
  }
  await setTime(page, "00:00", "12:00", 30); dismissNextConfirm = true; await apply(page);
  assert.equal(dismissNextConfirm, false, "overwriting an existing shift actually asks for confirmation");
  assert.deepEqual(await protectedData(page), beforeApply, "canceling overwrite is fully non-mutating");
  await assertSelection(page, selectedBefore, "canceling overwrite retains selection");
  await apply(page);
  const afterApply = await protectedData(page);
  assertOnlyUpdates(beforeApply, afterApply, selectedBefore.map(key => ["2026-10", key, { s: "00:00", e: "12:00", b: 30 }]), "accepted work apply");
  await assertSelection(page, [], "successful apply clears only selection");
  await assertActiveWeek(page, 1, [5, 6, 7, 8, 9, 10, 11], "successful apply keeps active week editor");

  await checkCell(page, "weekA", 5); const beforeSwitch = await protectedData(page);
  await openWeek(page, 2); await assertActiveWeek(page, 2, [12, 13, 14, 15, 16, 17, 18], "switching to third week");
  await assertSelection(page, [], "switching week clears stale selection");
  assert.deepEqual(await protectedData(page), beforeSwitch, "switching week never changes history");
  await checkCell(page, "weekA", 12); await openWeek(page, 2);
  await assertSelection(page, ["weekA|12"], "reopening the same week preserves selection");
  await openWeek(page, 4); await assertActiveWeek(page, 4, [26, 27, 28, 29, 30, 31], "last October week is trimmed to month end");
  await page.getByRole("button", { name: "이 주 전체 선택/해제", exact: true }).click();
  await assertSelection(page, groupKeys([26, 27, 28, 29, 30, 31]), "month end excludes padding and next-month dates");
  const monthInput = page.locator('input[type="month"]'); await monthInput.fill("2026-11"); await monthInput.blur();
  assert.equal(await page.evaluate(() => S.month), "2026-11", "real month input changes the displayed month");
  assert.deepEqual(await selectedKeys(page), [], "month change clears selection");
  assert.equal(await page.locator("#rosterBulkPanel").count(), 0, "month change closes the old week editor");
  assert.deepEqual(await protectedData(page), beforeSwitch, "month navigation cannot mutate staff/history/markers");
  await openWeek(page, 0); await assertActiveWeek(page, 0, [1], "first November week contains only Sunday 1st");
  await page.getByRole("button", { name: "이 주 전체 선택/해제", exact: true }).click();
  await assertSelection(page, groupKeys([1]), "one-day first week cannot select dates from surrounding months");
  const beforeCancel = await protectedData(page);
  await page.locator("#rosterBulkCancel").focus(); await page.keyboard.press("Enter");
  assert.equal(await page.locator('button[data-roster-bulk-week="0"]').evaluate(element => element === document.activeElement), true, width + "px: keyboard cancel returns focus to the same week's entry button");
  assert.deepEqual(await selectedKeys(page), [], "input cancel clears selection");
  assert.equal(await page.evaluate(() => rosterBulk.enabled), false, "input cancel restores normal mode");
  assert.equal(await page.locator("#rosterBulkPanel").count(), 0, "cancel removes the local bulk editor");
  assert.equal(await page.locator("input.roster-bulk-check").count(), 0, "cancel removes bulk selection controls");
  assert.deepEqual(await protectedData(page), beforeCancel, "cancel input cannot mutate any saved data");
  // November 1 is the last cell in the first week; the real cell opens the normal picker.
  await page.locator('.roster-week-card[data-week="0"] table.roster tr').nth(1).locator("td").nth(7).click();
  assert.equal(await page.locator("#codepick").isVisible(), true, "normal single-cell picker works after cancel");
  assert.deepEqual(await page.evaluate(() => pickCtx), { i: "weekA", d: 1, month: "2026-11" }, "picker targets the clicked staff/date exactly");
  assert.deepEqual(await protectedData(page), beforeCancel, "opening normal picker is non-mutating");

  // Independent fixture: three consecutive valid sources distinguish snapshot copy from chaining.
  await installFixture(page); await openWeek(page, 0); await assertActiveWeek(page, 0, [1, 2, 3, 4], "first October week");
  for (const [id, day] of [["weekA", 1], ["weekA", 2], ["weekA", 3], ["weekA", 4], ["weekB", 1], ["weekB", 2], ["weekB", 3], ["weekC", 1], ["weekC", 2]]) await checkCell(page, id, day);
  const beforePrevious = await protectedData(page), previousSelected = await selectedKeys(page);
  dismissNextConfirm = true; await previous(page);
  assert.equal(dismissNextConfirm, false, "previous-day overwrite also asks for confirmation");
  assert.deepEqual(await protectedData(page), beforePrevious, "canceling previous-day overwrite preserves exact records and tombstones");
  await assertSelection(page, previousSelected, "canceling previous-day copy retains selection");
  await previous(page);
  assertOnlyUpdates(beforePrevious, await protectedData(page), [
    ["2026-10", "weekA|1", fixture.roster["2026-09"]["weekA|30"]],
    ["2026-10", "weekA|2", fixture.roster["2026-10"]["weekA|1"]],
    ["2026-10", "weekA|3", fixture.roster["2026-10"]["weekA|2"]],
  ], "previous-day snapshot copy crosses month boundary, skips leave/missing/zero-hour sources and protects unselected deletion markers");
  await assertSelection(page, [], "previous-day apply clears selection");
  assert.equal(blockedWrites, 0, width + "px: cloud disabled before any outgoing write attempt");
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  try {
    await verifyWidth(browser, 1280); await verifyWidth(browser, 390);
    console.log(JSON.stringify({ sourceHash, widths: [1280, 390] }));
    console.log("WEEK_LOCAL_REAL_UI / ROW_DAY_CELL_SELECTION / ACTIVE_WEEK_ONLY / EXACT_COUNTS / MIDNIGHT_NOON / FIELD_FOCUS / KEYBOARD_SPACE_CHECKBOX_FOCUS / KEYBOARD_CANCEL_WEEK_FOCUS / OVERWRITE_CANCEL / SELECTED_ONLY_EDITS / TOMBSTONE_GUARDS / PREVIOUS_SNAPSHOT / MONTH_BOUNDARIES / WEEK_SWITCH_CANCEL / NORMAL_PICKER / OFFLINE_NO_WRITES_PASS");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
