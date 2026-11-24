param([switch]$FreshReturn)

$ErrorActionPreference = 'Stop'
$local = supabase status -o json 2>$null | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $local.API_URL -notmatch '^http://(127\.0\.0\.1|localhost):\d+$') {
    throw '로컬 Supabase를 시작해 주세요.'
}
$env:NEXT_PUBLIC_SUPABASE_URL = $local.API_URL
$env:SUPABASE_SECRET_KEY = $local.SECRET_KEY ?? $local.SERVICE_ROLE_KEY
if ($FreshReturn) {
    node scripts/seed-mock-orders.mjs --fresh-return
} else {
    node scripts/seed-mock-orders.mjs
}
exit $LASTEXITCODE
