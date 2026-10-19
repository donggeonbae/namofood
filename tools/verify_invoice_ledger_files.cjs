// Read-only local verification of user-supplied workbooks. No uploads or writes.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),context={TextDecoder,Uint8Array,DataView,self:{postMessage(){}},importScripts(name){vm.runInContext(fs.readFileSync(path.join(root,'assets',name),'utf8'),context);}};
vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'assets/invoice-sheet-worker.js'),'utf8'),context);
for(const file of process.argv.slice(2)){
 const parsed=context.parseFile(path.basename(file),Uint8Array.from(fs.readFileSync(file)).buffer);
 const moduleUrl=require('node:url').pathToFileURL(path.join(root,'supabase/functions/nmf-invoice-ocr/ledger.ts')).href;
 const code=`import {materializeLedger} from ${JSON.stringify(moduleUrl)}; const input=JSON.parse(await new Response(Deno.stdin.readable).text()); for(const sheet of input.sheets){const docs=await materializeLedger(sheet);if(!docs)throw Error('layout not recognized');console.log(JSON.stringify({sheet:sheet.name,documents:docs.length,items:docs.reduce((n,d)=>n+d.document.items.length,0),vendors:[...new Set(docs.map(d=>d.document.vendor))],total:docs.reduce((n,d)=>n+(d.document.total||0),0),originalTotal:docs[0]?.sourceAudit.periodTotal,totalMatches:docs.every(d=>d.sourceAudit.totalMatches),groups:docs.map(d=>({date:d.document.date,no:d.document.invoiceNo,items:d.document.items.length,total:d.document.total})),databaseWrites:0}));}`;
 const result=spawnSync(process.env.DENO_BIN||'/Users/donggeonbae/.deno/bin/deno',['eval',code],{input:JSON.stringify(parsed),encoding:'utf8',maxBuffer:200000});
 assert.equal(result.status,0,result.stderr);
 for(const line of result.stdout.trim().split('\n')){const value=JSON.parse(line);console.log(JSON.stringify({file:path.basename(file),...value}));assert.equal(value.total,value.originalTotal);assert.equal(value.totalMatches,true);}
}
