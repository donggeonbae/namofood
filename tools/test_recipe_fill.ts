// Edge Function 순수 로직 점검 (LLM 호출 없음). 실행: deno run -A tools/test_recipe_fill.ts
// 비밀번호: NMF_PW 또는 ~/.namofood_pw  — 실제 Supabase 상태를 읽어 복호화 → 빠진 음식 목록 → 병합/암호화 왕복 확인
import { buildPrompt, decryptText, encryptText, mergeRecipes, missingList, parseRecipesJson, recipeNames } from "../supabase/functions/nmf-recipe-fill/lib.ts";

const URL_ = "https://rycibsczsgbkgtwfxyim.supabase.co", KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ5Y2lic2N6c2dia2d0d2Z4eWltIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0MjkzMTAsImV4cCI6MjEwNDAwNTMxMH0.gfo03oiZT6FPMGQaa9pF5it2BY6oL1CoxWpd7-fk0OY";
let pw = Deno.env.get("NMF_PW") || "";
if (!pw) { try { pw = (await Deno.readTextFile(`${Deno.env.get("USERPROFILE") || Deno.env.get("HOME")}/.namofood_pw`)).trim(); } catch { /* 없음 */ } }
if (!pw) { console.error("비밀번호 없음"); Deno.exit(1); }

const r = await fetch(`${URL_}/rest/v1/namofood_state?id=eq.namofood&select=data,updated_at`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
const [row] = await r.json();
const S = JSON.parse(await decryptText(pw, row.data));
const miss = missingList(S);
console.log(`레시피 ${recipeNames(S).size}개 · 빠진 음식 ${miss.length}개 · 유사이름 제외 대상 ${miss.filter((m) => !m.similar.length).length}개`);
console.log(miss.slice(0, 8).map((m) => `${m.menu}(${m.comp})${m.similar.length ? " ~" + m.similar.join("/") : ""}`).join(", "));
console.log("--- 프롬프트 미리보기 ---\n" + buildPrompt(miss.slice(0, 2)).slice(0, 400) + "\n---");

// 병합 + 암호화 왕복 (저장은 하지 않음)
const fake = parseRecipesJson('```json\n{"recipes":[{"menu":"__테스트음식__","comp":"주찬","items":[{"item":"두부","qty":80,"unit":"g"},{"item":"물","qty":100,"unit":"ml"}],"method":"1. 굽기"}]}\n```');
const before = S.recipes.length; const { added } = mergeRecipes(S, fake, "2026-09-22");
if (added[0] !== "__테스트음식__" || S.recipes.length !== before + 1) throw new Error("mergeRecipes 실패 (물 제외·1건 추가 기대)");
const round = JSON.parse(await decryptText(pw, await encryptText(pw, JSON.stringify(S))));
if (round.recipeMeta["__테스트음식__"].by !== "ai") throw new Error("암호화 왕복 실패");
console.log("RECIPE_FILL_OK");
