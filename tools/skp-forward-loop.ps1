param([string]$Namespace, [string]$Service, [int]$Local, [int]$Remote, [string]$LogFile)
$ErrorActionPreference = "SilentlyContinue"
while ($true) {
    kubectl -n $Namespace port-forward "svc/$Service" "$($Local):$Remote" *>&1 |
        Out-File -FilePath $LogFile -Append -Encoding utf8
    "$([DateTimeOffset]::Now.ToString('o')) restarting $Service $Local -> $Remote" |
        Out-File -FilePath $LogFile -Append -Encoding utf8
    Start-Sleep -Milliseconds 200
}
