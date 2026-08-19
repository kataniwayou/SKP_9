# Opens the forwards the RealStack tests expect. Every local port is offset from its in-cluster
# number so a forward can never be mistaken for, or collide with, a local service.
#
# Usage:  ./k8s/port-forward-realstack.ps1
#         $env:SKP_REALSTACK = "1"
#         dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj
$ns = "skp"
$forwards = @(
    @{ svc = "rabbitmq";       local = 5673;  remote = 5672 },
    @{ svc = "baseapi-service";local = 18080; remote = 8080 },
    @{ svc = "otel-collector"; local = 14317; remote = 4317 },
    @{ svc = "otel-collector"; local = 18889; remote = 8889 },
    @{ svc = "redis";          local = 6380;  remote = 6379 }
)

foreach ($f in $forwards) {
    Start-Process -NoNewWindow -FilePath "kubectl" -ArgumentList @(
        "-n", $ns, "port-forward", "svc/$($f.svc)", "$($f.local):$($f.remote)"
    )
    Write-Output "forwarding $($f.svc) $($f.local) -> $($f.remote)"
}

Write-Output ""
Write-Output "Forwards die when their pod restarts. If live tests start failing, check these first."
