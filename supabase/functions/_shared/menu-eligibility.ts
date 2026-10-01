// Applies to served menu labels only, never cooking ingredients (맛술·조리용 와인 등).
const KOREAN_ALCOHOL =
  "생맥주|맥주|소주|막걸리|와인|하이볼|위스키|위스케|브랜디|보드카|데킬라|테킬라|사케|청주|약주|탁주|양주|샴페인|칵테일|리큐르|럼주|주류|모히토|모히또|마티니|진토닉|피나콜라다|버번|고량주|복분자주|소맥";
const ALCOHOL_NAME = new RegExp(
  `(?:^|[\\s(+&/·,[])(?:${KOREAN_ALCOHOL})|(?:${KOREAN_ALCOHOL})(?=$|[\\s)\\]0-9])|\\b(?:beer|lager|ale|ipa|stout|porter|wine|soju|makgeolli|highball|whisk[ey]+|vodka|brandy|rum|gin|tequila|sake|champagne|cocktail|liquor|liqueur|mojito|martini|bourbon)\\b`,
  "i",
);
const ALCOHOL_BRAND =
  /(?:^|[\s([])(?:카스|테라|켈리|하이트|하이네켄|버드와이저|아사히|삿포로|기린|칭다오|호가든|클라우드|기네스|코로나|참이슬|처음처럼|진로|새로|참소주|좋은데이|한라산|cass|terra|kelly|hite|heineken|budweiser|asahi|sapporo|kirin|tsingtao|hoegaarden|kloud|guinness|corona|stella(?:\s+artois)?|carlsberg)(?=$|[\s)\]0-9+&/·,]|제로|라이트|프레시|캔|병|잔|와|과|및)/i;
const COOKED_DISH_END =
  /(?:튀김|조림|볶음|스테이크|찜|구이|갈비|불고기|치킨|수육|보쌈|파스타|리조또|스튜|소스|반죽|stew|steak|sauce|batter|braised\s+\w+|fried\s+\w+)\s*(?:\([^)]*\))?$/i;
const COOKING_CONTEXT =
  /(반죽|소스|양념|조림|찜|수육|보쌈|불고기|리조또|스튜|stew|sauce|batter|braised|cooked\s+(?:with|in)|marinated)/i;

/** Beer-style non/low-alcohol labels are also excluded; genuine cooked dishes are allowed. */
export function prohibitedMenuReason(name: string): string {
  const label = String(name || "").normalize("NFKC").trim();
  if (/^(?:진저에일|ginger\s+ale)(?:\s*\([^)]*\))?$/i.test(label)) return "";
  const brandLabel = label.replace(
    /(?:무|논|비)(?:알코올|알콜)\s*|\b(?:non[-\s]?alcoholic|alcohol[-\s]?free)\b/gi,
    "",
  ).trim();
  // 청주식 is a regional food style; 소주 inside 채소주먹밥 is not a drink token.
  const drinkLabel = brandLabel.replace(/^청주\s*식(?=[가-힣])/, "")
    .replace(/칵테일\s*새우|사케\s*동|복분자\s*주스/g, "");
  const compact = drinkLabel.replace(/\s/g, "");
  const alcohol = ALCOHOL_NAME.test(drinkLabel) || ALCOHOL_NAME.test(compact) ||
    ALCOHOL_BRAND.test(drinkLabel) || ALCOHOL_BRAND.test(compact) ||
    /^(?:술|럼|알코올|알콜)(?:\s*(?:\d+(?:\.\d+)?|한|두|세)\s*(?:잔|병|캔|ml|L))?(?:\s*\([^)]*\))?$/i
      .test(label);
  if (!alcohol) return "";
  // A mixed '맥주+치킨' offer is not a cooked-food exception.
  if (
    !/[+&/·,]/.test(label) && COOKING_CONTEXT.test(label) &&
    COOKED_DISH_END.test(label)
  ) return "";
  return "주류·맥주형 음료는 공장 급식 메뉴로 사용할 수 없습니다";
}

export function assertMealMenuAllowed(name: string): void {
  const reason = prohibitedMenuReason(name);
  if (reason) throw new Error(`${reason}: ${name}`);
}
