// Strict row-ledger adapter: no model-generated dates, amounts, or seller names.
// Unknown layouts still go through the general AI cell-role mapper.
import {
  cellDate,
  cellNumber,
  type InvoiceSheet,
  type SheetCell,
  type SheetInvoice,
} from "./sheet.ts";
import { OcrError, sha256, validateDocument } from "./lib.ts";
const fail = (detail: string) =>
  new OcrError(
    "invalid_ledger",
    422,
    `거래처원장의 ${detail}을 확인해 주세요. 원본은 변경하지 않았으며 일부만 등록하지 않았습니다.`,
  );
const label = (c?: SheetCell) =>
  c && !c.e && c.v != null ? String(c.v).trim() : "";
const header = [
  "일자-No.",
  "품목명(규격)",
  "수량",
  "단가",
  "공급가액",
  "부가세",
  "합계",
  "거래처명",
  "적요",
];
const key = (s: string) => s.replace(/\s/g, "");
export async function materializeLedger(
  sheet: InvoiceSheet,
): Promise<SheetInvoice[] | null> {
  const rows = new Map<number, Map<string, SheetCell>>();
  for (const c of sheet.cells) {
    const [, col, r] = c.a.match(/^([A-Z]+)(\d+)$/)!;
    const row = rows.get(+r) || new Map<string, SheetCell>();
    row.set(col, c);
    rows.set(+r, row);
  }
  const ordered = [...rows].sort((a, b) => a[0] - b[0]);
  const head = ordered.find(([, row]) =>
    header.every((h, i) =>
      key(label(row.get(String.fromCharCode(65 + i)))) === h
    )
  );
  if (!head) return null;
  const titles = sheet.cells.filter((c) =>
    Number(c.a.match(/\d+/)![0]) < head[0]
  )
    .map((c) => ({
      c,
      match: label(c).match(
        /^회사명\s*:\s*(.+?)\s*\/\s*(\d{4}\/\d{1,2}\/\d{1,2})\s*~\s*(\d{4}\/\d{1,2}\/\d{1,2})\s*$/,
      ),
    }))
    .filter((x) => x.match);
  if (titles.length !== 1) return null;
  const title = titles[0], vendor = title.match![1].trim();
  const start = cellDate({ a: "A1", v: title.match![2] }),
    end = cellDate({ a: "A1", v: title.match![3] });
  if (!start || !end || start > end) throw fail("기간");
  type Group = {
    date: string;
    no: string;
    rows: Map<string, SheetCell>[];
    refs: string[];
  };
  const groups = new Map<string, Group>();
  const summaries: { date: string | null; row: Map<string, SheetCell> }[] = [];
  let current: Group | undefined, ended = false;
  for (const [r, row] of ordered.filter(([r]) => r > head[0])) {
    const a = label(row.get("A")), name = label(row.get("B"));
    if (
      header.every((h, i) =>
        key(label(row.get(String.fromCharCode(65 + i)))) === h
      )
    ) continue;
    const subtotal = a.match(/^(\d{4}\/\d{1,2}\/\d{1,2})\s+계$/);
    if (subtotal || a === "총합계") {
      if (name) throw fail(`${r}행 합계`);
      summaries.push({
        date: subtotal ? cellDate({ a: "A1", v: subtotal[1] }) : null,
        row,
      });
      current = undefined;
      if (a === "총합계") ended = true;
      continue;
    }
    if (!name) {
      // Totals and timestamps are not purchases. A nameless financial row is
      // ambiguous and must never be silently dropped.
      if (["C", "D", "E", "F", "G"].some((c) => label(row.get(c)))) {
        throw fail(`${r}행 품목명`);
      }
      continue;
    }
    if (ended) throw fail(`${r}행 합계 이후 품목`);
    if (a) {
      const m = a.match(/^(\d{4}\/\d{1,2}\/\d{1,2})\s*-\s*(\d+)$/);
      const date = m ? cellDate({ a: "A1", v: m[1] }) : null;
      if (!m || !date || date < start || date > end) {
        throw fail(`${r}행 거래일·번호`);
      }
      const id = `${date}#${m[2]}`;
      current = groups.get(id) ||
        { date, no: m[2], rows: [], refs: [title.c.a] };
      groups.set(id, current);
    }
    if (!current) throw fail(`${r}행 거래일`);
    current.rows.push(row);
    current.refs.push(...[...row.values()].map((c) => c.a));
  }
  if (!groups.size) return [];
  const count = [...groups.values()].reduce((n, g) => n + g.rows.length, 0);
  if (count > 1000 || groups.size > 200) {
    throw fail("품목 수(1,000개)·거래 수(200건)");
  }
  const sum = (rs: Map<string, SheetCell>[], col: string, blankTax = false) => {
    const values = rs.map((r) =>
      cellNumber(r.get(col)) ?? (blankTax && !label(r.get(col)) ? 0 : null)
    );
    return values.every((v) => v !== null)
      ? values.reduce<number>((s, v) => s + v!, 0)
      : null;
  };
  const all = [...groups.values()].flatMap((g) => g.rows);
  const grand = summaries.filter((s) => s.date === null);
  if (grand.length !== 1) throw fail("전체 합계 행");
  let matches = true;
  const auditWarnings: string[] = [];
  for (const s of summaries) {
    const scope = s.date
      ? [...groups.values()].filter((g) => g.date === s.date).flatMap((g) =>
        g.rows
      )
      : all;
    if (!scope.length) throw fail("소계 날짜");
    for (const col of ["E", "F", "G"]) {
      const printed = cellNumber(s.row.get(col));
      // Compare the recorded amounts without assigning zero to an unpriced
      // item. The item itself stays unknown and keeps its review warning.
      const known = scope.map((r) => cellNumber(r.get(col))).filter((v) =>
        v !== null
      );
      const actual = known.length ? known.reduce((a, b) => a + b, 0) : null;
      if (
        printed !== null &&
        (actual === null ? printed !== 0 : Math.abs(printed - actual) > 1)
      ) {
        matches = false;
        auditWarnings.push(
          `${
            s.date || "전체"
          } 원장 합계와 품목 합계가 다릅니다. 원본과 대조해 주세요.`,
        );
      }
    }
  }
  const results: SheetInvoice[] = [];
  for (const g of groups.values()) {
    const daily = summaries.filter((s) => s.date === g.date);
    const sole = [...groups.values()].filter((other) =>
            other.date === g.date
          ).length === 1 && daily.length === 1
      ? daily[0].row
      : undefined;
    // A printed daily subtotal belongs to an invoice only when exactly one
    // invoice exists that day. Never assign it to either of two deliveries.
    const invoiceSum = (col: string, blankTax = false) =>
      sole && cellNumber(sole.get(col)) !== null
        ? cellNumber(sole.get(col))
        : sum(g.rows, col, blankTax);
    const items = g.rows.map((row) => {
      const q = row.get("C"),
        raw = label(row.get("B")),
        m = raw.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
      return {
        name: m ? m[1].trim() : raw,
        spec: m ? m[2].trim() : "",
        unit: "",
        qty: cellNumber(q) ?? (label(q) || null),
        price: cellNumber(row.get("D")),
        supplyAmount: cellNumber(row.get("E")),
        tax: cellNumber(row.get("F")),
        amt: cellNumber(row.get("G")),
        confidence: 1,
        warnings: [],
      };
    });
    const refs = [
      ...new Set([
        ...g.refs,
        ...summaries.filter((s) => s.date === null || s.date === g.date)
          .flatMap((s) => [...s.row.values()].map((c) => c.a)),
      ]),
    ].sort();
    const document = validateDocument({
      date: g.date,
      vendor,
      invoiceNo: `${g.date}-${g.no}`,
      subtotal: invoiceSum("E"),
      tax: g.rows.every((r) => !label(r.get("F")))
        ? null
        : invoiceSum("F", true),
      total: invoiceSum("G"),
      previousBalance: null,
      balanceTotal: null,
      items,
      rawText: "",
      warnings: auditWarnings,
    });
    if (!document.vendor) throw fail("공급업체 상호");
    document.rawText = sheet.cells.filter((c) => refs.includes(c.a)).map((c) =>
      `${c.a}: ${label(c)}`
    ).join("\n").slice(0, 20000);
    results.push({
      document,
      sourceKey: await sha256(
        new TextEncoder().encode(JSON.stringify([
          sheet.name,
          g.rows.map((r) => r.get("B")!.a).sort(),
        ])),
      ),
      sourceRefs: refs,
      sourceAudit: {
        sourceType: "period-ledger",
        rowCount: g.rows.length,
        sheetItemCount: count,
        periodTotal: cellNumber(grand[0].row.get("G")),
        totalMatches: matches,
      },
    });
  }
  return results;
}
