<#
.SYNOPSIS
Stands up the single-node Kafka the KafkaImporter reads, and the KafkaExporter writes to, in a live run.

.DESCRIPTION
The broker is ORG INFRASTRUCTURE in production -- outside this cluster, owned by someone else,
never stood up by anything in k8s/. This script exists so a developer can have something that
behaves like it locally, and it deliberately keeps that shape: the container is NOT in the skp
namespace and nothing in k8s/ stands it up. Its INTERNAL address does appear in k8s/, in each
processor's Kafka__BrokerList, because an address is infrastructure rather than a workflow author's
choice -- that is the one line to repoint when the real org cluster replaces this. Topic, group and
counts still travel in the orchestrator's step payload.

THE TWO ADDRESSES ARE THE WHOLE DESIGN. A Kafka client connects once to bootstrap, is told which
address to use for the real work, and then talks to THAT. So a broker with one advertised listener
can only ever serve one side: advertise localhost and the pod inside kind fails, advertise the
container name and the host test fails. Both failures look like a hang rather than an error,
because the client connects successfully and only then discovers it cannot reach what it was told
about. Hence two named listeners:

    INTERNAL  skp-kafka:9092    what a pod uses -- the container is on the `kind` docker network
                               alongside the node, and pod DNS resolves the container name
    EXTERNAL  localhost:19092   what the host uses -- published, and offset from 9092 by the same
                               convention as every port-forward in k8s/port-forward-realstack.ps1

group.initial.rebalance.delay.ms is left at its 3s default ON PURPOSE. That delay is precisely the
window in which Consume returns null before a partition is assigned -- the behaviour §6 of the
design reasons about and the hermetic suite can only assume. Setting it to 0 for a faster test
would delete the thing the live test exists to observe.

Storage is the container's own layer. Down destroys the topic and every offset with it, which is
what you want between runs: a consumer group that has already read the topic reads nothing on the
next dispatch and reports Drained, which is correct and confusing.

.PARAMETER Up
Start the broker and create the topic.

.PARAMETER Down
Remove the container. Destroys all data.

.PARAMETER Status
Report the container, the topic, and the committed offsets of any consumer group.

.PARAMETER Reset
Down then Up -- an empty topic and no consumer groups.

.PARAMETER Partitions
Partition count for the topic. ONE unless you have also raised the processor's replica count and
read §6 first: the Drained reason means "the topic is empty" only at one partition and one replica.

.EXAMPLE
./tools/kafka-dev-broker.ps1 -Up
python tools/kafka-produce-records.py --count 12
#>
[CmdletBinding(DefaultParameterSetName = 'Up')]
param(
    [Parameter(ParameterSetName = 'Up')][switch]$Up,
    [Parameter(ParameterSetName = 'Down')][switch]$Down,
    [Parameter(ParameterSetName = 'Status')][switch]$Status,
    [Parameter(ParameterSetName = 'Reset')][switch]$Reset,
    [string]$Name = 'skp-kafka',
    [string]$Topic = 'skp-paths',
    [int]$Partitions = 1,
    [string]$Image = 'apache/kafka:3.9.1'
)

$ErrorActionPreference = 'Stop'

function Test-Container {
    $found = docker ps -a --filter "name=^/$Name$" --format '{{.Names}}'
    return [bool]$found
}

function Invoke-KafkaCli {
    param([string]$Script, [string[]]$CliArgs)
    # MSYS_NO_PATHCONV has no effect from pwsh, but docker exec with a leading-slash path is
    # mangled by Git Bash and not by PowerShell -- which is why this script is pwsh and the
    # equivalent one-liners in a bash session need the prefix.
    docker exec $Name "/opt/kafka/bin/$Script" @CliArgs
}

function Start-Broker {
    if (Test-Container) {
        Write-Host "$Name already exists; use -Reset for a clean one"
    }
    else {
        docker run -d --name $Name --network kind -p 19092:19092 `
            -e KAFKA_NODE_ID=1 `
            -e KAFKA_PROCESS_ROLES=broker,controller `
            -e KAFKA_LISTENERS=INTERNAL://:9092,EXTERNAL://:19092,CONTROLLER://:9093 `
            -e KAFKA_ADVERTISED_LISTENERS=INTERNAL://${Name}:9092,EXTERNAL://localhost:19092 `
            -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=INTERNAL:PLAINTEXT,EXTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT `
            -e KAFKA_INTER_BROKER_LISTENER_NAME=INTERNAL `
            -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER `
            -e KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093 `
            -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 `
            -e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1 `
            -e KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 `
            $Image | Out-Null
    }

    # The broker answers its port before it can serve metadata, so poll the API rather than sleep.
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        $probe = Invoke-KafkaCli 'kafka-topics.sh' @('--bootstrap-server', 'localhost:9092', '--list') 2>&1
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Milliseconds 500
    }
    if ($LASTEXITCODE -ne 0) { throw "broker did not become ready in 60s" }

    $existing = Invoke-KafkaCli 'kafka-topics.sh' @('--bootstrap-server', 'localhost:9092', '--list')
    if ($existing -notcontains $Topic) {
        Invoke-KafkaCli 'kafka-topics.sh' @(
            '--bootstrap-server', 'localhost:9092', '--create',
            '--topic', $Topic, '--partitions', "$Partitions", '--replication-factor', '1') | Out-Null
    }

    Write-Host "$Name up. host: localhost:19092   in-cluster: ${Name}:9092   topic: $Topic ($Partitions partition(s))"
}

function Stop-Broker {
    if (Test-Container) {
        docker rm -f $Name | Out-Null
        Write-Host "$Name removed (topic and all offsets destroyed)"
    }
    else {
        Write-Host "$Name is not there"
    }
}

function Show-Status {
    if (-not (Test-Container)) { Write-Host "$Name is not there"; return }
    docker ps -a --filter "name=^/$Name$" --format '{{.Names}}  {{.Status}}'
    Invoke-KafkaCli 'kafka-topics.sh' @('--bootstrap-server', 'localhost:9092', '--describe', '--topic', $Topic)
    $groups = Invoke-KafkaCli 'kafka-consumer-groups.sh' @('--bootstrap-server', 'localhost:9092', '--list')
    foreach ($group in $groups) {
        if ($group) {
            Invoke-KafkaCli 'kafka-consumer-groups.sh' @(
                '--bootstrap-server', 'localhost:9092', '--describe', '--group', $group)
        }
    }
}

switch ($PSCmdlet.ParameterSetName) {
    'Down' { Stop-Broker }
    'Status' { Show-Status }
    'Reset' { Stop-Broker; Start-Broker }
    default { Start-Broker }
}
