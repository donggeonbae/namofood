// Korean menu identity does not require locale-sensitive casing on every lookup.
import {
  canonicalDish,
  normalizedDishName,
} from "../supabase/functions/_shared/institutional-menu.ts";
import { INSTITUTIONAL_CATALOG } from "./institutional_catalog.ts";
const names = [
  ...INSTITUTIONAL_CATALOG.map((e) => e.recipe.menu),
  "돈육 고추장볶음",
  "돈까스",
  "돈가스",
  "ＣＨＩＣＫＥＮ (구이)",
  "ABC İ I Σ",
  "고등어·무 조림",
  "위샹로우스",
];
for (const name of names) {
  const before = name.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(
    /[\s·ㆍ,()（）]/g,
    "",
  );
  if (normalizedDishName(name) !== before) {
    throw new Error(`Dish normalization changed ${name}`);
  }
}
if (canonicalDish("돈까스") !== canonicalDish("돈가스")) {
  throw new Error("Cutlet aliases changed");
}
if (canonicalDish("제육볶음") !== canonicalDish("돈육 고추장볶음")) {
  throw new Error("Pork aliases changed");
}
if (canonicalDish("고추장삼겹") !== canonicalDish("고추장삼겹살구이")) {
  throw new Error("Actual chili pork-belly aliases must share identity");
}
if (canonicalDish("위샹로우쓰") !== canonicalDish("위샹로우스")) {
  throw new Error("Confirmed human-menu spelling variants must share identity");
}
if (canonicalDish("매콤닭갈비볶음") !== canonicalDish("닭갈비")) {
  throw new Error("Chili chicken alias must not evade the weekly limit");
}
for (
  const alias of ["수제등심돈까스", "돼지등심수제돈까스", "돼지안심돈까스"]
) {
  if (canonicalDish(alias) !== canonicalDish("돈까스")) {
    throw new Error(
      `Plain cutlet alias escaped weekly limit: ${alias}`,
    );
  }
}
console.log(`DISH_NORMALIZATION_OK ${names.length} unchanged menu identities`);
