# Go-live for payments, in one sitting. Run from anywhere:
#
#   powershell -ExecutionPolicy Bypass -File scripts\go-live-payments.ps1
#
# What it does, in order — each step aborts the run if it fails:
#   1. Pulls main (the live-mode vars table merged with this script).
#   2. Asks for the two LIVE credentials, masked, and puts them in Phase
#      Production: DODO_API_KEY (Dodo -> Developer -> API Keys, Live Mode) and
#      DODO_WEBHOOK_SECRET (Developer -> Webhooks -> the xecret.playxoft.com
#      endpoint -> Signing secret). The values go terminal -> Phase -> Worker
#      and are never echoed or written to disk.
#   3. Pushes both to the production Worker as encrypted secrets.
#   4. Preflights: check:env (validates the key against live mode and reads
#      one product with it) and check:deploy production (zero failures or stop).
#   5. Deploys production, then smoke-checks: /api/version, the webhook
#      refusing an unsigned POST with 401, and /pricing answering 200.
#
# After it finishes: buy nothing yourself by card you can't refund — but DO
# run the two first-live-charge checks the runbook names
# (docs/operations/billing.md §3): the first real upgrade during a trial and
# the first real natural conversion.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Fail($msg) { Write-Host "`nSTOP: $msg" -ForegroundColor Red; exit 1 }

Write-Host "== 1/5 Sync main =="
git switch main | Out-Null
git pull --ff-only
if ($LASTEXITCODE -ne 0) { Fail "git pull failed" }
$dodoLive = Select-String -Path "apps\web\wrangler.toml" -Pattern '^DODO_ENVIRONMENT = "live_mode"' -Quiet
if (-not $dodoLive) { Fail "main does not carry the live-mode vars table yet — merge the go-live PR first" }

Write-Host "`n== 2/5 The two LIVE credentials into Phase Production =="
Write-Host "Paste each value; input is hidden. Create them in Dodo LIVE mode first."

function Read-Secret($label) {
  $sec = Read-Host -AsSecureString "$label"
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Put-PhaseSecret($name, $value) {
  $value | phase secrets create $name --env Production 2>$null
  if ($LASTEXITCODE -ne 0) {
    # Already exists — update instead.
    $value | phase secrets update $name --env Production
    if ($LASTEXITCODE -ne 0) { Fail "could not write $name to Phase Production" }
  }
  Write-Host "  $name -> Phase Production: ok"
}

$apiKey = Read-Secret "DODO_API_KEY (live, starts with nothing special — copy it whole)"
if ($apiKey.Length -lt 20) { Fail "that API key looks too short" }
$whSecret = Read-Secret "DODO_WEBHOOK_SECRET (starts with whsec_)"
if (-not $whSecret.StartsWith('whsec_')) { Fail "a Dodo signing secret starts with whsec_" }

Put-PhaseSecret 'DODO_API_KEY' $apiKey
Put-PhaseSecret 'DODO_WEBHOOK_SECRET' $whSecret

Write-Host "`n== 3/5 Push both to the production Worker =="
Set-Location "$repo\apps\web"
$apiKey | npx wrangler secret put DODO_API_KEY --env production
if ($LASTEXITCODE -ne 0) { Fail "wrangler secret put DODO_API_KEY failed" }
$whSecret | npx wrangler secret put DODO_WEBHOOK_SECRET --env production
if ($LASTEXITCODE -ne 0) { Fail "wrangler secret put DODO_WEBHOOK_SECRET failed" }
$apiKey = $null; $whSecret = $null
Set-Location $repo

Write-Host "`n== 4/5 Preflight =="
npm run phase:check-env:production
if ($LASTEXITCODE -ne 0) { Fail "check:env refused the configuration — read its lines above" }
npm run phase:check-deploy
if ($LASTEXITCODE -ne 0) { Fail "check:deploy found failures — never deploy over them" }

Write-Host "`n== 5/5 Deploy production =="
npm run phase:deploy
if ($LASTEXITCODE -ne 0) { Fail "the deploy itself failed" }

Write-Host "`n== Smoke checks =="
Start-Sleep -Seconds 15
$version = Invoke-RestMethod "https://xecret.playxoft.com/api/version"
Write-Host "  version: $($version.commit) built $($version.builtAt)"
try {
  Invoke-WebRequest -Method Post -Uri "https://xecret.playxoft.com/api/billing/webhook" -Body '{}' -ContentType 'application/json' | Out-Null
  Fail "the webhook accepted an UNSIGNED post — investigate before anything else"
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 401) { Write-Host "  webhook: refuses unsigned posts (401) - ok" }
  else { Fail "webhook answered $code to an unsigned post — expected 401 (a 503 means a secret is missing)" }
}
$pricing = Invoke-WebRequest "https://xecret.playxoft.com/pricing" -Method Head
Write-Host "  pricing: $($pricing.StatusCode) - ok"

Write-Host "`nPayments are LIVE." -ForegroundColor Green
Write-Host "Remaining by hand: watch the Dodo endpoint log answer 200 on the first real delivery,"
Write-Host "and run the two first-live-charge checks in docs/operations/billing.md §3."
