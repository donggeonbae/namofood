// Synthetic in-memory file-format fixtures, no customer data or workbook writes.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),JSZip=require('jszip');
const root=path.join(__dirname,'..');
const context={TextDecoder,Uint8Array,DataView,self:{postMessage(){}},importScripts(name){vm.runInContext(fs.readFileSync(path.join(root,'assets',name),'utf8'),context);}};
vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'assets/invoice-sheet-worker.js'),'utf8'),context);
const parse=(name,bytes)=>JSON.parse(JSON.stringify(context.parseFile(name,Uint8Array.from(bytes).buffer)));
const cell=(sheet,a)=>sheet.cells.find(c=>c.a===a);
async function fixture(date1904=false){
 const zip=new JSZip(),ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
 zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
 zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
 zip.file('xl/workbook.xml',`<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="${date1904?1:0}"/><sheets><sheet name="납품" sheetId="1" r:id="rId1"/><sheet name="보관" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`);
 zip.file('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
 zip.file('xl/styles.xml',`<styleSheet xmlns="${ns}"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`);
 zip.file('xl/worksheets/sheet1.xml',`<worksheet xmlns="${ns}"><dimension ref="A1:F6"/><sheetData><row r="1"><c r="A1" s="1"><v>${date1904?44845:46307}</v></c><c r="B1" t="inlineStr"><is><t>00123</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>품목</t></is></c><c r="B2"><v>0</v></c></row><row r="3"><c r="C3"><f>1+2</f><v>3</v></c><c r="D3"><f>4+5</f></c><c r="E3" t="e"><f>1/0</f><v>#DIV/0!</v></c></row></sheetData></worksheet>`);
 zip.file('xl/worksheets/sheet2.xml',`<worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>숨김</t></is></c></row></sheetData></worksheet>`);
 return zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
}
(async()=>{
 const csv=parse('새업체.csv',Buffer.from('\uFEFF거래일,공급업체,품목,수량,금액\n26-10-12,검증유통,양파,0,"30,000"\n26-10-12,검증유통,세제,생수×3,\n'));
 assert.equal(cell(csv.sheets[0],'A2').v,'26-10-12');assert.equal(cell(csv.sheets[0],'D2').v,'0');assert.equal(cell(csv.sheets[0],'E2').v,'30,000');assert.equal(cell(csv.sheets[0],'E3'),undefined);assert.equal(cell(csv.sheets[0],'D3').v,'생수×3');
 const cp949=parse('한글.csv',Buffer.from([0xbe,0xe7,0xc6,0xc4,0x2c,0x31,0x0a]));assert.equal(cell(cp949.sheets[0],'A1').v,'양파');
 const utf16=parse('test.tsv',Buffer.concat([Buffer.from([255,254]),Buffer.from('품목\t수량\n양파\t001\n','utf16le')]));assert.equal(cell(utf16.sheets[0],'B2').v,'001');
 for(const mode of [false,true]){const parsed=parse('공급자.xlsx',await fixture(mode));assert.equal(parsed.sheets.length,1);assert(parsed.warnings[0].includes('보관'));const s=parsed.sheets[0];assert.equal(cell(s,'A1').d,'2026-10-12');assert.equal(cell(s,'B1').v,'00123');assert.equal(cell(s,'B2').v,0);assert.equal(cell(s,'C3').v,3);assert.equal(cell(s,'D3').v,null);assert.equal(cell(s,'D3').f,true);assert.equal(cell(s,'E3').v,null);assert.equal(cell(s,'E3').e,true);}
 const legacy=Buffer.from('<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="구형"><Table><Row><Cell><Data ss:Type="String">양파</Data></Cell><Cell><Data ss:Type="Number">2000</Data></Cell></Row></Table></Worksheet></Workbook>');assert.equal(cell(parse('구형.xls',legacy).sheets[0],'B1').v,2000);
 assert.throws(()=>parse('bad.xlsx',Buffer.from('not an excel file')),/XLSX/);
 assert.throws(()=>parse('huge.csv',Buffer.from(Array.from({length:2002},()=> '행,1').join('\n'))),/2,000행/);
 const bomb=Uint8Array.from(await fixture());const view=new DataView(bomb.buffer);for(let i=0;i<bomb.length-46;i++)if(view.getUint32(i,true)===0x02014b50){view.setUint32(i+24,65*1024*1024,true);break;}assert.throws(()=>parse('bomb.xlsx',bomb),/압축 해제 크기/);
 console.log('INVOICE_SHEET_PARSER_XLSX_XLS_CSV_CP949_UTF16_DATES_ZERO_FORMULA_LIMITS_OK');
})().catch(e=>{console.error(e);process.exitCode=1;});
