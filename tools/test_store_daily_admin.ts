import { preserveStoreDaily } from '../supabase/functions/_shared/store-daily.ts';
const equal = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error('Unexpected value: '+JSON.stringify(a)); };
Deno.test('stale administrator preserves new daily cells and independent new edits', () => {
  const full={sales:{'2026-10':{'20|storeTickets':4,'20|storeCash':1234,'20|storeCard':12501}},salesEdits:{'2026-10':Object.fromEntries(['storeTickets','storeCash','storeCard'].map(k=>['20|'+k,{at:'2026-10-20T10:00:00Z'}]))}};
  const old={sales:{'2026-10':{'20|other':1}},settings:{fixed:[['private',777]]}};
  const saved=preserveStoreDaily(full,old);equal(saved.sales?.['2026-10']['20|storeTickets'],4);equal(saved.sales?.['2026-10']['20|storeCash'],1234);equal(saved.sales?.['2026-10']['20|storeCard'],12501);equal(saved.settings,old.settings);equal(saved.sales?.['2026-10']['20|other'],1);
  const edited=structuredClone(saved);edited.sales!['2026-10']['20|storeCash']=0;edited.salesEdits!['2026-10']['20|storeCash']={at:'2026-10-20T10:00:01Z'};const next=preserveStoreDaily(full,edited);equal(next.sales?.['2026-10']['20|storeCash'],0);equal(next.sales?.['2026-10']['20|storeTickets'],4);equal(full.sales['2026-10']['20|storeCash'],1234);
});
