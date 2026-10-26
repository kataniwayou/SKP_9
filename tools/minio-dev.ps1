<#
.SYNOPSIS
Stands up the MinIO that ObjectFetcher reads from, and ObjectPersister writes to, in a live run.

.DESCRIPTION
S3 is ORG INFRASTRUCTURE in production -- AWS, owned by someone else, never stood up by anything in
k8s/. This script gives a developer something that speaks the same API locally, and keeps the shape
tools/kafka-dev-broker.ps1 set for the broker: a plain Docker container on the `kind` network, NOT
in the skp namespace, nothing in k8s/ standing it up. Its internal address appears in k8s/, in each
object processor's S3__ServiceUrl -- the one line that goes away when AWS replaces this.

    INTERNAL  http://skp-minio:9000   what a pod uses -- pod DNS resolves the container name
    EXTERNAL  http://localhost:19000  what the host uses (mc, the live tests) -- offset from 9000 by
                                      the same convention as Kafka's 19092
    CONSOLE   http://localhost:19001  the web console, root user

THE IMAGE IS BUILT HERE, FROM SOURCE (tools/minio/Dockerfile): MinIO no longer publishes community
images. -Up builds skp-minio:local when it is missing.

THE CREDENTIALS ARE PLAIN VALUES, BY DECISION (2026-10-26: no Kubernetes Secret). They guard a
throwaway container on a laptop and nothing else, and in AWS the processors have no static keys at
all -- their credentials come from the pod's IAM role. They are written here and in the two
manifests, and nowhere else.

ONE USER PER PROCESSOR, NOT THE ROOT USER, so a local run exercises the permission split the IAM
roles will have: objectfetcher may only read skp-in (GetObject, plus ListBucket so a missing object
is a 404 rather than a 403); objectpersister may only write skp-out. A processor pointed at the wrong
bucket fails 403 here exactly as it would in AWS.

THE PROCESSORS NEVER CREATE A BUCKET, so -Up creates both. Every step of the setup is idempotent:
-Up on a running container re-applies buckets, policies and users and changes nothing else.

Storage is a named volume (skp-minio-data), unlike Kafka's container layer: seeded objects survive
-Down/-Up so a live test's fixtures need not be re-seeded. -Reset destroys the volume too.

.PARAMETER Up
Build the image if needed, start the container, create the buckets, users and policies.

.PARAMETER Down
Remove the container. Keeps the data volume.

.PARAMETER Status
Report the container, the buckets and their object counts, and the users.

.PARAMETER Reset
Remove the container AND the data volume, then Up -- empty buckets.

.EXAMPLE
./tools/minio-dev.ps1 -Up
docker exec skp-minio mc ls local/skp-in
#>
[CmdletBinding(DefaultParameterSetName = 'Up')]
param(
    [Parameter(ParameterSetName = 'Up')][switch]$Up,
    [Parameter(ParameterSetName = 'Down')][switch]$Down,
    [Parameter(ParameterSetName = 'Status')][switch]$Status,
    [Parameter(ParameterSetName = 'Reset')][switch]$Reset,
    [string]$Name = 'skp-minio',
    [string]$Image = 'skp-minio:local'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$volume = 'skp-minio-data'

# Plain values, by decision -- see the description.
$rootUser = 'skp-minio-root'
$rootPassword = 'skp-minio-root-dev'
$users = @(
    @{ Name = 'objectfetcher';   Key = 'objectfetcher-dev-key';   Policy = 'skp-objectfetcher';
       Statement = @{ Effect = 'Allow'; Action = @('s3:GetObject', 's3:ListBucket');
                      Resource = @('arn:aws:s3:::skp-in', 'arn:aws:s3:::skp-in/*') } },
    @{ Name = 'objectpersister'; Key = 'objectpersister-dev-key'; Policy = 'skp-objectpersister';
       Statement = @{ Effect = 'Allow'; Action = @('s3:PutObject');
                      Resource = @('arn:aws:s3:::skp-out/*') } }
)
$buckets = @('skp-in', 'skp-out')

function Test-Container {
    return [bool](docker ps -a --filter "name=^/$Name$" --format '{{.Names}}')
}

function Invoke-Mc {
    param([string[]]$McArgs)
    docker exec $Name mc @McArgs
    if ($LASTEXITCODE -ne 0) { throw "mc $($McArgs -join ' ') failed" }
}

function Start-Minio {
    if (-not (docker image ls -q $Image)) {
        Write-Host "building $Image from source (tools/minio/Dockerfile) -- a few minutes the first time"
        docker build -t $Image (Join-Path $repo 'tools/minio')
        if ($LASTEXITCODE -ne 0) { throw "building $Image failed" }
    }

    if (Test-Container) {
        if ((docker inspect $Name --format '{{.State.Status}}') -ne 'running') { docker start $Name | Out-Null }
        Write-Host "$Name already exists; re-applying buckets and users"
    }
    else {
        docker run -d --name $Name --network kind -p 19000:9000 -p 19001:9001 `
            -v "${volume}:/data" `
            -e "MINIO_ROOT_USER=$rootUser" -e "MINIO_ROOT_PASSWORD=$rootPassword" `
            $Image | Out-Null
    }

    # The server answers its health endpoint only once it can serve requests; poll it, never sleep.
    $deadline = (Get-Date).AddSeconds(60)
    do {
        docker exec $Name curl -sf http://localhost:9000/minio/health/ready 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    if ($LASTEXITCODE -ne 0) { throw "$Name did not become ready in 60s; see: docker logs $Name" }

    Invoke-Mc @('alias', 'set', 'local', 'http://localhost:9000', $rootUser, $rootPassword)
    foreach ($b in $buckets) { Invoke-Mc @('mb', '--ignore-existing', "local/$b") }

    foreach ($u in $users) {
        # The policy document travels through a file inside the container: mc reads a path, and
        # passing JSON through docker exec's argument list from pwsh mangles its quotes.
        $doc = @{ Version = '2012-10-17'; Statement = @($u.Statement) } | ConvertTo-Json -Depth 6 -Compress
        $doc | docker exec -i $Name sh -c "cat > /tmp/$($u.Policy).json"
        # create fails on an existing name, so the policy is removed and re-created: re-applying a
        # changed document is the point of running -Up again.
        docker exec $Name mc admin policy rm local $u.Policy 2>$null | Out-Null
        Invoke-Mc @('admin', 'policy', 'create', 'local', $u.Policy, "/tmp/$($u.Policy).json")
        Invoke-Mc @('admin', 'user', 'add', 'local', $u.Name, $u.Key)
        docker exec $Name mc admin policy attach local $u.Policy --user $u.Name 2>$null | Out-Null
    }

    Write-Host "$Name up. host: http://localhost:19000  in-cluster: http://${Name}:9000  console: http://localhost:19001"
    Write-Host "buckets: $($buckets -join ', ')   users: $(($users | ForEach-Object { $_.Name }) -join ', ')"
}

function Stop-Minio {
    if (Test-Container) { docker rm -f $Name | Out-Null; Write-Host "$Name removed (volume $volume kept)" }
    else { Write-Host "$Name is not there" }
}

function Show-Status {
    if (-not (Test-Container)) { Write-Host "$Name is not there"; return }
    docker ps -a --filter "name=^/$Name$" --format '{{.Names}}  {{.Status}}  {{.Ports}}'
    docker exec $Name mc alias set local http://localhost:9000 $rootUser $rootPassword | Out-Null
    foreach ($b in $buckets) {
        $count = @(docker exec $Name mc ls --recursive "local/$b" 2>$null).Count
        Write-Host "$b : $count object(s)"
    }
    docker exec $Name mc admin user list local
}

switch ($PSCmdlet.ParameterSetName) {
    'Down' { Stop-Minio }
    'Status' { Show-Status }
    'Reset' { Stop-Minio; docker volume rm $volume 2>$null | Out-Null; Start-Minio }
    default { Start-Minio }
}
