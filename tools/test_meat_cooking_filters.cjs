// Read-only synthetic UI checks. Never save meals, submit drafts, or call live services.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {chromium} = require('playwright');

const expectedMethods = {
  '제육볶음': '볶음',
  '닭갈비': '볶음',
  '소고기구이': '구이',
  '돼지갈비': '구이',
  '찜닭': '찜',
  '오리찜': '찜',
  '간장닭조림': '조림',
  '등심돈까스': '튀김',
  '가라아게': '튀김',
  '카라아게': '튀김',
  '육전': '부침',
  '돼지고기수육': '삶음',
  '오늘의 닭 특식': '찜',
  '오리 특식': '조림',
  '돼지갈비 양념': '기타/미분류',
};
const methods = ['볶음', '구이', '찜', '조림', '튀김', '부침', '삶음'];
const species = ['소고기', '돼지고기', '닭고기', '오리고기'];
const expectedByMethod = method => Object.keys(expectedMethods).filter(name => expectedMethods[name] === method).sort();

(async () => {
  const source = fs.readFileSync(process.env.NMF_APP_SOURCE || path.join(__dirname, '..', '나모푸드_관리앱.html'), 'utf8');
  for (const match of source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new Function(match[1]);
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    const errors = [];
    let writeRequests = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const request = route.request();
      if (request.isNavigationRequest()) return route.fulfill({contentType: 'text/html', body: source});
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writeRequests++;
      if (request.url().includes('/rest/v1/namofood_state') && request.method() === 'GET') return route.fulfill({json: []});
      return route.abort();
    });
    await page.goto('https://namofood.test/');
    await page.evaluate(() => {
      clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer); cloudApplying = true;
      S.month = '2026-10'; S.recipes = []; S.methods = {}; S.recipeMeta = {}; S.recipeAsk = {}; S.sources = {};
      S.staff = []; S.staffArchive = []; S.roster = {}; S.rosterEdits = {};
      const add = (menu, item, method, comp = '주찬') => {
        S.recipes.push({menu, item, comp, qty: 100, unit: 'g', loss: 0, storage: '냉장', form: '원물'});
        if (method) S.methods[menu] = method;
      };
      add('제육볶음', '돼지고기', '1. 돼지고기를 회전식 볶음솥에서 볶는다.');
      add('닭갈비', '닭고기', '1. 닭고기를 양념한다. 2. 회전식 볶음솥에서 닭고기와 채소를 볶는다.');
      add('소고기구이', '소고기', '1. 소고기를 철판에서 앞뒤로 굽는다.');
      add('돼지갈비', '돼지고기', '1. 돼지갈비를 양념한다. 2. 대형 그릴에서 앞뒤로 굽는다.');
      add('찜닭', '닭고기', '1. 솥에 닭고기를 넣고 뚜껑을 덮어 찐다.');
      add('오리찜', '오리고기', '1. 찜기에 오리고기를 넣고 찐다.');
      add('간장닭조림', '닭고기', '1. 닭고기를 양념에 넣고 약불에서 졸인다.');
      add('등심돈까스', '돼지고기', '1. 빵가루를 입힌 등심을 대형 튀김기에서 튀긴다.');
      add('가라아게', '닭고기', '1. 닭다리살에 양념과 전분을 입힌다. 2. 대형 튀김기 175℃에서 배치별로 튀긴다.');
      add('카라아게', '닭고기', '1. 닭다리살을 양념한다. 2. 튀김기에서 닭고기를 튀긴다.');
      add('육전', '소고기', '1. 얇은 소고기에 달걀물을 입힌다. 2. 넓은 철판에서 앞뒤로 부친다.');
      add('돼지고기수육', '돼지고기', '1. 솥에 돼지고기를 넣고 물을 부어 푹 삶는다.');
      add('오늘의 닭 특식', '닭고기', '');
      S.recipes.find(row => row.menu === '오늘의 닭 특식').method = '1. 양념한 닭고기를 대형 찜기에 넣어 찐다.';
      add('오리 특식', '오리고기', '');
      S.recipes.find(row => row.menu === '오리 특식').method = '조림';
      add('돼지갈비 양념', '돼지고기', '1. 식수를 확인해 재료를 계량한다. 2. 양념을 섞어 냉장 보관한다.');
      for (const [method, fish, vegetable] of [
        ['볶음', '생선볶음', '가지볶음'], ['구이', '고등어구이', '가지구이'],
        ['찜', '생선찜', '단호박찜'], ['조림', '코다리조림', '우엉조림'],
        ['튀김', '생선까스', '감자튀김'], ['부침', '동태전', '애호박전'],
      ]) { add(fish, '고등어', `${method} 작업 순서`); add(vegetable, '가지', `${method} 작업 순서`, '부찬'); }
      S.menus = {'2026-10': {'12|중식|2': '보존할 수동 고기', '12|중식|7': '보존할 수동 생선', '12|중식|n': '333', '12|석식|2': '다른 끼니'}};
      S.menuPlanMeta = {}; S.headcountMeta = {'2026-10-12|중식': {by: 'manual', source: 'fixture'}};
      S.menuAutomation = {enabled: false, policy: 'manual-menu-v1'}; S.menuManualEdits = {};
      S.settings.fixtureSentinel = {value: 'preserve'};
      // Initialize the existing print-meal defaults before comparing filter-only effects.
      // viewCfg lazily fills these on the first meal-page visit; filters do not own it.
      viewCfg(); recipeDraftClear(); recipeResetFilters(); rSel = null; selDay = 12; go('recipe');
      clearTimeout(saveTimer); clearTimeout(cloudTimer); localStorage.setItem(KEY, JSON.stringify(S));
    });
    const before = await page.evaluate(() => ({state: JSON.stringify(S), stored: localStorage.getItem(KEY)}));
    const observedMethods = await page.evaluate(names => {
      const map = recipeMap();
      return Object.fromEntries(names.map(name => [name, recipeCookingMethod(name, map[name])]));
    }, Object.keys(expectedMethods));
    // Discriminating pre-fix checks: cuisine names and plain ribs must not fall out of the method groups.
    assert.equal(observedMethods['가라아게'], '튀김', 'karaage belongs in fried meat, not unclassified');
    assert.equal(observedMethods['육전'], '부침', 'beef jeon belongs in pan-fried meat');
    assert.equal(observedMethods['닭갈비'], '볶음', 'dakgalbi follows its stir-frying steps');
    assert.equal(observedMethods['돼지갈비'], '구이', 'plain pork ribs use their stored grilling steps');
    assert.equal(observedMethods['돼지갈비 양념'], '기타/미분류', 'ribs without a cooking action must not be guessed as grilled');
    assert.equal(observedMethods['오늘의 닭 특식'], '찜', 'an ambiguous name uses the stored ingredient-row cooking steps');
    assert.equal(observedMethods['오리 특식'], '조림', 'a stored ingredient-row method label remains discoverable');
    assert.deepEqual(observedMethods, expectedMethods);
    const boundaryMethods = await page.evaluate(() => {
      const row = method => [{item:'돼지고기',qty:100,unit:'g',comp:'주찬',method}];
      return {
        namedGrill: recipeCookingMethod('닭갈비구이', [{item:'닭고기',qty:100,comp:'주찬'}]),
        namedFry: recipeCookingMethod('제육튀김', row('')),
        preparationOnly: recipeCookingMethod('분류 경계 특식 A', row('1. 돼지고기를 계량한다. 2. 튀김기와 볶음솥을 준비한다. 3. 양파를 볶는다.')),
        sameStepVegetableOnly: recipeCookingMethod('분류 경계 특식 B', row('1. 돼지고기는 냉장 보관하고 양파만 볶는다.')),
        sameStepSauceOnly: recipeCookingMethod('분류 경계 특식 E', row('1. 돼지고기는 핏물을 제거하고 소스만 볶는다.')),
        sameStepWashAndVegetableOnly: recipeCookingMethod('분류 경계 특식 F', row('1. 돼지고기를 씻고 양파만 굽는다.')),
        sameStepMarinadeAndSauceOnly: recipeCookingMethod('분류 경계 특식 G', row('1. 돼지고기는 양념해 두고 소스만 졸인다.')),
        mainAndVegetablesTogether: recipeCookingMethod('분류 경계 특식 H', row('1. 돼지고기와 양파를 함께 볶는다.')),
        mainGrillAfterVegetables: recipeCookingMethod('분류 경계 특식 C', row('1. 양파를 볶는다. 2. 돼지고기를 그릴에서 굽는다.')),
        conflictingMainSteps: recipeCookingMethod('분류 경계 특식 D', row('1. 돼지고기를 볶는다. 2. 같은 고기를 튀긴다.')),
      };
    });
    assert.deepEqual(boundaryMethods, {namedGrill:'구이',namedFry:'튀김',preparationOnly:'기타/미분류',sameStepVegetableOnly:'기타/미분류',sameStepSauceOnly:'기타/미분류',sameStepWashAndVegetableOnly:'기타/미분류',sameStepMarinadeAndSauceOnly:'기타/미분류',mainAndVegetablesTogether:'볶음',mainGrillAfterVegetables:'구이',conflictingMainSteps:'기타/미분류'}, 'equipment, preparation and side-vegetable actions cannot replace the main meat cooking method');

    const consumerNames = consumer => consumer === 'recipe'
      ? page.locator('#rlist .rchip').allTextContents()
      : page.locator('#pklist>button').evaluateAll(buttons => buttons.map(button => button.firstChild.textContent.trim()));
    const expectedSpecies = (method, meat) => Object.keys(expectedMethods).filter(name => expectedMethods[name] === method && ({'제육볶음': '돼지고기', '닭갈비': '닭고기', '소고기구이': '소고기', '돼지갈비': '돼지고기', '찜닭': '닭고기', '오리찜': '오리고기', '간장닭조림': '닭고기', '등심돈까스': '돼지고기', '가라아게': '닭고기', '카라아게': '닭고기', '육전': '소고기', '돼지고기수육': '돼지고기', '오늘의 닭 특식': '닭고기', '오리 특식': '오리고기'})[name] === meat).sort();
    let checkedMethodLists = 0, checkedSpeciesLists = 0;
    for (const consumer of ['recipe', 'meal', 'draft']) {
      const prefix = consumer === 'recipe' ? 'recipe' : 'pk';
      if (consumer === 'recipe') await page.evaluate(() => {go('recipe'); recipeResetFilters();});
      if (consumer === 'meal') await page.evaluate(() => {go('menu'); openPicker(12, '중식', 2);});
      if (consumer === 'draft') await page.evaluate(() => {go('recipe'); openDraftPicker(2);});
      if (consumer !== 'recipe') {
        assert.match(await page.locator(`#${prefix}-methods`).evaluate(element => element.previousElementSibling.textContent), /고기.*조리방식|조리방식.*고기/, `${consumer}: the meat slot is labelled before any category button is pressed`);
        for (const method of methods) assert.equal(await page.locator(`#${prefix}-methods [data-method="${method}"]`).count(), 1, `${consumer}: default meat-slot picker exposes ${method}`);
      }
      await page.locator(`#${prefix}-ingredients [data-ingredient="고기"]`).click();
      assert.match(await page.locator(`#${prefix}-methods`).evaluate(element => element.previousElementSibling.textContent), /고기.*조리방식|조리방식.*고기/, `${consumer}: cooking methods clearly belong to the meat group`);
      assert.equal(await page.locator(`#${prefix}-subingredients`).evaluate(element => element.open), false, `${consumer}: meat species start collapsed`);
      assert(await page.evaluate(prefix => !!(document.getElementById(`${prefix}-ingredients`).compareDocumentPosition(document.getElementById(`${prefix}-methods`)) & Node.DOCUMENT_POSITION_FOLLOWING), prefix), `${consumer}: main ingredient precedes cooking method`);
      assert.deepEqual((await consumerNames(consumer)).sort(), Object.keys(expectedMethods).sort(), `${consumer}: one meat umbrella contains all species and no fish/vegetables`);
      for (const method of methods) {
        const button = page.locator(`#${prefix}-methods [data-method="${method}"]`);
        assert.equal(await button.count(), 1, `${consumer}: ${method} is selectable`);
        await button.click();
        assert.deepEqual((await consumerNames(consumer)).sort(), expectedByMethod(method), `${consumer}: ${method} displays the exact matching meat recipes`);
        assert.equal(await page.locator(`#${prefix}-ingredients [data-ingredient="고기"]`).getAttribute('aria-pressed'), 'true', `${consumer}: method changes retain meat category`);
        checkedMethodLists++;
      }
      await page.locator(`#${prefix}-subingredients summary`).click();
      for (const meat of species) {
        assert.equal(await page.locator(`#${prefix}-subingredients [data-subingredient="${meat}"]`).count(), 1, `${consumer}: optional ${meat} subtype is available`);
        for (const method of methods.filter(method => expectedSpecies(method, meat).length)) {
          await page.locator(`#${prefix}-subingredients [data-subingredient="${meat}"]`).click();
          await page.locator(`#${prefix}-methods [data-method="${method}"]`).click();
          assert.deepEqual((await consumerNames(consumer)).sort(), expectedSpecies(method, meat), `${consumer}: ${meat} intersects ${method} without escaping meat`);
          checkedSpeciesLists++;
        }
      }
      await page.locator(`#${prefix}-subingredients [data-subingredient="오리고기"]`).click();
      for (const method of methods.filter(method => !expectedSpecies(method, '오리고기').length)) {
        const emptyMethod = page.locator(`#${prefix}-methods [data-method="${method}"]`);
        assert.equal(await emptyMethod.count(), 1, `${consumer}: a zero-count meat method stays visible`);
        assert.equal(await emptyMethod.isDisabled(), true, `${consumer}: zero-count ${method} is disabled rather than omitted`);
        assert.equal(await emptyMethod.locator('small').textContent(), '0', `${consumer}: unavailable method gives its exact count`);
      }
      assert.equal(await page.locator(`#${prefix}-subingredients [data-subingredient="가지"]`).count(), 0, `${consumer}: vegetables are not meat subtypes`);
      if (consumer !== 'recipe') await page.evaluate(() => closePicker());
      assert.deepEqual(await page.evaluate(() => ({state: JSON.stringify(S), stored: localStorage.getItem(KEY)})), before, `${consumer}: every category, species and method change leaves saved state untouched`);
    }
    assert.equal(checkedMethodLists, 21, 'all seven methods run in all three consumers');
    assert.equal(checkedSpeciesLists, 36, 'all twelve non-empty species/method combinations run in all three consumers');
    assert.equal(await page.evaluate(() => recipeDraftEntries().filter(entry => entry.name).length), 0, 'method filtering cannot silently add a draft dish');
    assert.equal(writeRequests, 0, 'no service write requests are made');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({methodLists: checkedMethodLists, speciesLists: checkedSpeciesLists, stateUnchanged: true, productionWrites: 0, sourceSha256: createHash('sha256').update(source).digest('hex')}));
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exit(1);});
