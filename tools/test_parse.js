// 발주표 OCR 파서(parseOcr / guessVendor) 자체 점검
//   cd tools && node test_parse.js   (복호화된 ../나모푸드_관리앱.html 이 있어야 함)
// eval: 우리 앱 파일의 파서 함수를 그대로 꺼내 쓰기 위한 것 (외부 입력 아님)
const fs = require("fs");
const src = fs.readFileSync("../나모푸드_관리앱.html", "utf8");
const start = src.indexOf("const UNITS="), end = src.indexOf("function requirements(){", start);
eval(src.slice(start, end));
const t = `거래명세서
상호: (주)나모유통   전화 02-123-4567
품명        수량   단가     금액
1 양파      10 kg  1,500   15,000
2 대파 5단 2,000 10,000
3 돼지고기 앞다리 20kg 8,500 170,000
계란 30개 300 9,000
두부 20 모 900 18,000
합계                   222,000`;
const it = parseOcr(t); const by = Object.fromEntries(it.map(x => [x.name, x]));
console.assert(it.length === 5, "5 items, got " + it.length);
console.assert(by["양파"].qty === 10 && by["양파"].unit === "kg" && by["양파"].price === 1500 && by["양파"].amt === 15000, "양파");
console.assert(by["대파"].qty === 5 && by["대파"].unit === "단" && by["대파"].amt === 10000, "대파");
console.assert(by["돼지고기 앞다리"].qty === 20 && by["돼지고기 앞다리"].amt === 170000, "돼지고기");
console.assert(by["두부"].qty === 20 && by["두부"].unit === "모", "두부");
console.assert(guessVendor(t) === "(주)나모유통", "vendor: " + guessVendor(t));
console.log("PARSE_OK");
