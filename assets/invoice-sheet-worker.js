/* Local-only spreadsheet decoding. No formulas/macros/links are executed. */
'use strict';
importScripts('xlsx-0.20.3.full.min.js');
function preflightZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0) throw Error('엑셀 압축 구조를 읽지 못했습니다. 원본 파일을 확인해 주세요.');
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true), expanded = 0;
  if (count > 4000 || offset + size > end || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw Error('너무 크거나 분할된 엑셀 파일입니다. 시트를 나누어 올려 주세요.');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw Error('엑셀 압축 구조가 올바르지 않습니다.');
    expanded += view.getUint32(offset + 24, true);
    if (expanded > 64 * 1024 * 1024 || view.getUint16(offset + 8, true) & 1) throw Error('압축 해제 크기가 너무 크거나 암호가 걸린 파일입니다.');
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
}
function decodeText(bytes) {
  if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('euc-kr', { fatal: true }).decode(bytes); }
}
function missingFormulaCaches(book, index) {
  // SheetJS synthesizes numeric zero for an XLSX formula lacking <v>. Inspect
  // the already-decoded local XML to distinguish an absent cache from real 0.
  if (!book.files) return new Set();
  const read = key => book.files[key]?.content ? new TextDecoder().decode(book.files[key].content) : '';
  const attr = (tag, key) => tag.match(new RegExp('(?:^|\\s)' + key + '\\s*=\\s*["\x27]([^"\x27]*)["\x27]'))?.[1] || '';
  const id = book.Workbook?.Sheets?.[index]?.id;
  const rel = [...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].find(m => attr(m[0], 'Id') === id);
  const target = rel ? attr(rel[0], 'Target') : '';
  const parts = (target.startsWith('/') ? target.slice(1) : 'xl/' + target).split('/'), path = [];
  for (const part of parts) { if (part === '..') path.pop(); else if (part && part !== '.') path.push(part); }
  const xml = read(path.join('/')), missing = new Set();
  for (const m of xml.matchAll(/<(?:\w+:)?c\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?c\s*>/g)) {
    if (/<(?:\w+:)?f(?:\s|>|\/)/.test(m[2]) && !/<(?:\w+:)?v\b[^>]*>\s*[^<\s][\s\S]*?<\/(?:\w+:)?v\s*>/.test(m[2])) missing.add(attr(m[1], 'r'));
  }
  return missing;
}
function parseFile(name, buffer, preview = false) {
  const bytes = new Uint8Array(buffer), ext = name.split('.').pop().toLowerCase(), textFile = ['csv', 'tsv'].includes(ext);
  if (!bytes.length || bytes.length > 8 * 1024 * 1024 || !['xlsx', 'xls', 'csv', 'tsv'].includes(ext)) throw Error('XLSX·XLS·CSV·TSV 파일은 각각 8MB 이하로 올려 주세요.');
  if (!textFile) {
    if (ext === 'xlsx') { if (bytes[0] !== 80 || bytes[1] !== 75) throw Error('실제 XLSX 파일이 아닙니다. 엑셀에서 다시 저장해 주세요.'); preflightZip(bytes); }
    else if (![208, 60, 239, 255, 9].includes(bytes[0])) throw Error('XLS 형식을 확인해 주세요. XLSX로 저장하면 더 정확하게 읽습니다.');
  }
  const input = textFile ? decodeText(bytes).replace(/^\uFEFF/, '') : bytes;
  const book = XLSX.read(input, { type: textFile ? 'string' : 'array', raw: textFile, cellDates: false, cellNF: true, cellFormula: true, cellHTML: false, bookVBA: false, bookFiles: ext === 'xlsx', sheetStubs: true, sheetRows: 2001, ...(ext === 'tsv' ? { FS: '\t' } : {}) });
  if (!book.SheetNames.length || book.SheetNames.length > 16) throw Error('한 파일에서 최대 16개 시트까지 지원합니다. 파일을 나누어 주세요.');
  const sheets = [], warnings = [];
  for (let i = 0; i < book.SheetNames.length; i++) {
    const sheetName = book.SheetNames[i], ws = book.Sheets[sheetName];
    if (book.Workbook?.Sheets?.[i]?.Hidden) { warnings.push(sheetName + ': 숨겨진 시트는 읽지 않았습니다.'); continue; }
    if (!ws?.['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!fullref'] || ws['!ref']);
    if (range.e.r >= 2000 || range.e.c >= 80) throw Error(sheetName + ': 시트당 2,000행·80열을 넘습니다. 사용하지 않는 끝 행·열을 지우거나 파일을 나누어 주세요.');
    const missing = missingFormulaCaches(book, i), cells = []; let chars = 0;
    for (const a of Object.keys(ws)) {
      if (a.startsWith('!')) continue;
      const c = ws[a];
      if (!c || (c.v == null || c.v === '') && !c.f) continue;
      const out = { a, v: c.t === 'e' || missing.has(a) ? null : c.v ?? null };
      if (!['string', 'number', 'boolean'].includes(typeof out.v)) out.v = null;
      if (typeof out.v === 'number' && (!Number.isFinite(out.v) || Math.abs(out.v) > 1e15)) throw Error(sheetName + ': 숫자 범위를 확인해 주세요.');
      if (c.w !== undefined && !missing.has(a)) out.w = String(c.w);
      if (c.f || missing.has(a)) out.f = true;
      if (c.t === 'e') out.e = true;
      if (out.v != null && c.t === 'n' && c.z && XLSX.SSF.is_date(c.z)) {
        const d = XLSX.SSF.parse_date_code(c.v, { date1904: !!book.Workbook?.WBProps?.date1904 });
        // Excel's fictitious 1900-02-29 is not a valid transaction date.
        if (d && d.y >= 1900 && !(d.y === 1900 && d.m === 2 && d.d === 29)) out.d = `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
      }
      chars += String(out.v ?? '').length + (out.w?.length || 0);
      if (String(out.v ?? '').length > 2000 || (out.w?.length || 0) > 2000 || chars > 180000 || cells.length >= 6000) throw Error(sheetName + ': 내용이 너무 큽니다. 시트를 나누어 주세요. 일부만 가져오지는 않습니다.');
      cells.push(out);
    }
    if (cells.length) sheets.push({ name: sheetName, fileName: name.slice(0, 200), cells, ...(preview ? {range,merges:(ws['!merges']||[]).filter(m=>m.s.r>=0&&m.s.c>=0&&m.e.r<2000&&m.e.c<80&&m.e.r>=m.s.r&&m.e.c>=m.s.c).slice(0,1000)} : {}) });
  }
  if (!sheets.length) throw Error('읽을 수 있는 데이터가 없습니다. 그림만 있는 엑셀은 사진으로 올려 주세요.');
  return { sheets, warnings };
}
self.onmessage = event => {
  try { self.postMessage({ ok: true, ...parseFile(event.data.name, event.data.buffer, event.data.preview === true) }); }
  catch (error) { self.postMessage({ ok: false, message: error.message || '엑셀을 읽지 못했습니다. 암호를 해제하고 다시 저장해 주세요.' }); }
};
