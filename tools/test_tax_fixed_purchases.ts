import { buildTaxReport, type TaxState } from "../supabase/functions/nmf-tax-nightly/lib.ts";
import { financeHash } from "../supabase/functions/nmf-tax-auto/debounce.ts";
const assert=(v:unknown,label:string)=>{if(!v)throw Error(label);};
const state:TaxState={settings:{tickets:{중식:10000}},staff:[],sales:{"2026-10":{"12|중식":10}},orders:{"2026-10":[{id:"food",date:"2026-10-12",total:11000,tax:1000},{id:"source",date:"2026-10-12",total:14300,ocrMeta:{referenceOnly:true}}]},fixedMonthly:{"2026-10":[]},fixedPurchases:{"2026-10":[{id:"supplies",date:"2026-10-12",total:3300,tax:300},{id:"future",date:"2026-10-30",total:9900,tax:900}]}};
const before=JSON.stringify(state),m=buildTaxReport(state,"2026-10-12").months["2026-10"];
assert(m.purchases===11000,"fixed supplies are not ingredient purchases");assert(m.fixed===3000,"one-off purchase net expense recognized fully, no day proration");assert(m.inputVatObserved===1300,"recorded supply VAT observed once, future VAT excluded");assert(m.actualNet===100000-Math.round(100000/11)-10000-3000,"no double VAT subtraction or duplicate source cost");assert(before===JSON.stringify(state),"tax computation is read-only");
const empty={...state,fixedPurchases:{}};assert(await financeHash(empty)!==await financeHash(state),"fixed-cost purchases trigger existing debounced review");
console.log("TAX_FIXED_PURCHASES_DATED_ONCE_VAT_ONCE_NET_EXPENSE_NO_PRORATION_FUTURE_EXCLUDED_DEBOUNCE_OK");
