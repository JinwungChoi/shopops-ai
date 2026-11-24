param([ValidateSet('baseline','candidate')][string]$Label = 'candidate')
$ErrorActionPreference = 'Stop'

$local = supabase status -o json 2>$null | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $local.API_URL -notmatch '^http://(127\.0\.0\.1|localhost):\d+$') {
    throw '로컬 Supabase를 시작해 주세요.'
}

$env:NEXT_PUBLIC_SUPABASE_URL = $local.API_URL
$env:SUPABASE_SECRET_KEY = $local.SECRET_KEY ?? $local.SERVICE_ROLE_KEY
$env:SHOP_OPS_EVAL_LABEL = $Label
$env:SHOP_OPS_FAKE_EMBEDDINGS = '0'
$env:SHOP_OPS_LIVE_MODEL = '1'
$env:OPENAI_CHAT_MODEL = 'gpt-6-luna'
$env:OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'

node --env-file-if-exists=.env.local node_modules/vitest/vitest.mjs run --config vitest.eval.config.mts
$code = $LASTEXITCODE
if ($code -eq 0) {
    $report = Get-Content -Raw -Encoding UTF8 ".shopops/evals/$Label.json" | ConvertFrom-Json
    [pscustomobject]@{
        Summary = $report.summary
        ByShop = $report.byShop
        Holdout = $report.holdout
        Failures = $report.failures
    } | ConvertTo-Json -Depth 6
}
exit $code
