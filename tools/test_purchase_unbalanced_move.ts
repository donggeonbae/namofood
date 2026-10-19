import {applyPurchaseRouting,purchaseRoutingPlan} from "../supabase/functions/_shared/purchase-routing.ts";
const assert=(v:unknown,label:string)=>{if(!v)throw Error(label);};
const make=(unknown=false)=>({namofood:{orders:{"2026-10":[{id:"mixed",date:"2026-10-20",vendor:"검증유통",total:9999,tax:null,invoiceFile:{hash:"a".repeat(64)},items:[{id:"food",name:"양파",amt:1000,tax:null},{id:"fixed",name:"세제",qty:"한통",amt:unknown?null:2000,tax:null}]}]},orderEdits:{},fixedPurchases:{}},namostore:{orders:{},orderEdits:{}}}) as any;
for(const unknown of [false,true]){
 const states=make(unknown),before=structuredClone(states.namofood.orders["2026-10"][0]);
 const plan=await purchaseRoutingPlan(states.namofood,"namofood","mixed",{food:"food",fixed:"fixed"});
 assert(plan.canApply,"mismatch/missing amount permits moving selected item");assert(plan.requiresReview,"uncertain financial split requires explicit confirmation");
 assert(plan.amountReview?.unresolved,"unresolved amount is reported, never silently balanced");
 let rejected=false;try{await applyPurchaseRouting(states,"namofood","mixed",plan.fingerprint,{food:"food",fixed:"fixed"},false,new Date().toISOString());}catch{rejected=true;}assert(rejected&&!states.namofood.purchaseRoutes,"automatic uncertain split waits for confirmation");
 const moved=await applyPurchaseRouting(states,"namofood","mixed",plan.fingerprint,{food:"food",fixed:"fixed"},true,new Date().toISOString());
 const fixed=states.namofood.fixedPurchases["2026-10"][0],food=states.namofood.orders["2026-10"].find((o:any)=>!o.ocrMeta?.referenceOnly);
 assert(fixed.items.length===1&&fixed.items[0].id==="fixed"&&food.items.length===1,"only selected row enters fixed purchases");
 assert(fixed.total===(unknown?null:2000)&&food.total===1000,"group totals use observed rows, not arbitrary header difference allocation");
 assert(fixed.items[0].amt===(unknown?null:2000)&&fixed.tax===null,"missing amount and VAT stay blank, not zero");
 assert(fixed.ocrMeta.purchaseRoute.amountReview.sourceTotal===9999&&fixed.ocrMeta.purchaseRoute.amountReview.unresolved,"original total and reconciliation warning remain linked");
 assert(fixed.warnings.some((w:string)=>w.includes("금액 확인 필요")),"warning is visible on destination receipt");
 assert(JSON.stringify(states.namofood.orders["2026-10"][0].items)===JSON.stringify(before.items)&&states.namofood.orders["2026-10"][0].total===9999,"original invoice header and rows preserved");
 assert(moved.routes.find((r:any)=>r.target==="fixed")!.total===(unknown?null:2000),"API does not turn unknown moved cost into zero");
}
const whole=make(true);whole.namofood.orders["2026-10"][0].total=null;const plan=await purchaseRoutingPlan(whole.namofood,"namofood","mixed",{food:"fixed",fixed:"fixed"});assert(plan.canApply,"whole unknown-value receipt can move too");await applyPurchaseRouting(whole,"namofood","mixed",plan.fingerprint,{food:"fixed",fixed:"fixed"},true,new Date().toISOString());assert(whole.namofood.fixedPurchases["2026-10"][0].total===null,"unknown total stays unknown after whole move");
console.log("UNBALANCED_MISSING_AMOUNTS_MANUAL_MOVE_PRESERVES_NULLS_HEADER_WARNINGS_ORIGINAL_NO_GUESSED_ALLOCATION_OK");
