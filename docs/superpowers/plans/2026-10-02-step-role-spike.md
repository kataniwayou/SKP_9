# Step-role spike: Lens pie over ES|QL, two rings (2026-10-02)

Method: the real `kibana/kibana-export.ndjson` was copied; in the copy the funnel panel
(`skp-runposition-pie`, both the lens `state.query.esql` and the textBased layer query) was replaced
by the RunPosition stand-in, ending in `RENAME role AS attributes.StepRole, step AS attributes.StepName`
so the output columns equal the real panel's (`outcomes`, `attributes.StepRole`, `attributes.StepName`).
The dashboard's query bar and pill filter were widened in the copy with `NextStepId`/`RunPosition`
exists so the stand-in rows are not excluded (the real filter only admits `StepRole`).
Whole export imported into space `steprole-spike`, dashboard opened over 2026-10-01 19:08-19:23 UTC.
Space deleted afterwards (HTTP 204). Repo export untouched.

## Result 1: two rings: YES

The unchanged real visualization (`lnsPie`, `shape: pie`, `primaryGroups: [role, step]`, nested legend)
draws two rings on Kibana 9.3.4: inner ring 3 slices (intermediate 746, terminal 54, entry 15),
outer ring 10 slices (one per step; entry ab9d..., terminal eb70..., eight intermediates).
Colors follow the role assignments. Decision for Task 6: **two-ring pie, no treemap fallback needed.**
Screenshot: `2026-10-02-step-role-spike-two-rings.png`.

## Result 2: c1 (Workflow control) reaches the funnel: YES

Request bodies of the panel's `esql_async` call (Playwright network log):
- c1 = Any: no WorkflowName clause; funnel full (screenshot above).
- c1 = analyst-monitor: the body gains `{"match_phrase":{"attributes.WorkflowName":"analyst-monitor_1.0.0-9aff-a7f22ee09224"}}`
  and the funnel shows "No results found" (the stand-in hardcodes another WorkflowId). Screenshot:
  `2026-10-02-step-role-spike-c1-analyst.png`.
- c1 = filefetcher-archiveexpander-chain: control filter applied as well (with only entry rows passing
  my first, too-narrow pill filter the funnel showed just entry 15, again proving filters are applied).

Also observed: the dashboard's pill filter AND query-bar kuery are both sent to the ES|QL panel as
`filter`, so any dashboard-level filter that excludes entry records empties the funnel (INLINE STATS
needs the entry row). The real dashboard filter admits `StepRole:*` (entry included), so it is fine.

## Notes
- Hash-only navigation does not reload a stale dashboard state in the same session; reload for a re-import.
- The playwright MCP can only write screenshots under the repo root.
