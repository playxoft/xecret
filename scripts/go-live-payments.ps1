# Go-live for payments, in one sitting. ASCII only: Windows PowerShell 5.1
# reads a BOM-less file in the ANSI code page, where a smart dash becomes a
# quote character and the script stops parsing.
#
#   powershell -ExecutionPolicy Bypass -File scripts\go-live-payments.ps1
#
# Order matters, and it is: everything into Phase first, validate there, and
# only then touch the production Worker -- so a failed run before step 4
# leaves production exactly as it was.
#
#   1. Sanity: clean tree, main up to date, live vars present, `sh` on PATH
#      (the deploy script needs it; a plain PowerShell window often lacks it).
#   2. The two LIVE credentials, prompted masked, plus the six non-secret
#      DODO_* vars read out of wrangler.toml -- all written to Phase
#      Production. Nothing is echoed and nothing touches disk.
#   3. check:env against Phase Production (validates the key against live
#      mode by reading one product with it). Fails here = production
#      untouched.
#   4. Both secrets onto the production Worker. From this point a failure
#      leaves the Worker half-configured: billing routes answer 503, seat
#      changes queue debts -- the error text says how to finish or undo.
#   5. check:deploy production (zero failures or stop), deploy, then smoke
#      checks: version matches HEAD, webhook refuses an unsigned POST with
#      401, the five internal routes answer 404, pricing answers 200, and a
#      final check:deploy.
#
# Afterwards, the runbook keeps two first-live-charge checks
# (docs/operations/billing.md section 3): the first real upgrade during a
# trial, and the first real natural conversion at a trial's end.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo

$workerTouched = $false
function Fail($msg) {
  Write-Host ""
  Write-Host "STOP: $msg" -ForegroundColor Red
  if ($script:workerTouched) {
    Write-Host "The production Worker already holds the Dodo secret(s)." -ForegroundColor Yellow
    Write-Host "Finish by re-running this script, or undo with:" -ForegroundColor Yellow
    Write-Host "  cd apps\web" -ForegroundColor Yellow
    Write-Host "  npx wrangler secret delete DODO_API_KEY --env production" -ForegroundColor Yellow
    Write-Host "  npx wrangler secret delete DODO_WEBHOOK_SECRET --env production" -ForegroundColor Yellow
  }
  Pop-Location
  exit 1
}

Write-Host "== 1/5 Sanity =="
$dirty = git status --porcelain
if ($LASTEXITCODE -ne 0) { Fail "not a git checkout" }
if ($dirty) { Fail "the tree has uncommitted changes -- commit or stash them first" }
git switch main | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "could not switch to main" }
git pull --ff-only
if ($LASTEXITCODE -ne 0) { Fail "git pull failed" }
if (-not (Select-String -Path "apps\web\wrangler.toml" -Pattern '^DODO_ENVIRONMENT = "live_mode"' -Quiet)) {
  Fail "main does not carry the live-mode vars table yet -- merge the go-live PR first"
}
if (-not (Get-Command sh -ErrorAction SilentlyContinue)) {
  $gitUsrBin = "C:\Program Files\Git\usr\bin"
  if (Test-Path "$gitUsrBin\sh.exe") { $env:Path = "$env:Path;$gitUsrBin" }
  if (-not (Get-Command sh -ErrorAction SilentlyContinue)) {
    Fail "no 'sh' on PATH and none at $gitUsrBin -- the deploy script needs it; run from Git Bash instead"
  }
}

Write-Host ""
Write-Host "== 2/5 Phase Production: the two credentials and the six vars =="
Write-Host "Create both in Dodo LIVE mode first. Input is hidden."

function Read-Secret($label) {
  $sec = Read-Host -AsSecureString "$label"
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

# Existence decides create vs update: a stderr redirect under 5.1 with
# ErrorActionPreference Stop turns any native stderr line into a terminating
# error (PowerShell issue 4002), so the old try-create-then-update shape dies
# exactly when it is needed. The listing is captured, never printed -- phase
# masks values in it, but even masked values stay off the screen.
$phaseListing = phase secrets list --env Production 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Fail "phase secrets list failed -- is the Phase CLI signed in?" }

function Put-PhaseSecret($name, $value) {
  if ($script:phaseListing -match [regex]::Escape($name)) {
    $value | phase secrets update $name --env Production | Out-Null
  } else {
    $value | phase secrets create $name --env Production | Out-Null
  }
  if ($LASTEXITCODE -ne 0) { Fail "could not write $name to Phase Production" }
  Write-Host "  $name -> Phase Production: ok"
}

$apiKey = Read-Secret "DODO_API_KEY (live)"
if ($apiKey.Length -lt 20) { Fail "that API key looks too short" }
$whSecret = Read-Secret "DODO_WEBHOOK_SECRET (starts with whsec_)"
if (-not $whSecret.StartsWith('whsec_')) { Fail "a Dodo signing secret starts with whsec_" }
try {
  $raw = [Convert]::FromBase64String($whSecret.Substring(6))
  if ($raw.Length -lt 16) { Fail "the signing secret decodes to fewer than 16 bytes -- wrong paste?" }
} catch { Fail "the part after whsec_ is not valid base64 -- wrong paste?" }

Put-PhaseSecret 'DODO_API_KEY' $apiKey
Put-PhaseSecret 'DODO_WEBHOOK_SECRET' $whSecret

# The six non-secret vars, read from the same wrangler.toml the deploy will
# assert, so Phase can never drift from it. check:env needs them in the
# environment, and check:deploy compares the two copies.
$varLines = node -e "const{unstable_readConfig}=require('wrangler');const c=unstable_readConfig({config:'apps/web/wrangler.toml',env:'production'});for(const k of['DODO_ENVIRONMENT','DODO_PRODUCT_PRO_MONTHLY','DODO_PRODUCT_PRO_YEARLY','DODO_PRODUCT_TEAM_MONTHLY','DODO_PRODUCT_TEAM_YEARLY','DODO_METER_SECRET_FETCH']){if(!c.vars[k])process.exit(2);console.log(k+'='+c.vars[k])}"
if ($LASTEXITCODE -ne 0) { Fail "could not read the DODO_* vars out of wrangler.toml" }
foreach ($line in $varLines) {
  $name, $value = $line -split '=', 2
  Put-PhaseSecret $name $value
}

Write-Host ""
Write-Host "== 3/5 check:env against Phase Production (production untouched so far) =="
npm run phase:check-env:production
if ($LASTEXITCODE -ne 0) { Fail "check:env refused the configuration -- read its lines above; production is unchanged" }

Write-Host ""
Write-Host "== 4/5 The two secrets onto the production Worker =="
Set-Location "$repo\apps\web"
$workerTouched = $true
$apiKey | npx wrangler secret put DODO_API_KEY --env production
if ($LASTEXITCODE -ne 0) { Fail "wrangler secret put DODO_API_KEY failed" }
$whSecret | npx wrangler secret put DODO_WEBHOOK_SECRET --env production
if ($LASTEXITCODE -ne 0) { Fail "wrangler secret put DODO_WEBHOOK_SECRET failed" }
$apiKey = $null; $whSecret = $null
Set-Location $repo

Write-Host ""
Write-Host "== 5/5 Preflight, deploy, smoke =="
npm run phase:check-deploy
if ($LASTEXITCODE -ne 0) { Fail "check:deploy found failures -- never deploy over them" }
npm run phase:deploy
if ($LASTEXITCODE -ne 0) { Fail "the deploy itself failed" }

Start-Sleep -Seconds 15
$head = (git rev-parse --short HEAD).Trim()
$version = Invoke-RestMethod -UseBasicParsing "https://xecret.playxoft.com/api/version"
Write-Host "  version: $($version.commit) built $($version.builtAt)"
if (-not ($version.commit -match [regex]::Escape($head))) {
  Fail "the deployed commit does not contain $head -- the site is running something else"
}
try {
  Invoke-WebRequest -UseBasicParsing -Method Post -Uri "https://xecret.playxoft.com/api/billing/webhook" -Body '{}' -ContentType 'application/json' | Out-Null
  Fail "the webhook accepted an UNSIGNED post -- investigate before anything else"
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 401) { Write-Host "  webhook: refuses unsigned posts (401) - ok" }
  else { Fail "webhook answered $code to an unsigned post -- expected 401 (503 means billing is off or half-configured)" }
}
foreach ($job in 'vault-purge', 'prune', 'billing-hourly', 'notifications', 'billing-daily') {
  try {
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri "https://xecret.playxoft.com/api/internal/scheduled/$job" | Out-Null
    Fail "internal route $job answered the internet -- roll back"
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 404) { Fail "internal route $job answered $($_.Exception.Response.StatusCode.value__) -- expected 404" }
  }
}
Write-Host "  internal routes: all 404 - ok"
$pricing = Invoke-WebRequest -UseBasicParsing "https://xecret.playxoft.com/pricing" -Method Head
Write-Host "  pricing: $($pricing.StatusCode) - ok"
npm run phase:check-deploy
if ($LASTEXITCODE -ne 0) { Fail "the post-deploy check:deploy found failures" }

Write-Host ""
Write-Host "Payments are LIVE." -ForegroundColor Green
Write-Host "Remaining by hand: watch the Dodo endpoint log answer 200 on the first real delivery,"
Write-Host "and run the two first-live-charge checks in docs/operations/billing.md section 3."
Pop-Location
