<#
.SYNOPSIS
Puts every processor's schema edges back to what they were before the schema-compatibility suite ran.

.DESCRIPTION
WRITTEN BEFORE THE FIRST MUTATION, ON PURPOSE. The suite re-points inputSchemaId/outputSchemaId on
SHARED processor rows -- there is no per-workflow schema edge and no second processor row to mutate
instead (uq_processor_source_hash forbids one), so every schema-side test is globally visible. If the
suite dies halfway, this script is the only thing that puts the cluster back.

The values below are a literal transcript of baseline-processors.json, captured before any change.
They are hard-coded rather than read from that file so this script keeps working if the file moves.

The PUT requires every field: a partial body wipes name, version and the other schema ids. Each row
is therefore GET-then-resend with only the two edges overridden.
#>
$ErrorActionPreference = "Stop"
$api = "http://localhost:18080/api/v1/processors"

$baseline = @(
  @{ id="9d0fb8a6-1d57-4a2b-9394-cf0a9568c48a"; name="kafka-importer";    in=$null; out="b3877a36-ba2f-4893-8b46-f91413b12384" }
  @{ id="4ad0d5d7-3a5c-4150-b543-b3bf7e944727"; name="archive-expander";  in="f495b02e-f7f1-4899-b5a8-5c2a00d43fd7"; out="e33f8079-7c65-49de-9a1c-bcd1065e9044" }
  @{ id="76146a07-ee04-48de-a82a-5e21d98fb2d0"; name="archive-collapser"; in="e33f8079-7c65-49de-9a1c-bcd1065e9044"; out="f495b02e-f7f1-4899-b5a8-5c2a00d43fd7" }
  @{ id="c046fb57-6fa3-4227-8cb0-103e933652e3"; name="file-persister";    in="f495b02e-f7f1-4899-b5a8-5c2a00d43fd7"; out="b3877a36-ba2f-4893-8b46-f91413b12384" }
  @{ id="157a0f40-d668-42f3-a500-4762c587f64a"; name="kafka-exporter";    in="b3877a36-ba2f-4893-8b46-f91413b12384"; out=$null }
  @{ id="8f8344b1-caf6-4482-8710-a3249a238e3c"; name="file-fetcher";      in="b3877a36-ba2f-4893-8b46-f91413b12384"; out="f495b02e-f7f1-4899-b5a8-5c2a00d43fd7" }
  @{ id="1673b377-8237-4d41-b420-3099a27f7dbf"; name="sk-normalizer";     in="e33f8079-7c65-49de-9a1c-bcd1065e9044"; out="e33f8079-7c65-49de-9a1c-bcd1065e9044" }
)

foreach ($row in $baseline) {
    $cur = Invoke-RestMethod "$api/$($row.id)"
    $body = @{
        name           = $cur.name
        version        = $cur.version
        description    = $cur.description
        sourceHash     = $cur.sourceHash
        inputSchemaId  = $row.in
        outputSchemaId = $row.out
        configSchemaId = $cur.configSchemaId
    } | ConvertTo-Json
    $after = Invoke-RestMethod -Method Put "$api/$($row.id)" -ContentType application/json -Body $body
    $ok = ($after.inputSchemaId -eq $row.in) -and ($after.outputSchemaId -eq $row.out)
    "{0,-20} in={1} out={2}  {3}" -f $row.name, $after.inputSchemaId, $after.outputSchemaId, $(if ($ok) { "RESTORED" } else { "MISMATCH" })
}
