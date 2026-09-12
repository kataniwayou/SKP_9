#!/usr/bin/env python3
"""Pulls one lineage out of Elasticsearch and prints it in dispatch order.

WHY NOT grep THE POD LOGS. A verdict in this suite is "which component refused this, and did the
chain stop there" -- that is a claim about SEVEN services, and a pod log can only answer for one.
ES carries ExecutionId on every line from the importer onwards, so the lineage is a single query.

SCOPED BY ExecutionId, and by WorkflowId for the pre-lineage window. The entry step's dispatch
("running the step") is logged BEFORE the importer has opened a lineage, so it carries no
ExecutionId -- asking only for the execution loses the dispatch that started it. Both halves are
fetched and merged.

Health probes are excluded. They are ~58k/day and carry no lineage.
"""
import json, sys, datetime, urllib.request

ES = "http://localhost:19200/logs-generic.otel-default/_search"
PROBE = "BaseConsole.Core.Health.HealthProbeLog"

def search(body):
    req = urllib.request.Request(ES, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)["hits"]["hits"]

def rows(execution=None, workflow=None, since="now-30m", size=200):
    must = []
    if execution: must.append({"term": {"attributes.ExecutionId": execution}})
    if workflow:  must.append({"term": {"attributes.WorkflowId": workflow}})
    hits = search({
        "size": size, "sort": [{"@timestamp": "asc"}],
        "query": {"bool": {"filter": must + [{"range": {"@timestamp": {"gte": since}}}],
                            "must_not": [{"term": {"scope.name": PROBE}}]}}})
    return hits

def show(hits, attrs=()):
    for h in hits:
        s = h["_source"]; a = s.get("attributes", {})
        ts = datetime.datetime.utcfromtimestamp(float(s["@timestamp"]) / 1000)
        sev = s.get("severity_text", "?")
        mark = "!!" if sev in ("Warning", "Error", "Critical") else "  "
        print(f"{mark} {ts.strftime('%H:%M:%S.%f')[:12]} {sev[:4]:<4} "
              f"{s['resource']['attributes']['service.name']:<17} "
              f"{s['scope']['name'].split('.')[-1][:22]:<22} {s['body']['text'][:110]}")
        extra = {k: a[k] for k in attrs if k in a}
        if extra:
            print(f"        {json.dumps(extra)}")

if __name__ == "__main__":
    kind, value = sys.argv[1], sys.argv[2]
    since = sys.argv[3] if len(sys.argv) > 3 else "now-30m"
    keys = ("MaxDepth", "DepthReached", "EntryCount", "Handler", "ItemCount", "ConvertedCount",
            "FileName", "SizeBytes", "Reason", "Consumed", "Errors", "SchemaId", "Result")
    show(rows(execution=value if kind == "exec" else None,
              workflow=value if kind == "wf" else None, since=since), keys)
