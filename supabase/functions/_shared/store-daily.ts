// A pre-update administrator tab must not erase the new daily collection cells.
type State = { sales?: Record<string, Record<string, unknown>>; salesEdits?: Record<string, Record<string, { at?: string }>>; [key: string]: unknown };
export function preserveStoreDaily(full: State, incoming: State): State {
  const out = structuredClone(incoming);
  for (const [month, cells] of Object.entries(full.sales || {})) {
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) continue;
    for (const [key, value] of Object.entries(cells)) {
      if (!/^([1-9]|[12]\d|3[01])\|store(Tickets|Cash|Card)$/.test(key)) continue;
      const oldAt = Date.parse(full.salesEdits?.[month]?.[key]?.at || '') || 0;
      const newAt = Date.parse(incoming.salesEdits?.[month]?.[key]?.at || '') || 0;
      if (newAt > oldAt) continue;
      out.sales ||= {}; out.sales[month] ||= {}; out.sales[month][key] = structuredClone(value);
      const edit = full.salesEdits?.[month]?.[key];
      if (edit) { out.salesEdits ||= {}; out.salesEdits[month] ||= {}; out.salesEdits[month][key] = structuredClone(edit); }
    }
  }
  return out;
}
