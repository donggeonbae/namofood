import { GO_BASE, GO_MODEL } from "../supabase/functions/_shared/opencode-go.ts";
import { reviewPayments } from "../supabase/functions/nmf-payment-match/lib.ts";
import { organize } from "../supabase/functions/nmf-coupang/ai.ts";
import { buildTaxReport, reviewTax } from "../supabase/functions/nmf-tax-nightly/lib.ts";
import { openCodeProtocol } from "../supabase/functions/nmf-recipe-fill/lib.ts";
import { parseOpenCodeResponse } from "../supabase/functions/nmf-menu-plan/lib.ts";
import { parseRecommendationOpenCodeResponse } from "../supabase/functions/nmf-menu-recommend/lib.ts";
let calls=0;
const assert=(v:unknown,m:string)=>{if(!v)throw Error(m);};
const envelope=(value:unknown)=>({type:"message",role:"assistant",model:GO_MODEL,stop_reason:"end_turn",content:[{type:"thinking",thinking:"not business data"},{type:"text",text:JSON.stringify(value)}]});
function provider(value:unknown):typeof fetch {
 return (async(url,init)=>{
  calls++; const b=JSON.parse(String(init?.body)),h=new Headers(init?.headers);
  assert(String(url)===GO_BASE+"/messages" && b.model===GO_MODEL,"every consumer selects Haiku on Go Anthropic, never Zen");
  assert(h.get("anthropic-version")==="2023-06-01" && h.get("user-agent")?.startsWith("namofood-") && h.get("x-opencode-session"),"native version, honest client and session headers");
  assert(Array.isArray(b.messages) && b.system.includes("JSON") && !b.reasoning && !b.text && !("store" in b),"no unsupported Responses options");
  return new Response(JSON.stringify(envelope(value)));
 }) as typeof fetch;
}
assert((await reviewPayments([],"offline-test",provider({matches:[]}))).length===0,"payment validation accepts native final text only");
assert((await organize({pages:[{text:"완료 주문 없음",links:[]}]},{from:"2026-10-01",to:"2026-10-20"},"offline-test",provider({orders:[]}))).orders.length===0,"Coupang keeps grounding validation after native response normalization");
const ai=await reviewTax(buildTaxReport({},"2026-10-20"),{apiKey:"offline-test",baseUrl:GO_BASE,model:GO_MODEL,fetcher:provider({summary:"검증",checks:[],costChecks:[]})});
assert(ai.model===GO_MODEL && ai.summary==="검증","tax uses the same selected model without changing calculated money");
assert(openCodeProtocol(GO_MODEL)==="messages","recipe protocol resolves Claude Messages");
assert(parseOpenCodeResponse("messages",envelope({recipes:[]}))==='{"recipes":[]}',"menu protocol parser ignores thinking and preserves final JSON");
assert(parseRecommendationOpenCodeResponse("messages",envelope({days:[]}))==='{"days":[]}',"recommendation parser ignores thinking and preserves final JSON");
assert(calls===3,"one bounded provider call per tested review consumer");
console.log("GO_HAIKU_NATIVE_TAX_PAYMENT_COUPANG_RECIPE_RECOMMEND_HEADERS_PROTOCOL_THINKING_NO_LEDGER_WRITES_OK");
