# Signs the Firefox build as an unlisted add-on on addons.mozilla.org (AMO).
# The signed .xpi installs permanently in release Firefox without being listed publicly.
#
# Credentials: AMO API key (JWT issuer + secret) from
#   https://addons.mozilla.org/developers/addon/api/key/
# Taken from $env:AMO_JWT_ISSUER / $env:AMO_JWT_SECRET if set, otherwise prompted
# (secret input is hidden). They are never written to disk or echoed.
#
# Usage (from the repo root):  powershell -ExecutionPolicy Bypass -File scripts\sign-firefox.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$issuer = $env:AMO_JWT_ISSUER
if (-not $issuer) { $issuer = Read-Host "AMO JWT issuer (user:12345:67)" }
$secret = $env:AMO_JWT_SECRET
if (-not $secret) {
  $secure = Read-Host "AMO JWT secret" -AsSecureString
  $secret = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if (-not $issuer -or -not $secret) { throw "AMO credentials missing." }

npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed." }

$out = "release\signed"
New-Item -ItemType Directory -Force $out | Out-Null
# web-ext reads the credentials from these variables, so they never appear in the process arguments
$env:WEB_EXT_API_KEY = $issuer
$env:WEB_EXT_API_SECRET = $secret
try {
  npx --yes web-ext@10.7.0 sign --channel=unlisted --source-dir dist\firefox --artifacts-dir $out
  if ($LASTEXITCODE -ne 0) { throw "Signing failed (exit $LASTEXITCODE)." }
} finally {
  Remove-Item Env:WEB_EXT_API_KEY, Env:WEB_EXT_API_SECRET -ErrorAction SilentlyContinue
}

$xpi = Get-ChildItem $out -Filter *.xpi | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host ""
Write-Host "Signed: $($xpi.FullName)"
Write-Host "Install: drag the file into Firefox, or about:addons -> gear -> 'Install Add-on From File'."
