// Pure regression checks: no network, real orders, storage, or price writes.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('나모푸드_관리앱.html','utf8'),context={invoiceNumber:v=>v==null||v===''||!Number.isFinite(Number(v))?null:Number(v)};vm.createContext(context);
const start=source.includes('function storePurchaseUnits(')?source.indexOf('function storePurchaseUnits('):source.indexOf('function storePackCost(');
vm.runInContext(source.slice(start,source.indexOf('function storeCostCalculator(')),context);
const cases=[
 [{name:'빼빼로',spec:'50g, 30개',qty:30,unit:'개',amt:30000},30,1000],
 [{name:'빼빼로 50g, 30개',spec:'',qty:1,amt:30000},30,1000],
 [{name:'빼빼로',spec:'50g, 30개',qty:2,amt:30000},30,1000],
 [{name:'빼빼로',spec:'50g',qty:'30개',amt:30000},30,1000],
 [{name:'빼빼로',spec:'50g, 30개',qty:null,amt:30000},30,1000],
 [{name:'빼빼로',spec:'50g, 30개',qty:0,amt:0},0,null],
 [{name:'빼빼로',spec:'50g, 30개',qty:-30,amt:-30000},null,null],
 [{name:'콜라',spec:'355ml 24개입',qty:3,unit:'박스',amt:72000},72,1000],
 [{name:'콜라 24캔 묶음',qty:2,amt:48000},48,1000],
 [{name:'콜라',spec:'355ml 24캔',qty:'2박스',amt:48000},48,1000],
 [{name:'물',spec:'2L',qty:6,amt:12000},6,2000],
 [{name:'세트',spec:'24개입 2팩',qty:3,amt:72000},null,null],
 [{name:'콜라',spec:'355ml 24개입',qty:2,storeUnitsPerPack:12,amt:24000},24,1000],
];
for(const [item,units,cost] of cases){const before=JSON.stringify(item),result=context.storePackCost(item);assert.equal(result.units,units,JSON.stringify(item));assert.equal(result.cost,cost,JSON.stringify(item));assert.equal(JSON.stringify(item),before,'parsing never rewrites stored quantities or prices');}
console.log('STORE_PLAIN_30_ITEMS_IS_TOTAL_NEVER_30_TIMES_30_EXPLICIT_PACKS_MANUAL_OVERRIDES_VOLUME_IGNORED_IMMUTABLE_OK');
