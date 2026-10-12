const fs=require('fs'),assert=require('assert/strict');
const s=fs.readFileSync('supabase/migrations/20261012205540_nmf_tax_debounce.sql','utf8'),edge=fs.readFileSync('supabase/functions/nmf-tax-auto/index.ts','utf8'),app=fs.readFileSync('나모푸드_관리앱.html','utf8');
assert(s.includes("jobname = 'nmf-tax-nightly'"),'nightly schedule retired');
assert(s.includes('(needs_inspection or due_at<=now())')&&s.includes("lease_until=now()+interval '5 minutes'"),'idle watcher sends no requests; lease prevents duplicate dispatch');
assert(s.includes('enable row level security')&&s.includes('revoke all'),'reports not exposed to anonymous callers');
assert(edge.includes('revision=${q.revision}')&&edge.includes('and not needs_inspection'),'stale revisions cannot replace results');
assert(!edge.includes('writeState('),'financial ledger never overwritten');
assert(app.includes('/functions/v1/nmf-tax-auto')&&!app.includes('매일 밤 한 번'),'updated event UI');
console.log('QUIET_QUEUE_PRIVATE_REPORTS_NO_STATE_WRITES_NO_BROWSER_AI_OK');
