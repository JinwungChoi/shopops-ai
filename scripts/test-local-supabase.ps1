param([switch]$LiveModel, [switch]$Serve)

$ErrorActionPreference = 'Stop'
$local = supabase status -o json 2>$null | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $local.API_URL -notmatch '^http://(127\.0\.0\.1|localhost):\d+$') {
    throw '로컬 Supabase를 시작한 뒤 다시 실행하세요.'
}
$env:SHOP_OPS_BACKEND = 'supabase'
$env:SHOP_OPS_FAKE_EMBEDDINGS = if ($LiveModel) { '0' } else { '1' }
$env:SHOP_OPS_LIVE_MODEL = if ($LiveModel) { '1' } else { '0' }
$env:OPENAI_CHAT_MODEL = 'gpt-6-luna'
$env:OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
$env:NEXT_PUBLIC_SUPABASE_URL = $local.API_URL
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = $local.PUBLISHABLE_KEY ?? $local.ANON_KEY
$env:SUPABASE_SECRET_KEY = $local.SECRET_KEY ?? $local.SERVICE_ROLE_KEY
if ($Serve) {
    node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3031
} else {
    npm.cmd run test:e2e
}
exit $LASTEXITCODE
