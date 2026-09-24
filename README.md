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

식단표에 있지만 레시피가 없는 음식을 **10분마다 확인**해(마지막 저장 4분 뒤)
자동으로 조사해 넣습니다 (앱에는 🤖 표시). 최근 저장·직전 오류로 건너뛴 실행도
`status = skipped` 로 기록됩니다. MIO 와 같은 구조입니다.

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
`NMF_MAX_PER_RUN`(기본 8, 메뉴별 병렬 생성), 오류 backoff는
`NMF_RECIPE_ERROR_BACKOFF_MINUTES`(기본 20분), LLM 제한은
`NMF_RECIPE_TIMEOUT_MS`(기본 52초, 최대 55초 적용)/`NMF_RECIPE_MAX_TOKENS`로
조정합니다.

## AI 주간 식단 자동 편성

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

## 비밀번호 바꾸기 / 앱 갱신

```bash
pip install cryptography
python encrypt_app.py 나모푸드_관리앱.html . "새비밀번호"
git add index.html && git commit -m "앱 갱신" && git push
```

비밀번호를 바꾸면 Supabase에 저장된 데이터는 예전 비밀번호로 잠겨 있으므로,
바꾸기 전에 앱에서 백업 파일을 받고 → 새 비밀번호로 열어 → 백업 불러오기 → 지금
저장 순서로 옮기세요.

## 보안 메모

- 저장소가 공개라도 파일은 암호문입니다. 비밀번호가 짧으면 무차별 대입에
  취약하니 12자 이상을 권합니다.
- 공용 PC에서는 "비밀번호 기억"을 켜지 마세요.
