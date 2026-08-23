<#
.SYNOPSIS
Opens — and keeps open — the forwards the RealStack and chaos tests expect.

.DESCRIPTION
Every local port is offset from its in-cluster number so a forward can never be mistaken for, or
collide with, a local service.

Each forward is supervised. `kubectl port-forward` treats a TCP reset on any one proxied
connection as fatal to the whole forward and exits with `error: lost connection to pod`, so a
single ungraceful client teardown takes the port down for every test that follows. RabbitMQ is
where this bites: a client that aborts the AMQP handshake mid-`starting` — cancelling a processor
boot does it — makes the broker reset the connection, and the forward dies as collateral while the
test that caused it often passes. Everything broker-dependent after that point then fails on a
one-to-two-minute timeout that looks exactly like a real identity-resolution bug.

The supervisor is a restart loop per forward rather than a health poll: it reacts to kubectl's own
exit rather than to a probe. Measured recovery is ~4s end to end, nearly all of it kubectl's own
startup. A poll cannot match that — it adds its interval on top, and probing a forward that is
merely idle gets it torn down and restarted for nothing.

Note that not every failure is fatal to the forward: kubectl logs per-connection copy errors
(portforward.go:391/404, "An existing connection was forcibly closed") and carries on. Only
"lost connection to pod" ends the process, and only that trips the supervisor.

.PARAMETER Stop
Tear down the forwards this script started, and their supervisors.

.PARAMETER Status
Report which forwards are up, and how many times each has been restarted.

.EXAMPLE
./k8s/port-forward-realstack.ps1
$env:SKP_REALSTACK = "1"
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj

.EXAMPLE
./k8s/port-forward-realstack.ps1 -Stop
#>
[CmdletBinding()]
param(
    [switch]$Stop,
    [switch]$Status
)

$ns = "skp"
$forwards = @(
    @{ svc = "rabbitmq";       local = 5673;  remote = 5672 },
    @{ svc = "baseapi-service";local = 18080; remote = 8080 },
    @{ svc = "otel-collector"; local = 14317; remote = 4317 },
    @{ svc = "otel-collector"; local = 18889; remote = 8889 },
    @{ svc = "redis";          local = 6380;  remote = 6379 },
    @{ svc = "elasticsearch";  local = 19200; remote = 9200 },
    @{ svc = "prometheus";     local = 19090; remote = 9090 }
)

$stateFile = Join-Path ([IO.Path]::GetTempPath()) "skp-port-forwards.pid"

# One log per forward, never a shared one. Seven children appending to a single file contend for
# its lock; the loser's Out-File throws, which breaks the pipeline it is the tail of and takes that
# forward's kubectl down with it. Under test load — when every forward is logging a connection per
# request — they kill each other continuously and no forward ever stays up.
$logDir = Join-Path ([IO.Path]::GetTempPath()) "skp-port-forwards"
function Get-LogPath($f) { Join-Path $logDir "$($f.svc)-$($f.local).log" }

function Test-Port([int]$Port) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        # Connect only. Never write to the socket: an unexpected payload on the AMQP port is
        # exactly the handshake abort that kills the forward this script exists to keep alive.
        $null = $client.ConnectAsync("127.0.0.1", $Port).Wait(1500)
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Get-Supervisors {
    if (-not (Test-Path $stateFile)) { return @() }
    Get-Content $stateFile |
        Where-Object { $_ -match '^\d+$' } |
        ForEach-Object { Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue } |
        Where-Object { $_ }
}

function Stop-Forwards {
    # Stop supervisors before their children, or each loop restarts the kubectl we just killed.
    $supervisors = Get-Supervisors
    foreach ($s in $supervisors) {
        try { Stop-Process -Id $s.Id -Force -ErrorAction Stop } catch { }
    }

    # pkill does not exist here, and an orphaned forward keeps its socket bound while answering
    # nothing — which reads as a live forward and fakes test failures. Match on the exact
    # "local:remote" mapping so unrelated forwards on other ports are left alone.
    foreach ($f in $forwards) {
        Get-CimInstance Win32_Process -Filter "Name='kubectl.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like "*port-forward*svc/$($f.svc)*$($f.local):$($f.remote)*" } |
            ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { } }
    }

    Remove-Item $stateFile -ErrorAction SilentlyContinue
    Write-Output "stopped $($supervisors.Count) supervisor(s) and their forwards"
}

function Show-Status {
    foreach ($f in $forwards) {
        $log = Get-LogPath $f
        $restarts = 0
        if (Test-Path $log) {
            $restarts = @(Get-Content $log | Where-Object { $_ -match 'restarting' }).Count
        }
        [pscustomobject]@{
            Service  = $f.svc
            Port     = $f.local
            Up       = (Test-Port $f.local)
            Restarts = $restarts
        }
    }
}

if ($Stop)   { Stop-Forwards; return }
if ($Status) { Show-Status | Format-Table -AutoSize; return }

if ((Get-Supervisors).Count -gt 0) {
    Write-Output "forwards are already supervised; run with -Stop first to restart them"
    Show-Status | Format-Table -AutoSize
    return
}

Stop-Forwards | Out-Null
Remove-Item $logDir -Recurse -ErrorAction SilentlyContinue
$null = New-Item -ItemType Directory -Path $logDir -Force

# Relaunch the same PowerShell host the caller is using, so this works under both pwsh and
# Windows PowerShell without assuming either is on PATH.
$hostExe = (Get-Process -Id $PID).Path

# The loop goes in a file rather than a -Command string: a multi-line command passed through
# Start-Process -ArgumentList loses its newlines and quoting, and the child exits before it ever
# reaches kubectl — silently, because there is no console attached to complain to.
$loopScript = Join-Path ([IO.Path]::GetTempPath()) "skp-forward-loop.ps1"
@'
param([string]$Namespace, [string]$Service, [int]$Local, [int]$Remote, [string]$LogFile)
$ErrorActionPreference = "SilentlyContinue"
while ($true) {
    kubectl -n $Namespace port-forward "svc/$Service" "$($Local):$Remote" *>&1 |
        Out-File -FilePath $LogFile -Append -Encoding utf8
    "$([DateTimeOffset]::Now.ToString('o')) restarting $Service $Local -> $Remote" |
        Out-File -FilePath $LogFile -Append -Encoding utf8
    Start-Sleep -Milliseconds 200
}
'@ | Set-Content -Path $loopScript -Encoding utf8

$ids = [Collections.Generic.List[int]]::new()
foreach ($f in $forwards) {
    $p = Start-Process -FilePath $hostExe -PassThru -WindowStyle Hidden -ArgumentList @(
        "-NoProfile", "-NonInteractive", "-File", $loopScript,
        "-Namespace", $ns, "-Service", $f.svc,
        "-Local", $f.local, "-Remote", $f.remote, "-LogFile", (Get-LogPath $f)
    )
    $ids.Add($p.Id)
    Write-Output "supervising $($f.svc) $($f.local) -> $($f.remote)"
}

$ids | Set-Content $stateFile

# Report readiness rather than assume it: a forward that has not bound yet, or that lost its race
# for an already-held port, is indistinguishable from a working one until something connects.
$deadline = [datetime]::UtcNow.AddSeconds(30)
do {
    $down = @($forwards | Where-Object { -not (Test-Port $_.local) })
    if ($down.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
} while ([datetime]::UtcNow -lt $deadline)

Write-Output ""
if ($down.Count -eq 0) {
    Write-Output "all $($forwards.Count) forwards are up and supervised"
} else {
    Write-Warning "still down after 30s: $(($down | ForEach-Object { "$($_.svc):$($_.local)" }) -join ', ')"
    Write-Warning "check that the pods are running: kubectl get pods -n $ns"
}

Write-Output "restart logs: $logDir"
Write-Output "stop with:   ./k8s/port-forward-realstack.ps1 -Stop"
