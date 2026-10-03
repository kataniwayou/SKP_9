<#
Brings the dev stack back after a host restart, in order:
  1. Docker containers: the kind node, its helpers and skp-kafka (never `kafka-dev-broker.ps1 -Up`,
     which recreates the broker and destroys topics and offsets).
  2. Waits for the skp pods to be Ready.
  3. The nine supervised port-forwards (tools/skp-forward-loop.ps1), skipping any port already bound.
  4. Waits for BaseApi, Grafana and Kibana to answer.
  5. Opens every Grafana and Kibana dashboard, one tab each.
  6. Starts the chain workflow (filefetcher-archiveexpander-chain), which a Redis restart forgets.
  7. Runs the endless feed in this window (Ctrl+C stops it).
analyst-monitor is deliberately NOT started: it costs money per fire.

Usage (PowerShell, repo root):  ./tools/dev-up-after-restart.ps1 -StartSerial 559 [-Cycles 0] [-NoFeed] [-NoBrowser]
#>
param(
    [int]$StartSerial = 559,
    [int]$Cycles = 0,
    [switch]$NoFeed,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$chain = '1a56b3ca-e276-4815-87fa-5c2f48ab6dad'

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function PortOpen([int]$port) {
    $c = [System.Net.Sockets.TcpClient]::new()
    try { $c.ConnectAsync('127.0.0.1', $port).Wait(500) -and $c.Connected } catch { $false } finally { $c.Dispose() }
}
function WaitHttp([string]$url, [int]$seconds = 300) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -lt 500) { return $true } } catch { }
        Start-Sleep -Seconds 3
    }
    return $false
}

Step 'Docker containers'
$deadline = (Get-Date).AddMinutes(5)
while (-not (docker info 2>$null)) {
    if ((Get-Date) -gt $deadline) { throw 'Docker Desktop is not running; start it and re-run' }
    Write-Host 'waiting for Docker Desktop...'; Start-Sleep -Seconds 5
}
foreach ($name in 'desktop-control-plane', 'kind-cloud-provider', 'kind-registry-mirror', 'skp-kafka') {
    $state = docker inspect $name --format '{{.State.Status}}' 2>$null
    if (-not $state) { Write-Warning "$name does not exist"; continue }
    if ($state -ne 'running') { docker start $name | Out-Null; Write-Host "started $name (was $state)" }
    else { Write-Host "$name running" }
}

Step 'Waiting for the skp pods'
$deadline = (Get-Date).AddMinutes(10)
do {
    Start-Sleep -Seconds 5
    $pods = kubectl -n skp get pods --no-headers 2>$null
    $notReady = @($pods | Where-Object { $_ -and ($_ -notmatch '\s(\d+)/\1\s+Running') -and ($_ -notmatch 'Completed') })
    if ($pods) { Write-Host ("{0} pods, {1} not ready" -f @($pods).Count, $notReady.Count) }
} while ((-not $pods -or $notReady.Count -gt 0) -and (Get-Date) -lt $deadline)
if ($notReady.Count -gt 0) { Write-Warning "still not ready:`n$($notReady -join "`n")" }

Step 'Port-forwards (supervised)'
$loop = Join-Path $env:TEMP 'skp-forward-loop.ps1'
Copy-Item (Join-Path $PSScriptRoot 'skp-forward-loop.ps1') $loop -Force
$logs = Join-Path $env:TEMP 'skp-port-forwards'
New-Item -ItemType Directory -Force $logs | Out-Null
$forwards = @(
    @('baseapi-service', 18080, 8080), @('prometheus', 19090, 9090), @('elasticsearch', 19200, 9200),
    @('otel-collector', 14317, 4317), @('otel-collector', 18889, 8889), @('redis', 6380, 6379),
    @('rabbitmq', 5673, 5672), @('grafana', 13000, 3000), @('kibana', 15601, 5601)
)
foreach ($f in $forwards) {
    $svc, $local, $remote = $f
    if (PortOpen $local) { Write-Host "$svc $local already bound"; continue }
    Start-Process -WindowStyle Hidden -FilePath 'pwsh' -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-File', $loop, '-Namespace', 'skp', '-Service', $svc,
        '-Local', $local, '-Remote', $remote, '-LogFile', (Join-Path $logs "$svc-$local.log"))
    Write-Host "forwarding $svc $local -> $remote"
}

Step 'Waiting for BaseApi, Grafana, Kibana'
foreach ($u in 'http://localhost:18080/api/v1/workflows', 'http://localhost:13000/api/health', 'http://localhost:15601/api/status') {
    if (WaitHttp $u) { Write-Host "OK $u" } else { Write-Warning "no answer from $u" }
}

if (-not $NoBrowser) {
    Step 'Dashboards'
    $urls = @()
    try {
        $urls += (Invoke-RestMethod -Uri 'http://localhost:13000/api/search?type=dash-db' -Headers @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('admin:admin')) }) |
            ForEach-Object { "http://127.0.0.1:13000$($_.url)" }
    } catch { Write-Warning "Grafana search failed: $($_.Exception.Message)" }
    try {
        $urls += (Invoke-RestMethod -Uri 'http://localhost:15601/api/saved_objects/_find?type=dashboard&per_page=100' -Headers @{ 'kbn-xsrf' = 'x' }).saved_objects |
            ForEach-Object { "http://127.0.0.1:15601/app/dashboards#/view/$($_.id)" }
    } catch { Write-Warning "Kibana search failed: $($_.Exception.Message)" }
    if ($urls.Count -gt 0) {
        Start-Process 'chrome' -ArgumentList (@('--new-window') + $urls)
        $urls | ForEach-Object { Write-Host "opened $_" }
    }
}

Step 'Chain workflow'
$live = kubectl -n skp exec redis-0 -- redis-cli SISMEMBER skp:live $chain 2>$null
if ($live -eq '1') { Write-Host 'chain already live' }
else {
    $r = Invoke-WebRequest -Method Post -Uri 'http://localhost:18080/api/v1/orchestration/start' `
        -ContentType 'application/json' -Body "`"$chain`"" -UseBasicParsing -SkipHttpErrorCheck
    Write-Host "start chain: $($r.StatusCode) $($r.Content)"
}

if (-not $NoFeed) {
    Step "Endless feed from serial $StartSerial (Ctrl+C to stop)"
    Set-Location $repo
    $feedArgs = @('-u', 'tools/simulate-endless-feed.py', '--start-serial', $StartSerial)
    if ($Cycles -gt 0) { $feedArgs += @('--cycles', $Cycles) }
    python @feedArgs
}
