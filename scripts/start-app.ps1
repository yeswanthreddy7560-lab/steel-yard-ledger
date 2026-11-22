<#
    Start the Steel Yard Ledger app (`node server.js`) if nothing is already
    listening on port 3000.

    Usage: .\scripts\start-app.ps1
#>

$AppRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$Port = 3000
$HealthUri = "http://127.0.0.1:$Port/api/health"

function Test-PortInUse([int]$Port) {
    $null -ne (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' })
}

if (Test-PortInUse $Port) {
    Write-Output "Port $Port is already in use; the app appears to be running at $HealthUri"
    exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "node is not installed or not on PATH; cannot start the app."
    exit 1
}

Write-Output "Starting app: node server.js (working dir: $AppRoot)"
$proc = Start-Process -FilePath node -ArgumentList "server.js" -WorkingDirectory $AppRoot -PassThru -WindowStyle Hidden -ErrorAction Stop

$ready = $false
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if ($proc.HasExited) { break }
    try {
        $resp = Invoke-WebRequest -Uri $HealthUri -UseBasicParsing -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
}

if ($ready) {
    Write-Output "App is up at http://127.0.0.1:$Port (pid $($proc.Id)); health check $HealthUri -> 200"
} else {
    Write-Output "App did not answer $HealthUri within 30s (pid $($proc.Id) is running; check it or the app logs)."
}
