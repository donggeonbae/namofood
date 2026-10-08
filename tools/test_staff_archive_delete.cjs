// Run with Playwright in NODE_PATH. This suite never contacts production.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

async function csvText(page) {
  return page.evaluate(async () => {
    const create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = blob => { window.__archiveCsv = blob; return 'blob:archive-fixture'; };
    HTMLAnchorElement.prototype.click = function () {};
    try { csvRoster(); return await window.__archiveCsv.text(); }
    finally { URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click; delete window.__archiveCsv; }
  });
}

async function printedText(page) {
  await page.emulateMedia({ media: 'print' });
  const bytes = await page.pdf({ preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
  const pdfjs = await import(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true }).promise;
  const texts = [];
  for (let i = 1; i <= pdf.numPages; i++) texts.push((await (await pdf.getPage(i)).getTextContent()).items.map(item => item.str).join(' '));
  await pdf.destroy();
  await page.emulateMedia({ media: 'screen' });
  return texts.join(' ');
}

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '나모푸드_관리앱.html'), 'utf8');
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000);
    const pageErrors = [], dialogs = [];
    let dismissNext = false;
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', async dialog => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      if (dialog.type() === 'confirm' && dismissNext) { dismissNext = false; await dialog.dismiss(); }
      else await dialog.accept();
    });
    await page.route('**/*', route => route.request().isNavigationRequest()
      ? route.fulfill({ contentType: 'text/html', body: source }) : route.abort());
    await page.goto('https://offline.namofood.test/');
    const offline = () => page.evaluate(() => {
      clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer);
      cloud.enabled = false; cloudApplying = true;
    });
    await offline();
    await page.evaluate(() => {
      S.month = '2026-10'; S.staffEdits = {}; S.staffFieldEdits = {}; S.rosterEdits = {};
      S.settings.wage = 9000; S.settings.night = .5; S.settings.burden = .1; S.settings.vacancy = .05;
      S.settings.rolePayInitialized = true;
      S.staff = [{ id: 'active', name: '현직 직원', role: '조리', wage: 10000, bonus: 1000, def: { s: '09:00', e: '18:00', b: 60 }, off: [] }];
      S.staffArchive = Array.from({ length: 13 }, (_, i) => ({ id: `arch-${String(i).padStart(2, '0')}`, name: `보관 ${i}`, role: '조리', wage: 12000, archivedWage: 12000, bonus: 5000, def: { s: '09:00', e: '18:00', b: 60 }, off: [6], archivedAt: '2026-09-01T00:00:00.000Z' }));
      S.staffArchive[11].name = '가상 <img src=x onerror="window.__archiveXss=1"> 직원';
      S.staffArchive[12].name = '삭제 대상'; S.staffArchive[12].historyNames = ['이전 별칭'];
      S.staffArchive.push({ id: 'unknown', name: '확인 필요', role: '보조', wage: null, bonus: 0, def: { s: '09:00', e: '18:00', b: 60 }, off: [], historyUnknown: true, archivedAt: '2026-09-01T00:00:00.000Z' });
      for (const e of S.staffArchive) S.staffEdits[e.id] = { at: e.archivedAt, status: 'archive' };
      S.roster = {
        '2026-09': { 'arch-12|2': { s: '23:00', e: '03:00', b: 0 }, 'arch-12|adj': 300 },
        '2026-10': { 'arch-12|1': { s: '22:00', e: '06:00', b: 60 }, 'arch-12|2': { s: '09:00', e: '18:00', b: 60 }, 'arch-12|8': { s: '00:00', e: '04:00', b: 0 }, 'arch-12|9': '연차', 'arch-12|adj': 1000, 'active|1': { s: '09:00', e: '18:00', b: 60 }, 'unknown|3': { s: '09:00', e: '11:00', b: 0 } },
      };
      cloudStaffBase = null; staffArchiveSearch = ''; staffArchivePage = 2; staffArchiveOpen = true;
      go('roster');
      localStorage.setItem(KEY, JSON.stringify(S));
    });
    const deletion = id => page.locator(`button[data-staff-archive-delete="${id}"]`);
    assert.equal(await deletion('arch-12').count(), 1, 'each stored employee has a Delete button targeted by stable ID');
    const read = () => page.evaluate(() => laborRows().map(r => ({ id: r.e.id, days: r.daysW, hours: r.h, nightHours: r.nh, wage: r.wage, base: r.base, night: r.night, bonus: r.bonus, adjustment: r.adj, pay: r.pay, total: Math.round(r.total) })).sort((a, b) => a.id.localeCompare(b.id)));
    const protectedState = () => page.evaluate(() => ({ staff: structuredClone(S.staff), archive: structuredClone(S.staffArchive), roster: structuredClone(S.roster), rosterEdits: structuredClone(S.rosterEdits), fields: structuredClone(S.staffFieldEdits), settings: structuredClone(S.settings) }));
    const uiRows = () => page.locator('#staffArchive tr[data-staff-archive-id]').evaluateAll(rows => rows.map(row => row.dataset.staffArchiveId));
    const before = await protectedState(), beforePay = await read(), beforeCsv = await csvText(page);
    const originalState = await page.evaluate(() => structuredClone(S));
    assert.deepEqual(beforePay.find(r => r.id === 'arch-12'), { id: 'arch-12', days: 3, hours: 19, nightHours: 11, wage: 12000, base: 228000, night: 66000, bonus: 5000, adjustment: 1000, pay: 300000, total: 345000 }, 'historical payroll has an independent numeric oracle');
    assert.equal(beforePay.find(r => r.id === 'unknown').hours, 2);
    assert.equal(beforePay.find(r => r.id === 'unknown').wage, 0, 'unknown history cannot manufacture a wage');
    assert.deepEqual(await uiRows(), ['arch-10', 'arch-11', 'arch-12', 'unknown']);
    assert.equal(await page.locator('#staffArchive img').count(), 0, 'employee labels are escaped');
    assert.equal(await page.evaluate(() => window.__archiveXss), undefined);

    dismissNext = true;
    await deletion('arch-12').focus();
    await deletion('arch-12').press('Enter');
    assert.deepEqual(await protectedState(), before, 'cancelled Delete preserves every staff field, roster cell, setting and field edit');
    assert.deepEqual(await page.evaluate(() => S.staffEdits), originalState.staffEdits, 'cancelled Delete leaves no status marker');
    assert.equal(await deletion('arch-12').count(), 1);
    assert.equal(dialogs.at(-1).type, 'confirm');
    for (const text of ['삭제 대상', '명단에서 삭제', '근무', '인건비']) assert(dialogs.at(-1).message.includes(text), 'confirmation explains the named action and retained history: ' + text);
    assert(dialogs.at(-1).message.includes('남') || dialogs.at(-1).message.includes('유지') || dialogs.at(-1).message.includes('보존'), 'confirmation makes history retention explicit');

    const invalidMarkers = await page.evaluate(() => structuredClone(S.staffEdits)), invalidDialogs = dialogs.length;
    await page.evaluate(() => { staffArchiveDelete('active'); staffArchiveDelete('absent'); });
    assert.deepEqual(await protectedState(), before, 'active and missing IDs cannot be deleted through the archive action');
    assert.deepEqual(await page.evaluate(() => S.staffEdits), invalidMarkers);
    assert.equal(dialogs.length, invalidDialogs, 'invalid targets do not request misleading confirmation');

    await deletion('arch-12').focus();
    await deletion('arch-12').press('Space');
    assert.deepEqual(await protectedState(), before, 'accepted Delete changes list membership only, keeping the exact archived person and all payroll inputs');
    assert.deepEqual(await read(), beforePay, 'all current-month pay stays exactly equal');
    assert.equal(await csvText(page), beforeCsv, 'the actual payroll CSV remains byte-identical after list deletion');
    const marker = await page.evaluate(() => structuredClone(S.staffEdits['arch-12']));
    assert.equal(marker.status, 'archive'); assert.equal(marker.listed, false);
    assert(Date.parse(marker.at) > Date.parse(originalState.staffEdits['arch-12'].at), 'the list tombstone is timestamped newer than its predecessor');
    const others = await page.evaluate(() => Object.fromEntries(Object.entries(S.staffEdits).filter(([id]) => id !== 'arch-12')));
    assert.deepEqual(others, Object.fromEntries(Object.entries(originalState.staffEdits).filter(([id]) => id !== 'arch-12')), 'unrelated employee status markers stay exact');
    assert.equal(await deletion('arch-12').count(), 0);
    assert(!(await uiRows()).includes('arch-12'));
    assert((await page.locator('#staffArchive summary').innerText()).includes('13명'), 'ordinary archive count excludes deleted records');
    assert.equal(await page.locator('button[data-staff-archive-open="arch-12"]').count(), 1, 'historical payroll still reaches the person by stable ID');
    const duplicateDialogs = dialogs.length;
    await page.evaluate(() => staffArchiveDelete('arch-12'));
    assert.deepEqual(await page.evaluate(() => S.staffEdits['arch-12']), marker, 'duplicate Delete is a no-op');
    assert.equal(dialogs.length, duplicateDialogs);

    await page.locator('#staffArchiveSearch').fill('이전 별칭');
    assert.deepEqual(await uiRows(), [], 'hidden records remain absent even when searching their exact historical alias');
    await page.locator('button[data-staff-archive-open="arch-12"]').focus();
    await page.locator('button[data-staff-archive-open="arch-12"]').press('Enter');
    assert.equal(await page.locator('#staffArchiveSearch').inputValue(), '');
    assert.equal(await page.evaluate(() => staffArchiveRecordId), 'arch-12');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.staffArchiveName), 'arch-12', 'keyboard payroll navigation focuses the correct name input');
    const recordRow = page.locator('tr[data-staff-archive-id="arch-12"]');
    assert((await recordRow.innerText()).includes('기록만 보관'), 'the retained historical record is explicitly distinguished from the ordinary archive list');
    assert.equal(await recordRow.locator('button[data-staff-archive-delete]').count(), 0, 'a historical-record preview does not offer repeated list deletion');
    assert.equal(await page.locator('#staffArchiveRecordClose').count(), 1);
    const navigationMarker = await page.evaluate(() => structuredClone(S.staffEdits));
    await page.locator('#staffArchiveRecordClose').click();
    assert.equal(await page.evaluate(() => staffArchiveRecordId), null);
    assert(!(await uiRows()).includes('arch-12'), 'closing a historical-record preview hides it again');
    assert.deepEqual(await page.evaluate(() => S.staffEdits), navigationMarker, 'opening and closing a preview never relists the person');
    await page.locator('button[data-staff-archive-open="arch-12"]').click();
    await page.locator('#staffArchive summary').click();
    await page.waitForFunction(() => staffArchiveRecordId === null, null, { timeout: 1000 });
    await page.locator('#staffArchive summary').click();
    assert(!(await uiRows()).includes('arch-12'), 'native archive collapse closes a temporary historical-record preview');
    assert.deepEqual(await page.evaluate(() => S.staffEdits), navigationMarker);
    await page.locator('button[data-staff-archive-open="arch-12"]').click();
    await page.evaluate(() => { go('home'); go('roster'); });
    assert.equal(await page.evaluate(() => staffArchiveRecordId), null, 'leaving the roster closes a temporary historical-record preview');
    assert(!(await uiRows()).includes('arch-12'), 'returning to the roster does not unexpectedly relist a removed employee');
    console.log('Verified guarded keyboard Delete, exact payroll retention, and temporary record navigation.');

    // The debounce saver is allowed to run, then the same real browser origin reloads.
    await page.waitForFunction(expected => JSON.parse(localStorage.getItem(KEY)).staffEdits['arch-12']?.at === expected && JSON.parse(localStorage.getItem(KEY)).staffEdits['arch-12']?.listed === false, marker.at);
    await page.reload(); await offline();
    await page.evaluate(() => { S.month = '2026-10'; staffArchiveOpen = true; staffArchiveSearch = ''; staffArchivePage = 2; go('roster'); });
    assert.deepEqual(await protectedState(), before, 'real localStorage reload retains the complete hidden employee and payroll inputs');
    assert.deepEqual(await read(), beforePay);
    assert.deepEqual(await page.evaluate(() => S.staffEdits['arch-12']), marker);
    assert(!(await uiRows()).includes('arch-12'), 'reload cannot resurrect deleted archive membership');
    console.log('Verified real reload.');
    const hiddenState = await page.evaluate(() => structuredClone(S));

    await page.evaluate(incoming => { cloudStaffBase = captureCloudStaffBase(incoming); mergeRemoteStaffHistory(incoming); render(); }, structuredClone(originalState));
    assert.deepEqual(await page.evaluate(() => S.staffEdits['arch-12']), marker, 'stale remote archive rows cannot undo the newer local list tombstone');
    assert(!(await uiRows()).includes('arch-12'));
    assert.deepEqual(await read(), beforePay);
    console.log('Verified cloud and backup merge preservation.');
    await page.evaluate(({ local, remote }) => { S = normalize(local); cloudStaffBase = captureCloudStaffBase(local); mergeRemoteStaffHistory(remote); render(); }, { local: structuredClone(originalState), remote: structuredClone(hiddenState) });
    assert.deepEqual(await page.evaluate(() => S.staffEdits['arch-12']), marker, 'another browser adopts the remote list deletion');
    assert(!(await uiRows()).includes('arch-12'));
    assert.deepEqual(await read(), beforePay);
    await page.evaluate(incoming => { applyState(incoming); render(); }, structuredClone(originalState));
    assert.deepEqual(await page.evaluate(() => S.staffEdits['arch-12']), marker, 'importing an older complete backup preserves list deletion');
    assert(!(await uiRows()).includes('arch-12'));
    assert.deepEqual(await read(), beforePay);
    const legacyActive = structuredClone(originalState), legacyPerson = legacyActive.staffArchive.find(e => e.id === 'arch-12');
    legacyActive.staffArchive = legacyActive.staffArchive.filter(e => e.id !== 'arch-12');
    legacyActive.staff.push(legacyPerson); delete legacyActive.staffEdits['arch-12'];
    await page.evaluate(incoming => { applyState(incoming); render(); }, legacyActive);
    assert.equal(await page.evaluate(() => isArchivedStaff('arch-12')), true, 'a legacy active snapshot cannot override the newer archive deletion status');
    assert.deepEqual(await page.evaluate(() => S.staffEdits['arch-12']), marker);
    assert(!(await uiRows()).includes('arch-12'));
    assert.deepEqual(await read(), beforePay);

    await page.evaluate(() => { S.month = '2026-09'; render(); });
    assert.deepEqual((await read()).find(r => r.id === 'arch-12'), { id: 'arch-12', days: 1, hours: 4, nightHours: 4, wage: 12000, base: 48000, night: 24000, bonus: 5000, adjustment: 300, pay: 77300, total: 88895 }, 'prior-month historical payroll stays exact too');
    await page.evaluate(() => { S.month = '2026-11'; S.roster['2026-11'] = {}; fillDefault(); copyRosterMonth(); render(); });
    assert(!(await read()).some(r => r.id === 'arch-12'), 'a deleted employee with no work in this month stays absent from payroll');
    assert.equal(await page.locator('button[data-staff-archive-open="arch-12"]').count(), 0);
    assert.equal(await page.evaluate(() => Object.keys(S.roster['2026-11']).some(key => key.startsWith('arch-12|'))), false, 'default fill and previous-month copy do not create hidden employee shifts');
    await page.evaluate(incoming => { S = normalize(incoming); S.month = '2026-10'; cloudStaffBase = null; openStaffArchive('unknown'); }, structuredClone(hiddenState));

    await deletion('unknown').click();
    const unknownMarker = await page.evaluate(() => structuredClone(S.staffEdits.unknown));
    assert.equal(unknownMarker.listed, false);
    const unknownRecord = await page.evaluate(() => structuredClone(findStaff('unknown')));
    assert.deepEqual(unknownRecord, originalState.staffArchive.find(e => e.id === 'unknown'), 'unknown employee metadata is retained exactly');
    await page.locator('button[data-staff-archive-open="unknown"]').click();
    assert((await page.locator('tr[data-staff-archive-id="unknown"]').innerText()).includes('기록만 보관'));
    const priorAlert = dialogs.length;
    await page.evaluate(() => staffRestore('unknown'));
    assert.equal(dialogs.length, priorAlert + 1); assert.equal(dialogs.at(-1).type, 'alert');
    assert.equal(await page.evaluate(() => S.staff.some(e => e.id === 'unknown')), false, 'unknown history cannot silently become an active employee');
    assert.deepEqual(await page.evaluate(() => S.staffEdits.unknown), unknownMarker);
    assert.deepEqual(await page.evaluate(() => findStaff('unknown')), unknownRecord);
    assert.deepEqual(await read(), beforePay);
    await page.locator('#staffArchiveRecordClose').click();
    console.log('Verified work-month filtering/default copy exclusion and unknown-history deletion.');

    // Removing the final row on a second page clamps pagination immediately.
    await page.evaluate(() => { staffArchiveSearch = ''; staffArchivePage = 2; staffArchiveOpen = true; render(); });
    await deletion('arch-10').click();
    await deletion('arch-11').click();
    assert.equal(await page.evaluate(() => staffArchivePage), 1);
    assert.equal(await page.locator('#staffArchive tr[data-staff-archive-id]').count(), 10);
    assert((await page.locator('#staffArchive summary').innerText()).includes('10명'));
    assert.equal(await page.locator('#staffArchive img').count(), 0);
    assert.equal(await page.evaluate(() => window.__archiveXss), undefined);
    await page.locator('#staffArchiveSearch').fill('보관 0');
    assert.deepEqual(await uiRows(), ['arch-00']);
    await deletion('arch-00').click();
    assert.deepEqual(await uiRows(), [], 'deleting a searched result keeps the query and correctly shows an empty result');
    assert.equal(await page.locator('#staffArchiveSearch').inputValue(), '보관 0');
    const noHistory = await page.evaluate(() => structuredClone(findStaff('arch-00')));
    await page.evaluate(() => { applyState({ staff: [], staffArchive: [], roster: {}, settings: structuredClone(S.settings) }); render(); });
    assert.deepEqual(await page.evaluate(() => findStaff('arch-00')), noHistory, 'an empty older import cannot discard the hidden record even if it has no shifts');
    assert.equal(await page.evaluate(() => S.staffEdits['arch-00'].listed), false);
    assert.equal(await page.locator('input[data-staff-archive-name="arch-00"]').count(), 0);

    await page.evaluate(incoming => { S = normalize(incoming); cloudStaffBase = null; staffArchiveSearch = ''; staffArchivePage = 2; staffArchiveOpen = true; render(); }, structuredClone(hiddenState));
    const newerArchived = structuredClone(hiddenState);
    newerArchived.staffEdits['arch-12'] = { at: new Date(Date.parse(marker.at) + 1).toISOString(), status: 'archive' };
    await page.evaluate(incoming => { mergeRemoteStaffHistory(incoming); openStaffArchive('arch-12'); }, newerArchived);
    assert.equal(await deletion('arch-12').count(), 1, 'a legitimately newer explicit archive status may relist a person');
    assert.deepEqual(await read(), beforePay);
    await page.evaluate(incoming => { S = normalize(incoming); cloudStaffBase = null; openStaffArchive('arch-12'); }, structuredClone(hiddenState));
    await page.locator('tr[data-staff-archive-id="arch-12"]').getByRole('button', { name: '명단으로 복귀', exact: true }).click();
    assert.equal(await page.evaluate(() => S.staff.some(e => e.id === 'arch-12')), true, 'explicit restoration is still available from historical-record preview');
    assert.equal(await page.evaluate(() => S.staffArchive.some(e => e.id === 'arch-12')), false);
    assert.equal(await page.evaluate(() => S.staffEdits['arch-12'].status), 'active');
    assert.equal(await page.evaluate(() => S.staffEdits['arch-12'].listed), undefined, 'restoration clears the list-deletion flag');
    assert.deepEqual(await read(), beforePay, 'explicit restore preserves hours, rate, bonus and full payroll');
    assert.equal(await page.locator('button[data-staff-archive-open="arch-12"]').count(), 0, 'the restored payroll name is no longer an archive link');
    await page.evaluate(incoming => { mergeRemoteStaffHistory(incoming); render(); }, structuredClone(hiddenState));
    assert.equal(await page.evaluate(() => S.staff.some(e => e.id === 'arch-12')), true, 'an older deletion cannot override newer explicit restoration');
    assert.deepEqual(await read(), beforePay);
    await page.evaluate(() => { staffDel(S.staff.findIndex(e => e.id === 'arch-12')); openStaffArchive('arch-12'); });
    assert.equal(await deletion('arch-12').count(), 1, 'rearchiving a restored employee starts a fresh visible archive membership');
    assert.equal(await page.evaluate(() => S.staffEdits['arch-12'].listed), undefined);
    assert.deepEqual(await read(), beforePay);

    const rearchivedCsv = await csvText(page);
    await deletion('arch-12').click();
    const print = await printedText(page);
    assert(print.includes('삭제 대상'), 'the actual printed roster/payroll retains the hidden employee name');
    assert(print.includes('345,000') || print.includes('345000'), 'the actual printed payroll retains the independently known total');
    assert(!print.includes('기록만 보관'), 'archive management controls and badges never leak into the printed payroll');
    assert.deepEqual(await read(), beforePay);
    assert.equal(await csvText(page), rearchivedCsv, 'the final list deletion preserves the actual CSV byte-for-byte, including its current row order');
    assert.deepEqual(pageErrors, [], 'archive deletion and record navigation produce no browser errors');
    console.log('PASS archived-list deletion: keyboard confirmation/cancel, guarded IDs, exact retained payroll/history/CSV/PDF, real reload, cloud/backup tombstones, targeted record preview, search/pagination, unknown-history safeguards, and explicit restore/rearchive.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
