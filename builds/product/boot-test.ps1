$app = "C:\Users\yeswa\Documents\steel-yard-ledger-fixed\steel-yard-ledger"
$prod = "$app\builds\product"
"firestore creds present: $((Test-Path "$prod\data\firebase-service-account.json"))"

$pinfo = New-Object System.Diagnostics.ProcessStartInfo
$pinfo.FileName = (Get-Command node -Type Application | Select-Object -First 1).Source
$pinfo.Arguments = "server.js"
$pinfo.WorkingDirectory = $prod
$pinfo.WindowStyle = "Hidden"
$pinfo.RedirectStandardOutput = "$prod\boot.log"
$pinfo.RedirectStandardError = "$prod\boot.log"
$pinfo.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($pinfo)
Start-Sleep -Seconds 15

$base = "http://127.0.0.1:3000"
function HttpGet($url) {
  $req = [System.Net.WebRequest]::Create($url)
  try {
    $resp = $req.GetResponse()
    $code = $resp.StatusCode
    $body = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
    $resp.Close()
    return "$code | " + ($body.Substring(0, [Math]::Min(90, $body.Length)) -replace "`n", " ")
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if ($resp) { $code = $resp.StatusCode } else { $code = "ERR" }
    return "$code | error page"
  } catch { return "ERR | $($_.Exception.Message)" }
}

"api/health:            $(HttpGet "$base/api/health")"
"login:                $(HttpGet "$base/login")"
"analytics page:       $(HttpGet "$base/analytics")"
"vendors page:         $(HttpGet "$base/vendors")"
"bulk page:            $(HttpGet "$base/bulk")"
"team page:            $(HttpGet "$base/team")"
"alerts page:          $(HttpGet "$base/alerts")"
"api/analytics/inv:    $(HttpGet "$base/api/analytics/inventory")"
"api/vendors:          $(HttpGet "$base/api/vendors")"
"api/analytics/rev:    $(HttpGet "$base/api/analytics/revenue")"
"api/analytics/sales:  $(HttpGet "$base/api/analytics/sales")"

try {
  $conn = Get-NetTCPConnection -LocalPort 3000 -State Listen
  if ($conn) { Stop-Process -Id $conn.OwningProcess -Force }
} catch { }

"=== boot.log ==="; Get-Content "$prod\boot.log" -Tail 12
