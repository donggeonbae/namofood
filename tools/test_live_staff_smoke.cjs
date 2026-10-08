// Read-only production smoke: reject writes and AI run requests before loading.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
(async()=>{
  const expected=process.env.NMF_EXPECTED_VER||'1009-8-archive-delete';
  const password=process.env.NMF_PW;if(!password)throw new Error('NMF_PW is required');
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(pw=>sessionStorage.setItem('nmf_session_pw',pw),password);
    const page=await context.newPage();let documents=0,blockedWrites=0;const statuses=[];
    await page.route('**/*',route=>{
      const request=route.request();if(request.isNavigationRequest())documents++;
      if(['GET','HEAD','OPTIONS'].includes(request.method()))return route.continue();
      let action;try{action=request.postDataJSON()?.action;}catch{}
      if(request.method()==='POST'&&request.url().endsWith('/functions/v1/nmf-recipe-fill')&&action==='status')return route.continue();
      blockedWrites++;return route.abort();
    });
    page.on('response',response=>{if(response.url().endsWith('/functions/v1/nmf-recipe-fill'))statuses.push({status:response.status(),origin:response.headers()['access-control-allow-origin']});});
    await page.goto('https://d-bae.com/namofood/?v='+encodeURIComponent(expected)+'#roster',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(version=>document.getElementById('appver')?.textContent==='버전 '+version,expected,{timeout:45000});
    await page.waitForFunction(()=>S.staff.length>0&&(S.staffArchive||[]).length>0&&S.settings.rolePayInitialized,null,{timeout:20000});
    console.log(JSON.stringify({phase:'live-staff-loaded',activeCount:await page.evaluate(()=>S.staff.length),archiveCount:await page.evaluate(()=>S.staffArchive.length)}));
    await page.evaluate(()=>{cloudApplying=true;clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);go('roster');});
    const staff=await page.evaluate(()=>{
      const targets=JSON.parse('['+initializeStaffPay.toString().match(/for\(const e of state\.staff\|\|\[\]\)if\(\[(.*?)\]\.includes\(e\.name\)\)e\.wage=20000/)[1].replaceAll("'",'"')+']');
      return {roles:staffRoles(),wages:S.settings.roleWages,named:targets.map(name=>staffWage(S.staff.find(e=>e.name===name))),archives:S.staffArchive.length,workedRows:laborRows().length,workedOnly:laborRows().every(r=>r.h>0)};
    });
    assert.deepEqual(staff.roles,['총괄','조리','보조','이송']);
    assert.deepEqual(staff.wages,{총괄:15000,조리:15000,보조:13000,이송:13000});
    assert.deepEqual(staff.named,[20000,20000,20000]);assert(staff.workedOnly);
    assert.equal(await page.locator('#staffArchive').getAttribute('open'),null);
    assert.match(await page.locator('#staffArchive summary').innerText(),/^보관된 명단/);
    assert.equal(await page.locator('#staff-directory-table .staff-action').first().innerText(),'삭제/보관');
    const archiveUiState=await page.evaluate(()=>JSON.stringify(S));
    const archiveTarget=await page.evaluate(()=>laborRows().find(row=>isArchivedStaff(row.e.id))?.e.id||null);
    assert(archiveTarget,'the current month contains at least one archived payroll row for read-only navigation checks');
    await page.evaluate(()=>{staffArchiveSearch='no-match-read-only-check';staffArchivePage=1;render();});
    const archiveButton=page.locator('[data-staff-archive-open]').filter({hasText:/.+/}).first();
    await archiveButton.focus();await archiveButton.press('Enter');
    const archiveNavigation=await page.evaluate(()=>{
      const input=document.activeElement,id=input?.dataset.staffArchiveName,index=staffArchiveDisplayRows().findIndex(e=>e.id===id);
      return {open:document.getElementById('staffArchive').open,filter:staffArchiveSearch,page:staffArchivePage,expectedPage:Math.floor(index/10)+1,focused:!!id,nameCorrect:input?.value===findStaff(id)?.name,editableInputs:document.querySelectorAll('[data-staff-archive-name]').length};
    });
    assert(archiveNavigation.open&&archiveNavigation.focused&&archiveNavigation.nameCorrect,'payroll name opens the correct editable archived employee');
    assert.equal(archiveNavigation.filter,'');assert.equal(archiveNavigation.page,archiveNavigation.expectedPage);assert(archiveNavigation.editableInputs>0&&archiveNavigation.editableInputs<=10);
    assert.equal(await page.evaluate(()=>JSON.stringify(S)),archiveUiState,'archive navigation, search, focus and page selection cannot mutate production data');
    const visibleDeletions=await page.evaluate(()=>Array.from(document.querySelectorAll('[data-staff-archive-name]')).filter(el=>isStaffArchiveListed(el.dataset.staffArchiveName)).length);
    assert.equal(await page.locator('[data-staff-archive-delete]').count(),visibleDeletions,'each normally listed archive row has its own Delete button');
    assert(visibleDeletions>0,'the production archive contains a listed row for the cancel-only Delete check');
    const dialogReady=page.waitForEvent('dialog',{timeout:5000}),deletePress=page.locator('[data-staff-archive-delete]').first().press('Enter');
    const dialog=await dialogReady;assert.equal(dialog.type(),'confirm');assert.match(dialog.message(),/보관된 명단에서 삭제/);assert.match(dialog.message(),/근무시간·인건비/);
    await dialog.dismiss();await deletePress;
    assert.equal(await page.evaluate(()=>JSON.stringify(S)),archiveUiState,'canceling Delete cannot modify any real employee, shift or payroll');
    await page.screenshot({path:'/tmp/nmf-live-staff-archive-edit.png',fullPage:true});
    await page.locator('#staffArchive summary').click();
    const directoryWidths=[];
    for(const width of [1280,1024,390,320]){
      await page.setViewportSize({width,height:1000});
      const size=await page.evaluate(()=>{
        const table=document.getElementById('staff-directory-table'),wrap=document.getElementById('staff-directory-wrap');
        return {width:innerWidth,table:table.scrollWidth,tableClient:table.clientWidth,wrap:wrap.scrollWidth,wrapClient:wrap.clientWidth,fields:table.tBodies[0].rows[0].cells.length};
      });
      assert(size.table<=size.tableClient+1&&size.wrap<=size.wrapClient+1,'live directory fits at '+width);
      assert.equal(size.fields,10);directoryWidths.push(size);
    }
    await page.setViewportSize({width:1280,height:1000});
    const rosterBefore=await page.evaluate(()=>JSON.stringify(S.roster));
    await page.locator('button[data-roster-bulk-week]').nth(1).click();
    assert.equal(await page.locator('#rosterBulkPanel').count(),1);
    assert.equal(await page.locator('#rb_s_h').count(),1);
    await page.locator('.roster-week-card[data-week="1"] input.roster-bulk-check').first().check();
    assert.match(await page.locator('#rosterBulkCount').innerText(),/1칸/);
    await page.locator('#rosterBulkCancel').click();
    assert.equal(await page.evaluate(()=>JSON.stringify(S.roster)),rosterBefore,'opening/selecting/canceling never changes real roster');
    assert.equal(await page.locator('.roster-bulk-check').count(),0);
    await page.setViewportSize({width:1440,height:1000});
    assert.equal(await page.locator('#staffRoleSettings').count(),1);
    await page.locator('#staffRoleSettings summary').click();
    assert.equal(await page.locator('input[data-role-wage]').count(),4);
    await page.screenshot({path:'/tmp/nmf-live-staff-roles.png',fullPage:true});
    await page.evaluate(()=>go('menu'));
    assert.equal(await page.locator('input[data-print-meal]').count(),4);
    await page.evaluate(()=>go('sales'));
    assert.equal(await page.locator('#ticketMealStats').getAttribute('open'),null);
    await page.evaluate(async()=>{go('recipe');await refreshRecipeMonitor(true);});
    await page.waitForFunction(()=>!recipeMonitor.busy&&recipeMonitor.checked>0,null,{timeout:20000});
    const monitor=await page.evaluate(()=>({error:recipeMonitor.error,ready:!!recipeMonitor.data?.ok}));
    assert.equal(monitor.error,'');assert(monitor.ready);
    assert(statuses.some(r=>r.status===200&&r.origin==='https://d-bae.com'),'real signed browser status request succeeds with exact production CORS origin');
    await page.waitForTimeout(9000);
    assert.equal(documents,1,'new deployed page must not reload itself');
    assert.equal(await page.locator('#newver').count(),0);
    console.log(JSON.stringify({version:expected,staffChecks:staff,archiveNavigation,archiveDeleteButtons:visibleDeletions,archiveDeleteCanceledWithoutChanges:true,directoryWidths,weeklySelectionCanceledWithoutChanges:true,recipeStatus:monitor,origin:'https://d-bae.com',documents,blockedWrites,productionWrites:0}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error.message);process.exit(1);});
