# 나모푸드 AI 레시피·주간 식단(pg_cron → Edge Function → OpenCode Zen) 1회 설정
# 실행: 저장소 루트에서  powershell -ExecutionPolicy Bypass -File tools/nmf_cron_setup.ps1
# 하는 일: 1) Edge Function 비밀 설정  2) 마이그레이션(cron·runs 표) 적용  3) vault 에 함수 URL·비밀 등록  4) 함수 배포  5) dry-run·최초 식단 확인
$ErrorActionPreference = "Stop"
$ref = "rycibsczsgbkgtwfxyim"
$fnUrl = "https://$ref.supabase.co/functions/v1/nmf-recipe-fill"
$menuFnUrl = "https://$ref.supabase.co/functions/v1/nmf-menu-plan"

Write-Host "`n[1/5] 비밀값 입력 (화면에 표시되지 않습니다)"
$pw     = Read-Host "앱(홈페이지) 비밀번호 NMF_PW" -AsSecureString
$zen    = Read-Host "OpenCode Zen API 키 OPENCODE_API_KEY" -AsSecureString
$plainPw  = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))
$plainZen = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($zen))
$cron = -join ((1..40) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })   # cron ↔ 함수 공유 비밀 (자동 생성)

npx --yes supabase link --project-ref $ref | Out-Null
npx --yes supabase secrets set "NMF_PW=$plainPw" "OPENCODE_API_KEY=$plainZen" "NMF_CRON_SECRET=$cron" "NMF_RECIPE_MODEL=deepseek-v4.1-flash" "NMF_RECIPE_FALLBACK_MODEL=minimax-m3" "NMF_MENU_MODEL=deepseek-v4.1-flash" "NMF_MENU_FALLBACK_MODEL=minimax-m3"
if (-not $?) { throw "secrets set 실패" }

Write-Host "`n[2/5] 마이그레이션 적용 (DB 비밀번호를 물으면 Supabase 대시보드 > Settings > Database 의 비밀번호)"
npx --yes supabase db push
if (-not $?) { throw "db push 실패 — 대신 supabase/migrations/*.sql 을 SQL Editor 에 붙여 실행해도 됩니다" }

Write-Host "`n[3/5] vault 에 함수 URL·비밀 등록"
$sql = @"
do `$`$ begin
  if exists (select 1 from vault.secrets where name='nmf_recipe_fill_url') then perform vault.update_secret((select id from vault.secrets where name='nmf_recipe_fill_url'), '$fnUrl'); else perform vault.create_secret('$fnUrl','nmf_recipe_fill_url'); end if;
  if exists (select 1 from vault.secrets where name='nmf_recipe_fill_secret') then perform vault.update_secret((select id from vault.secrets where name='nmf_recipe_fill_secret'), '$cron'); else perform vault.create_secret('$cron','nmf_recipe_fill_secret'); end if;
end `$`$;
"@
$tmp = New-TemporaryFile; Set-Content -Path $tmp -Value $sql -Encoding utf8
npx --yes supabase db query --linked --file $tmp
Remove-Item $tmp
if (-not $?) { throw "vault 등록 실패" }

Write-Host "`n[4/5] 함수 배포"
npx --yes supabase functions deploy nmf-recipe-fill --no-verify-jwt
if (-not $?) { throw "deploy 실패" }
npx --yes supabase functions deploy nmf-menu-plan --no-verify-jwt
if (-not $?) { throw "식단 함수 deploy 실패" }

Write-Host "`n[5/5] 레시피 dry-run + 2026-09-24 기준 최초 식단 범위 보충"
$r = Invoke-RestMethod -Method Post -Uri $fnUrl -Headers @{ Authorization = "Bearer $cron"; "Content-Type" = "application/json" } -Body '{"dry":true}'
$r | ConvertTo-Json -Depth 4
for ($i = 1; $i -le 2; $i++) {
  $m = Invoke-RestMethod -Method Post -Uri $menuFnUrl -Headers @{ Authorization = "Bearer $cron"; "Content-Type" = "application/json"; "x-source" = "setup_bootstrap" } -Body '{"weeks":2}'
  $m | ConvertTo-Json -Depth 6
  if (-not $m.needsFollowUp) { break }
}
Write-Host "`n완료. 레시피는 저장 직후 요청하고 매분 재확인합니다. 식단은 매일 확인하되 향후 완성분이 7일 미만일 때만 새 7일을 만듭니다."
Write-Host "실행 기록: namofood_recipe_runs / namofood_menu_runs"
Write-Host "지금 바로 한 번 돌리기:  Invoke-RestMethod -Method Post -Uri $fnUrl -Headers @{Authorization='Bearer $cron'} -Body '{}' -ContentType application/json"
