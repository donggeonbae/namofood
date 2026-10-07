# 나모푸드 관리 (암호화 배포)

공장 구내식당 **나모푸드**(와 **나모카페**)의 관리 웹앱입니다. 왼쪽 위 스위치로
푸드/카페를 전환하며, 데이터는 따로 저장됩니다(Supabase 행 `namofood` /
`namocafe`). 이 저장소는 GitHub Pages로 공개되지만, `index.html` 안의 앱 본문은
**AES-256-GCM으로 암호화**되어 있어 비밀번호를 아는 사람만 브라우저 안에서 열 수
있습니다. 비밀번호는 서버로 전송되지 않습니다.

## 구성

| 파일             | 설명                                                          |
| ---------------- | ------------------------------------------------------------- |
| `index.html`     | 잠금 페이지 + 암호화된 앱 (비밀번호 입력 → 브라우저에서 해제) |
| `encrypt_app.py` | 앱을 새 비밀번호로 다시 암호화하는 도구                       |

## 데이터 함께 쓰기 (Supabase)

앱의 데이터(식단·근무표·판매 실적·위생 기록 등)는 **Supabase 표**에 현재 상태
1줄 + 날짜별 기록(`namofood@YYYY-MM-DD`, 최대 1년)으로 홈페이지 비밀번호로
**암호화되어** 저장됩니다. 누가 고치든 3초 뒤 저장되고, 다른 기기는 8초마다(또는
화면을 다시 볼 때) 최신을 가져옵니다.

Supabase 프로젝트의 SQL Editor에서 한 번 실행:

```sql
create table if not exists public.namofood_state (
  id text primary key,
  data text not null,
  updated_at timestamptz not null default now()
);
alter table public.namofood_state enable row level security;
create policy "namofood anon read"  on public.namofood_state for select to anon using (true);
create policy "namofood anon write" on public.namofood_state for insert to anon with check (true);
create policy "namofood anon update" on public.namofood_state for update to anon using (true) with check (true);
-- (선택) 1년 지난 날짜별 기록을 앱이 자동 정리할 수 있게 하려면:
create policy "namofood anon delete old" on public.namofood_state for delete to anon using (id like 'namofood@%');
```

그다음 앱의 **저장 · 백업 → 함께 쓰기**에 프로젝트 URL과 anon 키를
넣습니다(빌드에 미리 넣어 두면 입력 불필요). 표에는 암호문만 들어가므로 anon
키가 노출되어도 내용은 읽을 수 없습니다. 단, 표를 지우거나 덮어쓰는 것은 막지
못하니 백업 파일을 가끔 받아 두세요.

## 레시피 자동 채움 (Supabase cron → Edge Function → OpenCode Zen)

레시피가 없는 음식을 **식단 저장 직후 요청**하고, 누락된 요청은 **매분 확인**해
자동으로 채웁니다. 최근 편집 중이어도 생성하고 최신 상태에 충돌 검사 후 병합합니다.
레시피 화면과 내부 조리용 식단에 실제 시작 시각, 진행 단계, 예상 완료 범위,
다음 확인/재시도 시각을 5초마다 갱신합니다. 외부 공지용 화면·인쇄에는 AI 표시가 없습니다.
앱 요청은 비밀번호 기반의 짧은 유효기간 HMAC 서명으로 인증하며 cron 비밀은
클라이언트에 전달하지 않습니다. 동시 요청은 DB에서 하나만 실행합니다.

재료는 **1인 기준**으로 저장해 기존 발주 계산을 유지하고, 조리법은 **100명 기준
급식 대량 작업서**로 생성합니다. 회전솥·대형솥·튀김기·전판과 장비 용량에 따른
분할 조리, 배식 마무리를 명시하며 가정용 프라이팬·숟가락 계량은 거부합니다.
오븐은 선택 장비입니다. 식약처의 대량 조리 가열·보관 기준을 적용합니다.

기존 AI 레시피 중 가정용 조리법은 신규 누락 음식 뒤에 **한 번에 최대 2개**씩
조리법만 전환합니다. 재료·분량·알레르기·출처와 수동 레시피는 그대로 유지하고,
동시 편집은 지문/CAS로 보호합니다. 전환 전에는 고유 암호화 백업을 남깁니다.
레시피 화면에는 전환 대기 수, 진행 내역, 100·300·500명 계산과 선택 음식의
A4 한 장 조리 작업서 인쇄가 있습니다. 복원한 조리법은 수동 선택으로 보호합니다.
읽기 전용 확인: `NMF_PW=... deno run -A tools/audit_bulk_recipes.ts`.

### 급식 메뉴 라이브러리 · 임시 식단 작성

푸드 레시피는 **조리방식 → 주재료**로 찾습니다. 튀김·구이·볶음·찜·조림·무침·부침
아래에서 생선·소고기·돼지고기·닭고기·콩나물·당근·나물 등을 좁히고,
음식명·재료 검색과 국/주찬/부찬 필터를 함께 쓸 수 있습니다. 미분류 음식도 유지합니다.
카페 레시피는 기존 분류를 그대로 사용합니다.

레시피를 **임시 식단에 담기**로 골라 국·메인 2개·부찬 3개(김치 포함)와 추가찬을
구성할 수 있습니다. 날짜·끼니를 지정해 적용하기 전까지는 저장되지 않습니다.
기존 식단이 있으면 교체 확인을 받고 해당 끼니의 음식만 변경합니다. 식수인원·근무표 등은
그대로 두며, 적용한 식단은 직접 작성한 식단으로 보호합니다. 임시 선택은 인쇄에 나오지 않습니다.

`tools/institutional_catalog.ts`의 메뉴 라이브러리는 급식업체 공개 메뉴를 참고한
**AI 작성 대량 조리 초안**입니다. 업체의 공식 레시피를 복제한 자료가 아닙니다.
재료는 1인량, 작업서는 100인 기준이며 실제 납품 규격·장비·배식량에 맞춰 조리 담당자가
확인·조정합니다. 기존 레시피는 덮어쓰지 않고 이름·별칭 중복을 제외한 새 메뉴만 추가합니다.

자동 식단은 등록된 완성 레시피도 후보로 참고합니다. 같은 실제 음식의 별칭까지 비교해
메인과 주찬 추가메뉴는 앞뒤 7일 반복을 막습니다. 국·김치 외 부찬은 하루 안에서 서로 다르게,
앞뒤 3일을 합한 7일에서 최대 2회로 제한합니다. 기존 수동 칸은 보존을 우선합니다.

기존 AI 식단의 일회성 교체는 `tools/refresh_institutional_menus.ts`를 사용합니다.
기본은 미리보기이며 `--today YYYY-MM-DD --apply`를 명시해야 저장합니다.
실행 기록의 AI 추가 칸 또는 검증된 이전 백업만 교체 권한으로 인정하며,
오늘·과거·수동 칸·식수인원·기존 레시피와 무관한 데이터는 보존 검사합니다.
저장 전 암호화 백업, 최신 상태 충돌 검사와 저장 후 재확인을 수행합니다.
실행 기록은 공개 읽기 권한이 없으므로 관리자 조회 결과를 비공개 `--ownership-file`로 전달합니다.

| 파일                                                                 | 설명                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `supabase/functions/nmf-recipe-fill/`                                | Edge Function. 상태 복호화 → 빠진 음식 → deepseek-v4.1-flash(OpenCode Zen)로 레시피 생성, minimax-m3 fallback → CAS 병합·암호화 저장 |
| `supabase/migrations/20260922050000_nmf_recipe_fill_cron.sql`        | 실행 기록 표 `namofood_recipe_runs`와 최초 일정                                                                                      |
| `supabase/migrations/20260922060000_nmf_recipe_fill_every_10min.sql` | pg_cron을 10분마다 확인하도록 변경                                                                                                   |
| `tools/nmf_cron_setup.ps1`                                           | 1회 설정 스크립트 (비밀값 입력 → 마이그레이션 → vault → 배포 → dry-run)                                                              |
| `tools/test_recipe_fill.ts`                                          | 로직 점검 `deno run -A tools/test_recipe_fill.ts`                                                                                    |

처음 한 번: `powershell -ExecutionPolicy Bypass -File tools/nmf_cron_setup.ps1`
— 앱 비밀번호와 OpenCode Zen API 키를 물어 Supabase 비밀로만
저장합니다(저장소에는 남지 않음). 실행 기록 확인:
`select * from namofood_recipe_runs order by started_at desc;` 비밀번호를 바꾸면
`supabase secrets set NMF_PW=새비밀번호` 도 같이 바꿔야 합니다. 레시피 모델은
`NMF_RECIPE_MODEL`(기본 `deepseek-v4.1-flash`)과
`NMF_RECIPE_FALLBACK_MODEL`(기본 `minimax-m3`), 1회 생성 수는
`NMF_MAX_PER_RUN`(기본 8, 메뉴별 병렬 생성), 오류 재시도 대기는
DB claim에서 2분, 실행 제한시간은 4분입니다. LLM 제한은
`NMF_RECIPE_TIMEOUT_MS`(기본 52초, 최대 55초 적용)/`NMF_RECIPE_MAX_TOKENS`로
조정합니다.

## AI 주간 식단 자동 편성

실시간 레시피 실행 잠금·진행 상태·매분 일정은
`supabase/migrations/20260924182650_nmf_recipe_immediate_status.sql`에서 적용합니다.
인쇄는 A4 여백 2mm이며 식단 높이에 맞춰 한 페이지로 자동 축소합니다.
브라우저 회귀 확인: Playwright와 pdf-lib가 설치된 환경에서
`node tools/test_app_print.cjs` (필요하면 `CHROME_PATH` 지정).
대량 조리 화면·계산·편집 보호·인쇄 회귀: `node tools/test_bulk_recipe_ui.cjs`.
식단 인쇄의 조식·중식·석식·야식 체크는 미리보기/인쇄에만 적용하며 최소 한 끼니는
남깁니다. 월·주·하루 보기와 외부/내부 용도 모두 A4 한 페이지로 맞춥니다.
판매 실적의 `식권 금액 · 끼니별 실적`은 기본 접힘이며 눌러서 펼칩니다.
레시피 상태 API는 `https://d-bae.com`과 기존 GitHub 주소만 요청별로 허용하고,
기존 서명/cron 인증은 유지합니다. 회귀: `deno run -A tools/test_recipe_cors.ts`.

2026-09-24를 기준으로 7일 블록을 사용합니다. 기존 수동 셀은 보존하면서 새 최소
구성에서 비어 있는 칸만 채우고, 이후 매일 06:05 KST에 상태를 확인해 **완성된
미래 식단이 7일 미만일 때만** 다음 7일을 만듭니다. 정상 상태에서는 주 1회
생성되고 일시 오류는 다음 날 자동 재시도됩니다. 기본 모델은
`deepseek-v4.1-flash`, fallback은 `minimax-m3`이며 각각 `NMF_MENU_MODEL`,
`NMF_MENU_FALLBACK_MODEL`로 바꿀 수 있습니다.

- 한 끼 10,000원, 조식·중식·석식·야식
- 쌀밥은 별도 입력 없이 매 끼니 기본 포함. 편집 최소 구성은 국 + 메인찬 2개 +
  부찬 3개이며 추가 메뉴는 자유롭게 더하거나 뺄 수 있음
- 기존 수동 입력은 덮어쓰지 않고 AI가 추가한 끼니에는 `🤖 AI 기반 식단 업데이트`
  표시
- 최근 식수 계획 사진의 주차별 조·중·석·야 예상 인원을 2026-12-20까지 미리 넣고
  `📷 예상` 표시(사용자가 바꾼 값은 보존)

| 파일                                                          | 설명                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `supabase/functions/nmf-menu-plan/`                           | 식단 생성·검증·암호화 병합 Edge Function                         |
| `supabase/migrations/20260924162050_nmf_menu_plan_weekly.sql` | 실행 기록 표, Vault 함수 URL, 매일 확인 cron, 최초 2주 범위 보충 |
| `tools/test_menu_plan.ts`                                     | 순수 로직 회귀 테스트 `deno run -A tools/test_menu_plan.ts`      |

실행 기록 확인: `select * from namofood_menu_runs order by started_at desc;`

## 직원 삭제/보관과 근무 내역 보존

직원 명단의 **삭제/보관**은 현재 명단에서만 제외합니다. 근무 기록과 직원 정보는
함께 보관되어, 근무한 달의 주차별 근무표·직원별 인건비·CSV·인쇄에 계속 포함됩니다.
직원별 인건비에는 해당 월 실제 근무 기록이 있는 사람만 표시합니다.
**보관된 명단**은 접힌 목록에서 이름·역할·이전 이름으로 검색하고, 10명씩 페이지로
확인하거나 현재 명단으로 복귀시킬 수 있습니다.

기본 근무 채우기와 지난달 복사는 현재 직원만 대상으로 빈 칸에 적용합니다.
기존 기록은 복사·동기화·백업 불러오기에서 누락되었다는 이유로 삭제하지 않으며,
근무표의 개별 **지우기** 또는 **이 달 근무표 지우기**가 남긴 명시 삭제 표식을
기기 간 공유합니다. 보관/복귀 선택도 재시작과 기기 간 동기화에서 유지합니다.

각 주차의 **이 주차 일괄 입력**을 열고 칸·직원·날짜 또는 주차 전체를 체크해
24시간 형식 시간/휴게를 적용하거나 전날 시간을 복사합니다. 한 주차씩 선택하며,
다른 주차로 이동하거나 입력을 닫으면 선택만 해제되고 기록은 바뀌지 않습니다.
전날 복사는 전월 마지막 날도 포함한 원본 기준이며, 기존 기록을 바꾸기 전
확인합니다. 선택하지 않은 칸은 변경하지 않습니다.

직원 명단은 화면 폭에 맞춘 표로 표시하고, 좁은 화면에서는 직원별 카드로
나누어 가로 스크롤 없이 편집합니다. 이 변경은 근무표 등 다른 표에는 적용하지 않습니다.
화면 검증: `node tools/test_staff_layout.cjs`, 주차별 입력 검증: `node tools/test_weekly_bulk.cjs`.

### 역할과 시급

최초 역할은 총괄/조리 각 15,000원, 보조/이송 각 13,000원입니다.
지정한 현재 직원 3명은 별도 개인 시급을 적용하며 모든 금액은 편집할 수 있습니다.
개인 시급을 비우면 역할 기본 시급을 적용합니다. 기존 보관 직원의 적용 시급은
유지합니다. 역할은 추가/삭제할 수 있고 사용 중인 역할을 삭제할 때는 다른 역할로
옮깁니다. 이때 기존 적용 시급을 개인 시급으로 남겨 뜻하지 않은 인건비 변경을 막습니다.
역할 설정/개인 시급의 편집 표식은 오래된 기기나 백업에서 설정이 되돌아가는 것을 막습니다.
초기 설정 확인: `NMF_PW=... NMF_STAFF_PAY_NAMES='["대상1","대상2","대상3"]' deno run -A tools/apply_staff_pay_settings.ts`.
`--apply`를 명시하면 고유 암호화 백업·충돌 검사를 거쳐 최초 한 번만 적용합니다.

회귀 확인: `node tools/test_staff_history.cjs` (Playwright·pdf-lib·pdfjs-dist 필요).
기존에 삭제된 직원의 남아 있는 근무 기록은
`NMF_PW=... deno run -A tools/recover_staff_history.ts`로 읽기 전용 점검합니다.
`--apply`를 명시하면 고유 암호화 백업과 충돌 검사를 거쳐, 날짜별 백업에서 확인한
정확한 직원 정보만 보관 명단에 추가하며 다른 데이터는 변경하지 않습니다.

## 비밀번호 바꾸기 / 앱 갱신

앱 표시·암호화 잠금 페이지·`ver.json`에 같은 전체 버전 태그를 사용합니다.
업데이트 버튼/암호 해제/재로드 반복 방지 회귀: `NMF_PW=... node tools/test_app_version.cjs`.

```bash
pip install cryptography
python encrypt_app.py 나모푸드_관리앱.html . "새비밀번호"
git add index.html ver.json && git commit -m "앱 갱신" && git push
```

비밀번호를 바꾸면 Supabase에 저장된 데이터는 예전 비밀번호로 잠겨 있으므로,
바꾸기 전에 앱에서 백업 파일을 받고 → 새 비밀번호로 열어 → 백업 불러오기 → 지금
저장 순서로 옮기세요.

## 보안 메모

- 저장소가 공개라도 파일은 암호문입니다. 비밀번호가 짧으면 무차별 대입에
  취약하니 12자 이상을 권합니다.
- 공용 PC에서는 "비밀번호 기억"을 켜지 마세요.
