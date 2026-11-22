<#
    Start a Cloudflare Tunnel for Steel Yard Ledger and print the public URL.

    Behavior:
      - Downloads the latest cloudflared release if it is missing.
      - Starts `cloudflared tunnel --url http://127.0.0.1:3000`.
      - Parses the *.trycloudflare.com URL from the tunnel output.
      - Health-checks GET http://127.0.0.1:3000/api/health through the tunnel URL.
      - Prints the tunnel URL and usage notes. The tunnel keeps running in the
        background (log: logs\cloudflared-tunnel.log).

    Usage: .\scripts\run-cloudflare-tunnel.ps1
#>

$AppRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$CloudflaredDir = Join-Path $AppRoot ".cloudflared"
$CloudflaredExe = Join-Path $CloudflaredDir "cloudflared.exe"
$TunnelUrlPattern = "https?://[a-z0-9-]+(?:\.[a-z0-9-]+)*\.trycloudflare\.com"
$TunnelOrigin = "http://127.0.0.1:3000"

# --- 1. Get cloudflared (download latest if missing) ---
if (-not (Test-Path -LiteralPath $CloudflaredExe)) {
    New-Item -ItemType Directory -Force -Path $CloudflaredDir | Out-Null
    $SourceUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    Write-Output "cloudflared not found; downloading latest from $SourceUrl ..."
    Invoke-WebRequest -Uri $SourceUrl -OutFile $CloudflaredExe -UseBasicParsing -ErrorAction Stop
}
Write-Output "Using cloudflared: $CloudflaredExe"

# --- 2. Start the tunnel ---
$LogDir = Join-Path $AppRoot "logs"
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
$TunnelLog = Join-Path $LogDir "cloudflared-tunnel.log"

Write-Output "Starting tunnel: $CloudflaredExe tunnel --url $TunnelOrigin"
$proc = Start-Process -FilePath $CloudflaredExe -ArgumentList "tunnel --url $TunnelOrigin" -RedirectStandardOutput $TunnelLog -RedirectStandardError $TunnelLog -PassThru -WindowStyle Hidden -ErrorAction Stop

# --- 3. Parse the *.trycloudflare.com URL from the tunnel output ---
$TunnelUrl = $null
$Deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $Deadline) {
    if (Test-Path -LiteralPath $TunnelLog) {
        $match = Select-String -Path $TunnelLog -Pattern $TunnelUrlPattern -AllMatches
        if ($match -and $match.Matches.Count -gt 0) {
            $TunnelUrl = $match.Matches[0].Value
            break
        }
    }
    if ($proc.HasExited) { break }
    Start-Sleep -Seconds 2
}

if (-not $TunnelUrl) {
    Write-Error "Could not parse a *.trycloudflare.com URL from the tunnel output ($TunnelLog). See log for details."
    exit 1
}

# --- 4. Health check through the tunnel ---
Write-Output "Health-checking $TunnelUrl/api/health ..."
$Healthy = $false
$Deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $Deadline) {
    try {
        $resp = Invoke-WebRequest -Uri "$TunnelUrl/api/health" -UseBasicParsing -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { $Healthy = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
}
if ($Healthy) {
    Write-Output "Health check OK: GET $TunnelUrl/api/health -> 200"
} else {
    Write-Output "Health check did not return 200 within 60s; see $TunnelLog"
}

# --- 5. Instructions ---
Write-Output ""
Write-Output "Your public tunnel URL:"
Write-Output "    $TunnelUrl"
Write-Output ""
Write-Output "Notes:"
Write-Output "    - Save this URL now: it is a free, public URL, but NOT permanent. Cloudflare may reclaim"
Write-Output "      the name at any time if the tunnel is unused or capacity is needed. For a permanent"
Write-Output "      URL use a Named Tunnel with your own domain (see docs\permanent-url-cloudflare.md)."
Write-Output "    - The tunnel keeps running in the background; log: $TunnelLog (pid $($proc.Id))."
Write-Output "    - The app itself runs at http://127.0.0.1:3000 (health: /api/health)."
Write-Output "    - For a permanent public URL, use the Named Tunnel flow: cloudflared tunnel create, then point"
Write-Output "      a DNS record to https://steel-yard-ledger.yourdomain.com -> http://127.0.0.1:3000 and run"
Write-Output "      `cloudflared tunnel run <name>`; keep it running."
