// Artifact Tool owns workbook authoring. Browser code only fills this template.
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {inflateRawSync} from 'node:zlib';
import assert from 'node:assert/strict';
const work=process.env.NMF_SHEET_WORK;
if(!work)throw Error('NMF_SHEET_WORK must contain the bundled node_modules symlink');
const require=createRequire(resolve(work,'entry.cjs'));
const {Workbook,SpreadsheetFile,FileBlob}=await import(pathToFileURL(require.resolve('@oai/artifact-tool')).href);
if(process.argv.includes('--verify-file')){
 const file=process.argv[process.argv.indexOf('--verify-file')+1],wb=await SpreadsheetFile.importXlsx(await FileBlob.load(file));wb.recalculate();
 if(process.env.NMF_REPORT_EXPECTED_TOTAL){const s=wb.worksheets.getItem('월간 요약');assert.equal(s.getRange('A6').values[0][0],Number(process.env.NMF_REPORT_EXPECTED_TOTAL),'imported workbook formulas recalculate to the source-control total');for(const [cell,v]of [['G6',10],['C22',0],['D22',-100],['I22',-1100000],['D25',-95]])assert.equal(s.getRange(cell).values[0][0],v,'zero and missing values preserve comparison formula '+cell);}
 if(process.env.NMF_REPORT_COUNTS){const s=wb.worksheets.getItem('월간 요약');assert.equal(s.getRange('A6').values[0][0],215500);assert.equal(s.getRange('C15').values[0][0],48000);}
 if(process.env.NMF_REPORT_EXPECTED_TOTAL||process.env.NMF_REPORT_COUNTS){const s=wb.worksheets.getItem('월간 요약');assert.equal(s.getRange('K11').values[0][0],3,'unentered dates never become entered zero revenue on recalculation');assert.equal(s.getRange('E12').values[0][0],2);assert.equal(s.getRange('E13').values[0][0],1);}
 console.log((await wb.inspect({kind:'table',range:'월간 요약!A5:L14',include:'values,formulas',tableMaxRows:10,tableMaxCols:12,maxChars:2500})).ndjson);
 console.log((await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!',options:{useRegex:true,maxResults:30},maxChars:1500})).ndjson);
 for(const [sheet,range,name]of [['월간 요약','A1:L31','summary'],['일별 판매','A1:L24','daily'],['끼니별 비교','A49:M60','meals'],['결제별 식수','A1:L18','counts'],['결제별 식수','A49:L60','counts-detail']]){const img=await wb.render({sheetName:sheet,range,scale:1.5,format:'png'});await fs.writeFile(resolve(work,name+'.png'),new Uint8Array(await img.arrayBuffer()));}
 if(process.env.NMF_REPORT_EXPECTED_TOTAL){const s=wb.worksheets.getItem('월간 요약'),d=wb.worksheets.getItem('일별 판매'),m=wb.worksheets.getItem('끼니별 비교');m.getRange('E53').values=[[11]];wb.recalculate();assert.equal(s.getRange('A6').values[0][0],124500,'editing authoritative meal count updates report total');assert.equal(d.getRange('C20').values[0][0],11);d.getRange('C5').values=[[10500]];wb.recalculate();assert.equal(s.getRange('A6').values[0][0],130000,'ticket price updates every report');d.getRange('N20').values=[[4000]];wb.recalculate();assert.equal(s.getRange('A6').values[0][0],131000,'legacy channel input is added once');console.log('AUTHORITATIVE_INPUT_FORMULA_EDIT_RECALCULATION_OK');}
 if(process.env.NMF_REPORT_COUNTS){const s=wb.worksheets.getItem('월간 요약'),c=wb.worksheets.getItem('결제별 식수');c.getRange('F55').values=[[5]];wb.recalculate();assert.equal(s.getRange('A6').values[0][0],227500,'credit count edit updates sale revenue');assert.equal(s.getRange('C15').values[0][0],60000);wb.worksheets.getItem('일별 판매').getRange('D5').values=[[11500]];wb.recalculate();assert.equal(s.getRange('A6').values[0][0],229000,'card count follows authoritative meal price');console.log('CASH_CARD_CREDIT_COUNT_RECALCULATION_OK');}
 process.exit(0);
}
const wb=Workbook.create(),names=['월간 요약','일별 판매','끼니별 비교','결제별 식수'],sheets=names.map(n=>wb.worksheets.add(n));
if(process.argv.includes('--help-print')){console.log(wb.help('worksheet.pageLayout',{include:'index,examples,notes',maxChars:5000}).ndjson);process.exit(0);}
const navy='#203750',muted='#66768A',blue='#175CD3',red='#B42318',line='#DEE5ED';
const number='#,##0;[Red]-#,##0;"—"',signed='[Blue]+#,##0;[Red]-#,##0;"—"';
function value(s,cell,v){s.getRange(cell).values=[[v]];}function formula(s,cell,f){s.getRange(cell).formulas=[[f]];}
function span(s,range,text){s.mergeCells(range);value(s,range.split(':')[0],text);}
function band(s,range,label){span(s,range,label);s.getRange(range).format={fill:navy,font:{bold:true,color:'#FFFFFF'},rowHeight:25};}
function header(s,range,values){s.getRange(range).values=[values];s.getRange(range).format={fill:navy,font:{bold:true,color:'#FFFFFF'},horizontalAlignment:'center',wrapText:true,rowHeight:30};}
function paymentSum(col,r){return `SUMIFS('결제별 식수'!$${col}$9:$${col}$132,'결제별 식수'!$A$9:$A$132,A${r},'결제별 식수'!$C$9:$C$132,C${r})`;}
function paymentCount(col,r){return ({H:['D','N'],I:['E','O'],J:['F']}[col]).map(raw=>`COUNTIFS('결제별 식수'!$A$9:$A$132,A${r},'결제별 식수'!$C$9:$C$132,C${r},'결제별 식수'!$${raw}$9:$${raw}$132,"<>")`).join('+');}
for(const [i,s]of sheets.entries()){
 const last=i===2?'M':'L',end=i===0?33:i===1?43:134;
 s.showGridLines=false;s.tabColor=i===0?navy:i===1?'#52769A':'#8BA0B5';
 s.getRange('A1:'+last+end).format={font:{name:'Arial',size:10,color:'#23384E'},verticalAlignment:'center',rowHeight:23};
 s.getRange('A1:'+last+end).format.columnWidth=11;
 span(s,'A2:'+last+'2',['나모푸드 월간 판매 보고서','일별 판매 실적','끼니별 판매·예상 비교','현금·카드·당일 외상 식수'][i]);
 s.getRange('A2:'+last+'2').format={font:{size:16,bold:true,color:navy},rowHeight:34,borders:{bottom:{style:'medium',color:navy}}};
 span(s,'A3:'+last+'3','보고 기간');s.getRange('A3:'+last+'3').format.font={size:10,color:muted};
 if(i){s.freezePanes.freezeRows(8);s.freezePanes.freezeColumns(i===2?3:2);}
}
const [summary,daily,meal,counts]=sheets;
summary.getRange('A1:L33').format.columnWidth=9;
span(summary,'A5:F5','실제 매출 합계 (원)');span(summary,'G5:L5','판매 식권 합계 (장)');
span(summary,'A6:F7','');span(summary,'G6:L7','');
for(const r of ['A5:F7','G5:L7'])summary.getRange(r).format={fill:'#EEF3F8',rowHeight:25,font:{color:navy}};
summary.getRange('A6:L7').format.font={size:16,bold:true,color:navy};summary.getRange('A6:L7').format.horizontalAlignment='left';
formula(summary,'A6',`=IF(COUNT('일별 판매'!K9:K39)=0,"",SUM('일별 판매'!K9:K39))`);
formula(summary,'G6',`=IF(COUNT('일별 판매'!C9:F39)=0,"",SUM('일별 판매'!C9:F39))`);
summary.getRange('A6:L7').setNumberFormat(number);
band(summary,'A9:L9','01  매출 구성');
header(summary,'A10:F10',['항목','','금액 (원)','','입력 일수','']);
for(const [i,label,col]of [[0,'식권 매출','G'],[1,'별도 현금 매출','H'],[2,'별도 카드 매출','I'],[3,'기타 매출','J'],[4,'당일 외상 매출','L']]){const r=11+i;span(summary,`A${r}:B${r}`,label);span(summary,`C${r}:D${r}`,'');span(summary,`E${r}:F${r}`,'');formula(summary,'C'+r,`=IF(COUNT('일별 판매'!${col}9:${col}39)=0,"",SUM('일별 판매'!${col}9:${col}39))`);formula(summary,'E'+r,`=COUNT('일별 판매'!${col}9:${col}39)`);}
span(summary,'H10:L10','입력 현황');span(summary,'H11:J11','실제 매출 입력일');span(summary,'K11:L11','');formula(summary,'K11',`=COUNT('일별 판매'!K9:K39)`);
span(summary,'H12:J12','입력일 평균 매출');span(summary,'K12:L12','');formula(summary,'K12','=IF(K11=0,"",A6/K11)');
span(summary,'H14:L14','공란은 미입력, —는 입력된 0입니다.');summary.getRange('H14:L14').format.font={color:muted,size:10};
span(summary,'A16:B16','실제 매출 합계');span(summary,'C16:F16','');formula(summary,'C16','=A6');summary.getRange('A16:F16').format={fill:'#EEF3F8',font:{bold:true,color:navy},borders:{top:{style:'thin',color:navy}}};
band(summary,'A19:L19','02  끼니별 식권 비교');
header(summary,'A20:L20',['끼니','예상 식수','판매 식권','인원 차이','예상 금액','','판매 금액','','금액 차이','','비교 입력','']);
for(const r of [20,21,22,23,24,25])for(const pair of ['E:F','G:H','I:J','K:L']){const [a,b]=pair.split(':');summary.mergeCells(`${a}${r}:${b}${r}`);}
const mealNames=['조식','중식','석식','야식'];
for(let i=0;i<4;i++){const r=21+i,me=mealNames[i];value(summary,'A'+r,me);for(const [out,col]of [['B','D'],['C','E'],['D','F'],['E','H'],['G','I'],['I','J']]){const sum=`SUMIFS('끼니별 비교'!${col}9:${col}132,'끼니별 비교'!C9:C132,A${r})`;formula(summary,out+r,['C','D','G','I'].includes(out)?`=IF(COUNTIFS('끼니별 비교'!C9:C132,A${r},'끼니별 비교'!E9:E132,"<>")=0,"",${sum})`:'='+sum);}formula(summary,'K'+r,`=COUNTIFS('끼니별 비교'!C9:C132,A${r},'끼니별 비교'!E9:E132,"<>")`);}
value(summary,'A25','합계');for(const col of ['B','C','D','E','G','I','K'])formula(summary,col+'25',`=IF(COUNT(${col}21:${col}24)=0,"",SUM(${col}21:${col}24))`);
summary.getRange('A25:L25').format={fill:'#EEF3F8',font:{bold:true,color:navy},borders:{top:{style:'thin',color:navy}}};
for(const [r,text]of [[28,'금액·인원 차이 = 판매 − 예상. 판매 식권을 입력한 끼니만 비교합니다.'],[29,'예상 식수는 직접 입력값을 사용하며, 공란이면 설정된 기본 식수를 적용합니다.'],[30,'실제 매출 = 식권 + 현금 + 카드 + 당일 외상 + 기타. 외상도 발생일 매출에 포함합니다.'],[31,'현금·카드·외상 식수 × 끼니 단가. 이전 금액 원본은 별도 보존하며 식수로 자동 환산하지 않습니다.']])span(summary,`A${r}:L${r}`,text);
summary.getRange('A28:L31').format={font:{size:10,color:muted},rowHeight:22};
summary.getRange('B11:F25').setNumberFormat(number);summary.getRange('K11:L12').setNumberFormat(number);summary.getRange('D21:D25').setNumberFormat(signed);summary.getRange('I21:J25').setNumberFormat(signed);
daily.getRange('A1:A43').format.columnWidth=15;daily.getRange('B1:B43').format.columnWidth=7;daily.getRange('C1:F43').format.columnWidth=9;daily.getRange('G1:L43').format.columnWidth=16;
value(daily,'A5','식권 단가');for(let i=0;i<4;i++){value(daily,String.fromCharCode(67+i)+'5',10000);daily.getRange(String.fromCharCode(67+i)+'5').setNumberFormat('#,##0"원"');}span(daily,'G5:L5','금액: 원 / 식권: 장. 현금·카드는 끼니 미지정 금액 포함.');
daily.getRange('M1:M43').format.columnWidth=3;daily.getRange('N5:O43').format={font:{name:'Arial',size:10,color:blue},columnWidth:16,rowHeight:23};span(daily,'N5:O5','기존 끼니 미지정 입력값');span(daily,'N6:O7','왼쪽 현금·카드 합계에 이미 포함됩니다.');daily.getRange('N6:O7').format.wrapText=true;header(daily,'N8:O8',['현금 원본','카드 원본']);daily.getRange('N9:O39').setNumberFormat(number);
header(daily,'A8:L8',['날짜','요일',...mealNames,'식권 매출','현금 매출','카드 매출','기타 매출','실제 매출','당일 외상']);
meal.getRange('A1:A133').format.columnWidth=15;meal.getRange('B1:B133').format.columnWidth=7;meal.getRange('C1:C133').format.columnWidth=8;meal.getRange('D1:F133').format.columnWidth=11;meal.getRange('G1:M133').format.columnWidth=14;
span(meal,'A5:M5','인원·금액 차이는 판매 식권 입력 끼니만 계산합니다. 끼니 현금·카드는 별도 매출입니다.');meal.getRange('A5:M5').format.font={color:muted};
header(meal,'A8:M8',['날짜','요일','끼니','예상 식수','판매 식권','인원 차이','식권 단가','예상 금액','식권 매출','금액 차이','현금 매출','카드 매출','실제 끼니 매출']);
counts.getRange('A1:A134').format.columnWidth=15;counts.getRange('B1:B134').format.columnWidth=7;counts.getRange('C1:C134').format.columnWidth=8;counts.getRange('D1:F134').format.columnWidth=10;counts.getRange('G1:K134').format.columnWidth=15;counts.getRange('L1:L134').format.columnWidth=11;
span(counts,'A5:L5','식수 × 식권 단가로 계산합니다. 당일 외상은 매출에 포함하며, 수금 시 같은 식수를 다시 입력하지 마세요.');counts.getRange('A5:L5').format.font={size:10,color:muted};
header(counts,'A8:L8',['날짜','요일','끼니','현금 식수','카드 식수','외상 식수','끼니 단가','현금 매출','카드 매출','외상 매출','결제·외상 매출','식수 합계']);
counts.getRange('M1:M134').format.columnWidth=3;counts.getRange('N5:O134').format={font:{name:'Arial',size:10,color:blue},columnWidth:16,rowHeight:23};span(counts,'N5:O5','이전 끼니별 금액 원본');header(counts,'N8:O8',['이전 현금(원)','이전 카드(원)']);counts.getRange('N9:O132').setNumberFormat(number);
for(let d=1;d<=31;d++){
 const r=8+d;value(daily,'A'+r,new Date(Date.UTC(2026,8,d)));value(daily,'B'+r,'');
 for(let i=0;i<4;i++){const c=String.fromCharCode(67+i);formula(daily,c+r,`=IF(COUNTIFS('끼니별 비교'!$A$9:$A$132,$A${r},'끼니별 비교'!$C$9:$C$132,${c}$8,'끼니별 비교'!$E$9:$E$132,"<>")=0,"",SUMIFS('끼니별 비교'!$E$9:$E$132,'끼니별 비교'!$A$9:$A$132,$A${r},'끼니별 비교'!$C$9:$C$132,${c}$8))`);}
 for(const [out,source,qty,legacy]of [['H','H','D','N'],['I','I','E','O']])formula(daily,out+r,`=IF(COUNTIFS('결제별 식수'!$A$9:$A$132,$A${r},'결제별 식수'!$${qty}$9:$${qty}$132,"<>")+COUNTIFS('결제별 식수'!$A$9:$A$132,$A${r},'결제별 식수'!$${legacy}$9:$${legacy}$132,"<>")+COUNT(${legacy}${r})=0,"",SUMIFS('결제별 식수'!$${source}$9:$${source}$132,'결제별 식수'!$A$9:$A$132,$A${r})+SUM(${legacy}${r}))`);
 formula(daily,'G'+r,`=IF(COUNT(C${r}:F${r})=0,"",SUMPRODUCT(C${r}:F${r},C$5:F$5))`);formula(daily,'K'+r,`=IF(COUNT(C${r}:J${r},L${r})=0,"",SUM(G${r}:J${r},L${r}))`);formula(daily,'L'+r,`=IF(COUNTIFS('결제별 식수'!$A$9:$A$132,A${r},'결제별 식수'!$F$9:$F$132,"<>")=0,"",SUMIFS('결제별 식수'!$J$9:$J$132,'결제별 식수'!$A$9:$A$132,A${r}))`);
 for(let i=0;i<4;i++){const mr=9+(d-1)*4+i;value(meal,'A'+mr,new Date(Date.UTC(2026,8,d)));value(meal,'B'+mr,'');value(meal,'C'+mr,mealNames[i]);
  formula(meal,'G'+mr,`=IF(COUNT(A${mr})=0,"",INDEX('일별 판매'!$C$5:$F$5,1,MATCH(C${mr},'일별 판매'!$C$8:$F$8,0)))`);formula(meal,'F'+mr,`=IF(COUNT(E${mr})=0,"",E${mr}-D${mr})`);formula(meal,'H'+mr,`=IF(COUNT(D${mr})=0,"",D${mr}*G${mr})`);formula(meal,'I'+mr,`=IF(COUNT(E${mr})=0,"",E${mr}*G${mr})`);formula(meal,'J'+mr,`=IF(COUNT(E${mr})=0,"",I${mr}-H${mr})`);formula(meal,'M'+mr,`=IF(COUNT(E${mr},K${mr}:L${mr})+${paymentCount('J',mr)}=0,"",SUM(I${mr},K${mr}:L${mr})+${paymentSum('J',mr)})`);
  for(const [out,source]of [['K','H'],['L','I']])formula(meal,out+mr,`=IF(${paymentCount(source,mr)}=0,"",${paymentSum(source,mr)})`);
  value(counts,'A'+mr,new Date(Date.UTC(2026,8,d)));value(counts,'B'+mr,'');value(counts,'C'+mr,mealNames[i]);formula(counts,'G'+mr,`=IF(COUNT(A${mr})=0,"",INDEX('일별 판매'!$C$5:$F$5,1,MATCH(C${mr},'일별 판매'!$C$8:$F$8,0)))`);
  for(const [out,qty,old]of [['H','D','N'],['I','E','O']])formula(counts,out+mr,`=IF(COUNT(${qty}${mr},${old}${mr})=0,"",SUM(${old}${mr})+SUM(${qty}${mr})*G${mr})`);
  formula(counts,'J'+mr,`=IF(COUNT(F${mr})=0,"",F${mr}*G${mr})`);formula(counts,'K'+mr,`=IF(COUNT(H${mr}:J${mr})=0,"",SUM(H${mr}:J${mr}))`);formula(counts,'L'+mr,`=IF(COUNT(D${mr}:F${mr})=0,"",SUM(D${mr}:F${mr}))`);
 }
}
for(const [s,last,end]of [[daily,'L',39],[meal,'M',132],[counts,'L',132]]){s.getRange('A9:A'+end).setNumberFormat('yyyy-mm-dd');s.getRange('C9:'+last+end).setNumberFormat(number);s.getRange('A9:B'+end).format.horizontalAlignment='center';for(let r=9;r<=end;r++)if(r%2===0)s.getRange('A'+r+':'+last+r).format.fill='#F3F6FA';}
daily.getRange('C5:F5').format.font.color=blue;daily.getRange('J9:J39').format.font.color=blue;meal.getRange('D9:E132').format.font.color=blue;counts.getRange('D9:F132').format.font.color=blue;
for(const col of ['F','J'])meal.getRange(col+'9:'+col+'132').setNumberFormat(signed);
summary.getRange('B21:L25').setNumberFormat(number);summary.getRange('D21:D25').setNumberFormat(signed);summary.getRange('I21:J25').setNumberFormat(signed);summary.getRange('K12:L12').setNumberFormat(number);
// Integer reports stay clean; actual fractional inputs retain their visible precision.
for(const [s,ranges,fmt]of [[daily,['C9:K39','C41:K41','N9:O39'],'#,##0.00######;[Red]-#,##0.00######;"—"'],[meal,['D9:E132','G9:I132','K9:M132'],'#,##0.00######;[Red]-#,##0.00######;"—"'],[meal,['F9:F132','J9:J132'],'[Blue]+#,##0.00######;[Red]-#,##0.00######;"—"'],[summary,['A6:F7','G6:L7','C11:F14','C16:F16','B21:C25','E21:H25'],'#,##0.00######;[Red]-#,##0.00######;"—"'],[summary,['D21:D25','I21:J25'],'[Blue]+#,##0.00######;[Red]-#,##0.00######;"—"']])for(const range of ranges){const first=range.split(':')[0];s.getRange(range).conditionalFormats.addCustom(`AND(ISNUMBER(${first}),MOD(ABS(${first}),1)<>0)`,{numberFormat:fmt});}
value(daily,'A41','월 합계');daily.mergeCells('A41:B41');for(const col of ['C','D','E','F','G','H','I','J','K','L'])formula(daily,col+'41',`=IF(COUNT(${col}9:${col}39)=0,"",SUM(${col}9:${col}39))`);daily.getRange('A41:L41').format={fill:navy,font:{bold:true,color:'#FFFFFF'},rowHeight:27};daily.getRange('C41:L41').setNumberFormat(number);
value(counts,'A134','월 합계');counts.mergeCells('A134:C134');for(const col of ['D','E','F','H','I','J','K','L'])formula(counts,col+'134',`=IF(COUNT(${col}9:${col}132)=0,"",SUM(${col}9:${col}132))`);counts.getRange('A134:L134').format={fill:navy,font:{bold:true,color:'#FFFFFF'},rowHeight:27};counts.getRange('D134:L134').setNumberFormat(number);
wb.recalculate();console.log((await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?',options:{useRegex:true,maxResults:20},maxChars:1500})).ndjson);
const output=await SpreadsheetFile.exportXlsx(wb),out=resolve(work,'sales-template.xlsx');await output.save(out);
// Transfer original authored XML/styles as small base64 entries for client filling.
const bytes=await fs.readFile(out),entries=[];let eocd=bytes.length-22;while(eocd>=0&&bytes.readUInt32LE(eocd)!==0x06054b50)eocd--;if(eocd<0)throw Error('Invalid ZIP');
let pos=bytes.readUInt32LE(eocd+16);for(let i=0;i<bytes.readUInt16LE(eocd+10);i++){if(bytes.readUInt32LE(pos)!==0x02014b50)throw Error('Invalid ZIP directory');const method=bytes.readUInt16LE(pos+10),size=bytes.readUInt32LE(pos+20),n=bytes.readUInt16LE(pos+28),x=bytes.readUInt16LE(pos+30),c=bytes.readUInt16LE(pos+32),offset=bytes.readUInt32LE(pos+42),name=bytes.toString('utf8',pos+46,pos+46+n),start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28),raw=bytes.subarray(start,start+size),data=method===8?inflateRawSync(raw):raw;entries.push({name,data:data.toString('base64')});pos+=46+n+x+c;}
await fs.mkdir('assets',{recursive:true});await fs.writeFile('assets/sales-report-template.json',JSON.stringify({v:2,author:'Artifact Tool',sheets:names,entries}));console.log('Template authored: '+entries.length+' ZIP entries');
