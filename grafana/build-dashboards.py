#!/usr/bin/env python3
"""Generate the four SKP Grafana dashboards as portable JSON.

Portable means: no hardcoded datasource uid, no folder assumption, no provisioning
required. Every panel resolves its datasource through the `${datasource}` template
variable, so the same file imports into any Grafana that has a Prometheus datasource
-- this cluster's, or one on another machine. The uid is explicit and stable so a
re-import updates the board in place instead of creating a duplicate.

The orchestrator and processor share eight instruments by design (see
docs/superpowers/specs/2026-08-22-pipeline-metrics-design.md section 2). Their common
panels are emitted from one function here rather than copied between two JSON files,
so the two boards cannot drift without the drift being visible in this source.

    python grafana/build-dashboards.py

Writes grafana/dashboards/*.json. Import them through Dashboards > New > Import.
"""

import json
import pathlib

OUT = pathlib.Path(__file__).parent / "dashboards"

# ---------------------------------------------------------------------------
# panel construction
# ---------------------------------------------------------------------------

DS = {"type": "prometheus", "uid": "${datasource}"}

# Panel descriptions render as markdown, so a blank line is a paragraph break.
PARA = chr(10) + chr(10)

# Threshold sets. Grafana reads steps in ascending order; the first has value null.
T_FAULT = [{"color": "green", "value": None}, {"color": "red", "value": 0.0001}]
T_POSTURE = [{"color": "red", "value": None}, {"color": "green", "value": 1}]
T_EXACTLY_ONE = [{"color": "red", "value": None},
                 {"color": "green", "value": 1},
                 {"color": "red", "value": 2}]
T_NEUTRAL = [{"color": "text", "value": None}]
T_WARN = [{"color": "green", "value": None}, {"color": "orange", "value": 1}]


class Layout:
    """Assigns gridPos left-to-right, wrapping at the 24-column grid."""

    def __init__(self):
        self.x = 0
        self.y = 0
        self.row_h = 0

    def place(self, w, h):
        if self.x + w > 24:
            self.x = 0
            self.y += self.row_h
            self.row_h = 0
        pos = {"h": h, "w": w, "x": self.x, "y": self.y}
        self.x += w
        self.row_h = max(self.row_h, h)
        return pos

    def newline(self):
        if self.x:
            self.x = 0
            self.y += self.row_h
            self.row_h = 0


_uid_counter = [0]


def _next_id():
    _uid_counter[0] += 1
    return _uid_counter[0]


def targets(exprs):
    out = []
    for i, e in enumerate(exprs):
        expr, legend = e if isinstance(e, tuple) else (e, "")
        out.append({
            "refId": chr(ord("A") + i),
            "datasource": DS,
            "expr": expr,
            "legendFormat": legend,
            "range": True,
            "editorMode": "code",
        })
    return out


def stat(layout, title, exprs, desc="", thresholds=T_FAULT, unit="short",
         decimals=None, w=3, h=4, text_mode="auto"):
    return {
        "id": _next_id(),
        "type": "stat",
        "title": title,
        "description": desc,
        "datasource": DS,
        "gridPos": layout.place(w, h),
        "targets": targets(exprs),
        "options": {
            "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
            "orientation": "auto",
            "textMode": text_mode,
            "colorMode": "value",
            "graphMode": "area",
            "justifyMode": "auto",
        },
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "decimals": decimals,
                "mappings": [],
                "color": {"mode": "thresholds"},
                "thresholds": {"mode": "absolute", "steps": thresholds},
            },
            "overrides": [],
        },
    }


def timeseries(layout, title, exprs, desc="", unit="short", w=8, h=8,
               stack=False, fill=8, legend_mode="list", legend_pos="bottom",
               minv=None, maxv=None, thresholds=None, draw_style="line",
               decimals=None, no_value=None):
    custom = {
        "drawStyle": draw_style,
        "lineWidth": 1,
        "fillOpacity": fill,
        "gradientMode": "opacity",
        "spanNulls": False,
        "showPoints": "never",
        "pointSize": 4,
        "axisPlacement": "auto",
        "axisLabel": "",
        "scaleDistribution": {"type": "linear"},
        "stacking": {"mode": "normal" if stack else "none", "group": "A"},
        "hideFrom": {"legend": False, "tooltip": False, "viz": False},
        "thresholdsStyle": {"mode": "line" if thresholds else "off"},
    }
    defaults = {
        "unit": unit,
        "decimals": decimals,
        "custom": custom,
        "mappings": [],
        "color": {"mode": "palette-classic"},
        "thresholds": {"mode": "absolute",
                       "steps": thresholds or [{"color": "green", "value": None}]},
    }
    if minv is not None:
        defaults["min"] = minv
    if maxv is not None:
        defaults["max"] = maxv
    # A breakdown-by-label panel cannot use `or vector(0)` -- the fallback would draw an
    # unlabelled series that means nothing. noValue is the equivalent for those: the
    # panel states that nothing matched because nothing is wrong, instead of rendering
    # the same blank a broken query renders.
    if no_value is not None:
        defaults["noValue"] = no_value
    return {
        "id": _next_id(),
        "type": "timeseries",
        "title": title,
        "description": desc,
        "datasource": DS,
        "gridPos": layout.place(w, h),
        "targets": targets(exprs),
        "options": {
            "legend": {"displayMode": legend_mode, "placement": legend_pos,
                       "showLegend": True, "calcs": []},
            "tooltip": {"mode": "multi", "sort": "desc"},
        },
        "fieldConfig": {"defaults": defaults, "overrides": []},
    }


def table(layout, title, exprs, desc="", w=8, h=8):
    return {
        "id": _next_id(),
        "type": "table",
        "title": title,
        "description": desc,
        "datasource": DS,
        "gridPos": layout.place(w, h),
        "targets": [dict(t, format="table", instant=True, range=False)
                    for t in targets(exprs)],
        "transformations": [{"id": "merge", "options": {}}],
        "options": {"showHeader": True, "footer": {"show": False, "reducer": ["sum"]}},
        "fieldConfig": {
            "defaults": {
                "custom": {"align": "auto", "cellOptions": {"type": "auto"},
                           "inspect": False},
                "mappings": [],
                "thresholds": {"mode": "absolute", "steps": T_NEUTRAL},
            },
            "overrides": [],
        },
    }


def textpanel(layout, title, content, w=8, h=8):
    return {
        "id": _next_id(),
        "type": "text",
        "title": title,
        "gridPos": layout.place(w, h),
        "options": {"mode": "markdown", "content": content},
        "transparent": False,
    }


def row(layout, title, collapsed=False):
    """A row header.

    Children of a COLLAPSED row are stored inside the row rather than at top level, and
    they must still carry absolute y positions continuing below the header -- that is
    what the Grafana UI writes when a human collapses a row, and it is the shape expand
    is best tested against. So build the header first (which advances the layout past
    it), then build the children with the SAME layout:

        r = row(lay, "Runtime", collapsed=True)
        r["panels"] = runtime_row(lay, f)

    Building children off a fresh Layout() instead gives every one of them y=0 while the
    header sits at y=38, which is a position no dashboard Grafana wrote would contain.
    """
    layout.newline()
    pos = {"h": 1, "w": 24, "x": 0, "y": layout.y}
    layout.y += 1
    return {
        "id": _next_id(),
        "type": "row",
        "title": title,
        "collapsed": collapsed,
        "gridPos": pos,
        "panels": [],
    }


# ---------------------------------------------------------------------------
# template variables
# ---------------------------------------------------------------------------

def var_datasource():
    return {
        "name": "datasource",
        "label": "Data source",
        "type": "datasource",
        "query": "prometheus",
        "refresh": 1,
        "hide": 0,
        "current": {},
        "options": [],
    }


def var_query(name, label, query, multi=True, all_=True, hide=0, all_value=".*"):
    return {
        "name": name,
        "label": label,
        "type": "query",
        "datasource": DS,
        "definition": query,
        "query": {"qryType": 1, "query": query, "refId": f"var-{name}"},
        "refresh": 2,          # on time-range change, so a rolled pod appears
        "sort": 1,
        "multi": multi,
        "includeAll": all_,
        # allValue ".*" is the convenient default, but it is WRONG for any variable whose
        # job is to scope the board to a subset of services: ".*" matches every service in
        # the deployment, not every value this variable enumerates. Pass all_value=None to
        # make Grafana expand All to the actual option list -- (a|b|c) -- instead.
        "allValue": all_value,
        "hide": hide,
        "current": {"selected": True, "text": ["All"], "value": ["$__all"]} if all_ else {},
        "options": [],
    }


def var_constant(name, value):
    return {"name": name, "type": "constant", "query": value,
            "current": {"text": value, "value": value}, "hide": 2, "skipUrlSync": False}


def var_custom(name, label, values, desc=""):
    return {
        "name": name,
        "label": label,
        "description": desc,
        "type": "custom",
        "query": ",".join(values),
        "multi": True,
        "includeAll": True,
        "allValue": ".*",
        "hide": 0,
        "current": {"selected": True, "text": ["All"], "value": ["$__all"]},
        "options": [{"selected": False, "text": v, "value": v} for v in values],
    }


# ---------------------------------------------------------------------------
# dashboard envelope
# ---------------------------------------------------------------------------

def dashboard(uid, title, description, variables, panels, links, tags):
    return {
        # null id + explicit uid: the import UI treats this as "create, or update the
        # board already holding this uid". Re-importing never duplicates.
        "id": None,
        "uid": uid,
        "title": title,
        "description": description,
        "tags": tags,
        "timezone": "browser",
        "editable": True,
        "graphTooltip": 1,          # shared crosshair across panels
        "schemaVersion": 39,
        "version": 0,
        "refresh": "30s",
        "time": {"from": "now-1h", "to": "now"},
        "timepicker": {},
        "links": links,
        "templating": {"list": variables},
        "annotations": {"list": []},
        "panels": panels,
    }


def link(title, uid_tag):
    """Dashboard-level link that carries the time range and variables across."""
    return {
        "title": title,
        "type": "dashboards",
        "tags": [uid_tag],
        "asDropdown": False,
        "includeVars": True,
        "keepTime": True,
        "targetBlank": False,
        "icon": "external link",
        "tooltip": "",
        "url": "",
    }


NAV = [link("SKP boards", "skp")]


# ---------------------------------------------------------------------------
# shared panel sets
# ---------------------------------------------------------------------------

# Filter applied to every worker panel. service_name is a hidden constant on the
# orchestrator board and a real multi-select on the processor board; the expression
# text is identical either way.
WORKER_F = ('service_name=~"$service_name",service_version=~"$service_version",'
            'service_instance_id=~"$service_instance_id"')


def verdict_shared(layout, f):
    """The six verdict stats both worker roles carry.

    Deliberately NOT filtered by $role even on the orchestrator: this tier answers
    "is anything wrong anywhere", and a role filter here would let a follower fault
    hide behind a leader selection.
    """
    return [
        stat(layout, "Consuming",
             [f'min(pipeline_consumer_consuming_ratio{{{f}}}) or vector(0)'],
             desc="0 means no consumer tag on at least one queue -- nothing is "
                  "listening. No other signal answers this.",
             thresholds=T_POSTURE, decimals=0),
        stat(layout, "L2 gate",
             [f'min(pipeline_gate_open_ratio{{{f}}}) or vector(0)'],
             desc="The single best answer to 'why did the pipeline stop'. 0 means "
                  "the gate is shut and deliveries are being requeued.",
             thresholds=T_POSTURE, decimals=0),
        stat(layout, "Not acked",
             [f'sum(rate(pipeline_messages_consumed_total{{{f},'
              f'disposition=~"requeued|parked"}}[$__rate_interval])) or vector(0)'],
             desc="Deliveries the consumer refused or sent back. Drill into "
                  "'reason' on the pipeline tier for why.",
             unit="reqps", decimals=2),
        stat(layout, "Ack lost",
             [f'sum(rate(pipeline_messages_consumed_total{{{f},'
              f'disposition="acked",landed="false"}}[$__rate_interval])) or vector(0)'],
             desc="The silent case: the handler ran to completion but the broker "
                  "never heard the ack, so it will redeliver. Cause is on the "
                  "channel-resets panel.",
             unit="reqps", decimals=2),
        stat(layout, "Egress faults",
             [f'sum(rate(pipeline_messages_produced_total{{{f},'
              f'outcome=~"transient|unroutable|refused"}}[$__rate_interval])) or vector(0)'],
             desc="unroutable = the queue is not declared. transient = the broker "
                  "is unreachable. Opposite remedies; this is the only signal that "
                  "separates them.",
             unit="reqps", decimals=2),
        stat(layout, "Channel resets",
             [f'sum(increase(pipeline_consumer_channel_resets_total{{{f}}}[$__range])) '
              f'or vector(0)'],
             desc="Channel churn over the visible range. The cause of ack loss.",
             thresholds=T_WARN, decimals=0),
    ]


def pipeline_shared(layout, f, role_f=""):
    """The six pipeline panels both worker roles carry.

    role_f is appended only on the orchestrator, where pipeline.messages.* and
    pipeline.produce.duration carry a `role` attribute. The processor emits no such
    attribute, so passing it there would match nothing.
    """
    rf = role_f
    return [
        timeseries(layout, "Produced by type and outcome",
                   [(f'sum by (type,outcome) (rate(pipeline_messages_produced_total'
                     f'{{{f}{rf}}}[$__rate_interval]))', "{{type}} / {{outcome}}")],
                   desc="Egress. outcome != accepted is a fault.",
                   unit="reqps"),
        timeseries(layout, "Consumed by type and disposition",
                   [(f'sum by (type,disposition) (rate(pipeline_messages_consumed_total'
                     f'{{{f}{rf}}}[$__rate_interval]))', "{{type}} / {{disposition}}")],
                   desc="Ingress. Exactly one increment per delivery, on every exit "
                        "path of the consumer.",
                   unit="reqps"),
        timeseries(layout, "Produce duration (mean)",
                   [(f'sum by (destination) (rate(pipeline_produce_duration_seconds_sum'
                     f'{{{f}{rf}}}[$__rate_interval])) '
                     f'/ sum by (destination) (rate(pipeline_produce_duration_seconds_count'
                     f'{{{f}{rf}}}[$__rate_interval]))', "{{destination}}")],
                   desc="A real broker round-trip to publisher confirmation, not the "
                        "time to write a frame." + PARA + "MEAN, NOT p95 -- and that is a "
                        "workaround. The instrument records seconds but declares no "
                        "bucket boundaries, so it inherits the .NET SDK defaults "
                        "([0, 5, 10, 25 ... 10000]) which are tuned for milliseconds. "
                        "Every observation lands in the first (0,5] bucket, so "
                        "histogram_quantile interpolates across it and returns ~4.9s "
                        "for a send that really takes ~20ms. sum/count is exact and "
                        "unaffected. Restore the quantiles once the meter provider "
                        "carries an ExplicitBucketHistogramConfiguration view.",
                   unit="s"),
        timeseries(layout, "Consumer inflight by queue",
                   [(f'max by (queue) (pipeline_consumer_inflight{{{f}}})', "{{queue}}")],
                   desc="Deliveries inside a handler. PrefetchCount is 1, so a "
                        "sustained 1 is saturation -- the threshold line marks it.",
                   thresholds=[{"color": "green", "value": None},
                               {"color": "orange", "value": 1}],
                   minv=0, decimals=0),
        timeseries(layout, "Channel resets by reason",
                   [(f'sum by (queue,reason) (rate(pipeline_consumer_channel_resets_total'
                     f'{{{f}}}[$__rate_interval]))', "{{queue}} / {{reason}}")],
                   desc="shutdown, recovered, reopened. Each renumbers delivery tags "
                        "and is what makes landed=false possible.",
                   unit="reqps",
                   no_value="no channel churn in range"),
        timeseries(layout, "Consuming by queue",
                   [(f'min by (queue) (pipeline_consumer_consuming_ratio{{{f}}})',
                     "{{queue}}")],
                   desc="Per-queue view of the verdict stat. A queue reading 0 while "
                        "the others read 1 is one wedged consumer, not an outage.",
                   minv=0, maxv=1, decimals=0, fill=20, draw_style="line"),
    ]


def runtime_row(layout, f):
    """Four runtime panels, identical on all three source boards.

    Only the ones with a causal link to a pipeline symptom. Heap by generation,
    fragmentation, allocation rate, JIT, assemblies, timers and lock contention answer
    memory-and-perf questions instead, and stay on the SKP Runtime board.
    """
    return [
        timeseries(layout, "Thread-pool queue length",
                   [(f'max by (service_instance_id) '
                     f'(process_runtime_dotnet_thread_pool_queue_length{{{f}}})',
                     "{{service_instance_id}}")],
                   desc="Explains consumption stalling while the gate is open and the "
                        "consumer still reports consuming=1: callbacks are starved, "
                        "not blocked.",
                   w=6, h=7),
        timeseries(layout, "GC pause time",
                   [(f'sum by (service_instance_id) '
                     f'(rate(process_runtime_dotnet_gc_duration_nanoseconds_total'
                     f'{{{f}}}[$__rate_interval])) / 1e9',
                     "{{service_instance_id}}")],
                   desc="Seconds of GC pause per second. Explains duration p99 spikes "
                        "with no broker or dependency fault.",
                   unit="s", w=6, h=7),
        timeseries(layout, "Exception rate",
                   [(f'sum by (service_instance_id) '
                     f'(rate(process_runtime_dotnet_exceptions_count_total{{{f}}}'
                     f'[$__rate_interval]))', "{{service_instance_id}}")],
                   desc="Correlates with rising parked / refused dispositions and with "
                        "faulted process outcomes.",
                   unit="reqps", w=6, h=7),
        timeseries(layout, "Process restarts",
                   [(f'sum by (service_instance_id) '
                     f'(resets(process_runtime_dotnet_jit_methods_compiled_count_total'
                     f'{{{f}}}[$__rate_interval]))', "{{service_instance_id}}")],
                   desc="A monotonic counter going backwards means the process is new. "
                        "The one signal that explains a simultaneous gap in every "
                        "other series.",
                   w=6, h=7, decimals=0),
    ]


# ---------------------------------------------------------------------------
# board 1 -- flow
# ---------------------------------------------------------------------------

def build_flow():
    lay = Layout()
    panels = []

    panels.append(row(lay, "1 - Verdict: is the system broken?"))
    panels += [
        stat(lay, "System flowing",
             ['sum(rate(pipeline_messages_produced_total[$__rate_interval])) or vector(0)'],
             desc="Total egress across every worker. Zero during a run means the "
                  "pipeline has stopped, whatever else reads green.",
             thresholds=[{"color": "red", "value": None}, {"color": "green", "value": 0.0001}],
             unit="reqps", decimals=2),
        stat(lay, "Outbound hop gap",
             ['sum(rate(pipeline_messages_produced_total{type="process-dispatch",'
              'outcome="accepted"}[$__rate_interval])) '
              '- sum(rate(pipeline_messages_consumed_total{type="process-dispatch",'
              'disposition="acked"}[$__rate_interval])) or vector(0)'],
             desc="Dispatches the orchestrator confirmed, minus acks the processors "
                  "issued. Sustained positive means work is piling up between the two "
                  "services -- the signal neither service board can show.",
             thresholds=T_FAULT, unit="reqps", decimals=2),
        stat(lay, "Return hop gap",
             ['sum(rate(pipeline_messages_produced_total{type="step-outcome",'
              'outcome="accepted"}[$__rate_interval])) '
              '- sum(rate(pipeline_messages_consumed_total{type="step-outcome",'
              'disposition="acked"}[$__rate_interval])) or vector(0)'],
             desc="The same conservation check on the way back.",
             thresholds=T_FAULT, unit="reqps", decimals=2),
        stat(lay, "Retry amplification",
             ['(sum(rate(pipeline_messages_consumed_total{disposition=~"requeued|parked"}'
              '[$__rate_interval])) '
              '+ sum(rate(pipeline_messages_consumed_total{landed="false"}'
              '[$__rate_interval]))) '
              '/ sum(rate(pipeline_messages_consumed_total[$__rate_interval])) or vector(0)'],
             desc="Share of deliveries that will be redone. Healthy is exactly zero.",
             thresholds=T_FAULT, unit="percentunit", decimals=1),
        stat(lay, "Ack lost",
             ['sum(rate(pipeline_messages_consumed_total{disposition="acked",'
              'landed="false"}[$__rate_interval])) or vector(0)'],
             desc="Work completed that the broker will hand out again.",
             unit="reqps", decimals=2),
        stat(lay, "Egress faults",
             ['sum(rate(pipeline_messages_produced_total'
              '{outcome=~"transient|unroutable|refused"}[$__rate_interval])) or vector(0)'],
             desc="Any send that did not reach the broker, anywhere in the stack.",
             unit="reqps", decimals=2),
        stat(lay, "Consuming",
             ['min(pipeline_consumer_consuming_ratio) or vector(0)'],
             desc="Minimum across every queue in the deployment.",
             thresholds=T_POSTURE, decimals=0),
        stat(lay, "Workers reporting",
             ['count(count by (service_instance_id) (pipeline_gate_open_ratio)) or vector(0)'],
             desc="Expected: 3 orchestrator replicas + n processor replicas. A drop "
                  "here precedes every other symptom.",
             thresholds=T_NEUTRAL, decimals=0),
    ]

    panels.append(row(lay, "2 - Flow: where is it leaking?"))
    panels += [
        timeseries(lay, "Outbound hop - orchestrator to processor",
                   [('sum(rate(pipeline_messages_produced_total{type="process-dispatch",'
                     'outcome="accepted"}[$__rate_interval]))', "dispatched"),
                    ('sum(rate(pipeline_messages_consumed_total{type="process-dispatch",'
                     'disposition="acked"}[$__rate_interval]))', "picked up")],
                   desc="The two lines should track. A widening fork is backlog.",
                   unit="reqps", w=12),
        timeseries(lay, "Return hop - processor to orchestrator",
                   [('sum(rate(pipeline_messages_produced_total{type="step-outcome",'
                     'outcome="accepted"}[$__rate_interval]))', "sent"),
                    ('sum(rate(pipeline_messages_consumed_total{type="step-outcome",'
                     'disposition="acked"}[$__rate_interval]))', "picked up")],
                   unit="reqps", w=12),
        timeseries(lay, "Per-processor dispatch",
                   [('sum by (destination) (rate(pipeline_messages_produced_total'
                     '{type="process-dispatch",destination=~"processor-$processor"}'
                     '[$__rate_interval]))', "{{destination}}")],
                   desc="One series per processor. A line at zero while the others "
                        "flow is one processor being starved -- invisible in any "
                        "aggregate.",
                   unit="reqps"),
        timeseries(lay, "Retry amplification over time",
                   [('(sum(rate(pipeline_messages_consumed_total'
                     '{disposition=~"requeued|parked"}[$__rate_interval])) '
                     '+ sum(rate(pipeline_messages_consumed_total{landed="false"}'
                     '[$__rate_interval]))) '
                     '/ sum(rate(pipeline_messages_consumed_total[$__rate_interval])) '
                     'or vector(0)', "redone")],
                   desc="Flat zero is healthy and is drawn as a line, not as an "
                        "empty panel.",
                   unit="percentunit", minv=0),
        timeseries(lay, "Posture - gate, leader, hydration, identity",
                   [('min by (service_name) (pipeline_gate_open_ratio)', "gate {{service_name}}"),
                    ('count(pipeline_leader_ratio == 1) or vector(0)', "leaders elected"),
                    ('min(pipeline_hydration_admitted_ratio) or vector(0)', "hydration"),
                    ('min(pipeline_identity_ready_ratio) or vector(0)', "identity")],
                   desc="Why the pipeline stopped, in one panel. Every series should "
                        "sit at 1 -- leaders elected included.",
                   minv=0, decimals=0),
        table(lay, "Message flow matrix",
              [('sum by (service_name,type) (rate(pipeline_messages_produced_total'
                '[$__rate_interval]))', "produced"),
               ('sum by (service_name,type) (rate(pipeline_messages_consumed_total'
                '[$__rate_interval]))', "consumed")],
              desc="Every service against every message type. The quickest way to see "
                   "a type that is produced and never consumed."),
    ]

    return dashboard(
        uid="skp-flow",
        title="SKP Flow",
        description=("Cross-service conservation for the SKP pipeline. The board to "
                     "open first: it answers whether the system is broken and where, "
                     "then links out to the source boards. The hop-gap panels span two "
                     "services and belong to neither source board."),
        variables=[
            var_datasource(),
            var_query("processor", "Processor",
                      'label_values(pipeline_messages_produced_total{type="process-dispatch"}, destination)'),
        ],
        panels=panels,
        links=NAV,
        tags=["skp", "skp-flow", "pipeline"],
    )


# ---------------------------------------------------------------------------
# board 2 -- baseapi
# ---------------------------------------------------------------------------

API_F = ('service_name=~"$service_name",service_version=~"$service_version",'
         'service_instance_id=~"$service_instance_id"')


def build_baseapi():
    lay = Layout()
    f = API_F
    panels = []

    panels.append(row(lay, "1 - Verdict: is the API broken?"))
    panels += [
        stat(lay, "5xx ratio",
             [f'sum(rate(http_server_request_duration_seconds_count{{{f},'
              f'http_response_status_code=~"5.."}}[$__rate_interval])) '
              f'/ sum(rate(http_server_request_duration_seconds_count{{{f}}}'
              f'[$__rate_interval])) or vector(0)'],
             desc="Health routes are dropped collector-side, so this is real traffic "
                  "only.",
             unit="percentunit", decimals=2),
        stat(lay, "p95 latency",
             [f'histogram_quantile(0.95, sum by (le) '
              f'(rate(http_server_request_duration_seconds_bucket{{{f}}}'
              f'[$__rate_interval]))) or vector(0)'],
             desc="Across all routes. Break down by route on the ingress tier.",
             thresholds=T_NEUTRAL, unit="s", decimals=3),
        stat(lay, "In-flight",
             [f'sum(http_server_active_requests{{{f}}}) or vector(0)'],
             thresholds=T_NEUTRAL, decimals=0),
        stat(lay, "Kestrel queued",
             [f'sum(kestrel_queued_connections{{{f}}}) or vector(0)'],
             desc="Connections accepted but not yet served. Non-zero and sustained "
                  "means the server is behind.",
             thresholds=T_WARN, decimals=0),
        stat(lay, "DNS failures",
             [f'sum(rate(dns_lookup_duration_seconds_count{{{f},error_type!=""}}'
              f'[$__rate_interval])) or vector(0)'],
             desc="Name resolution failing for postgres, redis, rabbitmq or the "
                  "collector. A dependency signal nothing else on this board surfaces.",
             unit="reqps", decimals=2),
        stat(lay, "Pods reporting",
             [f'count(count by (service_instance_id) '
              f'(process_runtime_dotnet_assemblies_count{{{f}}})) or vector(0)'],
             thresholds=T_NEUTRAL, decimals=0),
    ]

    panels.append(row(lay, "2 - Ingress: what is broken?"))
    panels += [
        timeseries(lay, "Request rate by route",
                   [(f'sum by (http_route) (rate(http_server_request_duration_seconds_count'
                     f'{{{f}}}[$__rate_interval]))', "{{http_route}}")],
                   unit="reqps"),
        timeseries(lay, "p95 / p99 by route",
                   [(f'histogram_quantile(0.95, sum by (le,http_route) '
                     f'(rate(http_server_request_duration_seconds_bucket{{{f}}}'
                     f'[$__rate_interval])))', "p95 {{http_route}}"),
                    (f'histogram_quantile(0.99, sum by (le,http_route) '
                     f'(rate(http_server_request_duration_seconds_bucket{{{f}}}'
                     f'[$__rate_interval])))', "p99 {{http_route}}")],
                   unit="s"),
        timeseries(lay, "Status-code mix",
                   [(f'sum by (http_response_status_code) '
                     f'(rate(http_server_request_duration_seconds_count{{{f}}}'
                     f'[$__rate_interval]))', "{{http_response_status_code}}")],
                   desc="202 is the orchestration verbs; they accept and queue rather "
                        "than finishing the work.",
                   unit="reqps", stack=True, fill=40),
        timeseries(lay, "In-flight and Kestrel connections",
                   [(f'sum by (service_instance_id) (http_server_active_requests{{{f}}})',
                     "in-flight {{service_instance_id}}"),
                    (f'sum by (service_instance_id) (kestrel_active_connections{{{f}}})',
                     "connections {{service_instance_id}}"),
                    (f'sum by (service_instance_id) (kestrel_queued_connections{{{f}}})',
                     "queued {{service_instance_id}}")],
                   minv=0),
        timeseries(lay, "Dependency name resolution",
                   [(f'sum by (dns_question_name,error_type) '
                     f'(rate(dns_lookup_duration_seconds_count{{{f},error_type!=""}}'
                     f'[$__rate_interval]))', "{{dns_question_name}} / {{error_type}}")],
                   desc="host_not_found means the service object is gone. try_again "
                        "means the resolver timed out. Different faults, different "
                        "remedies.",
                   unit="reqps",
                   no_value="no resolution failures in range"),
        timeseries(lay, "Route match failures",
                   [(f'sum by (aspnetcore_routing_match_status) '
                     f'(rate(aspnetcore_routing_match_attempts_total{{{f}}}'
                     f'[$__rate_interval]))', "{{aspnetcore_routing_match_status}}")],
                   desc="A failure here is a caller using the wrong URL -- the "
                        "singular-vs-plural controller mistake returns a bare 404 with "
                        "no body and looks like the API being down.",
                   unit="reqps",
                   no_value="no routing attempts in range"),
        textpanel(lay, "The queue side is not instrumented",
                  "This board covers the API's **HTTP surface only**.\n\n"
                  "`BaseApi.Core/Messaging/GatedQueueConsumer.cs` is a separate copy of "
                  "the consumer with its own observability wiring, and the API host does "
                  "not register the `Messaging.Transport` meter. So the API's "
                  "`start-orchestration` publish and its `step-outcome` consumption emit "
                  "**no metrics at all**.\n\n"
                  "Absence on the Flow board is therefore not evidence of zero traffic "
                  "through the API's queues, and any produced-vs-consumed comparison "
                  "that crosses into the API will not balance. Deliberate -- see §10 "
                  "of the pipeline-metrics design."),
    ]

    rt = row(lay, "3 - Runtime: is the process why?", collapsed=True)
    rt["panels"] = runtime_row(lay, f)
    panels.append(rt)

    return dashboard(
        uid="skp-baseapi",
        title="SKP BaseAPI",
        description=("HTTP ingress for the SKP API. Its queue side emits no metrics by "
                     "design, which the last ingress panel states on the board rather "
                     "than leaving as an empty graph."),
        variables=[
            var_datasource(),
            var_constant("service_name", "baseapi"),
            var_query("service_version", "Version",
                      'label_values(http_server_active_requests{service_name="baseapi"}, service_version)'),
            var_query("service_instance_id", "Replica",
                      'label_values(http_server_active_requests{service_name="baseapi"}, service_instance_id)'),
        ],
        panels=panels,
        links=NAV,
        tags=["skp", "skp-baseapi", "webapi"],
    )


# ---------------------------------------------------------------------------
# board 3 -- orchestrator
# ---------------------------------------------------------------------------

def build_orchestrator():
    lay = Layout()
    f = WORKER_F
    rf = ',role=~"$role"'
    panels = []

    panels.append(row(lay, "1 - Verdict: is the orchestrator broken?"))
    v = verdict_shared(lay, f)
    panels += v[:2]
    panels += [
        stat(lay, "Hydration admitted",
             [f'min(pipeline_hydration_admitted_ratio{{{f}}}) or vector(0)'],
             desc="One-shot readiness. Separates 'not consuming because the store is "
                  "down' from 'not consuming because the first hydration pass has not "
                  "finished'.",
             thresholds=T_POSTURE, decimals=0),
        stat(lay, "Leaders elected",
             [f'count(pipeline_leader_ratio{{{f}}} == 1) or vector(0)'],
             desc="Must be exactly 1. Followers reading 0 is by design and is NOT a "
                  "fault -- StepOutcomeHandler is deliberately not leader-gated, so a "
                  "follower is still expected to consume. Zero means nobody holds the "
                  "lease; two means a split.",
             thresholds=T_EXACTLY_ONE, decimals=0),
    ]
    panels += v[2:]

    panels.append(row(lay, "2 - Pipeline: what is broken?"))
    panels += pipeline_shared(lay, f, role_f=rf)
    panels += [
        timeseries(lay, "Leader by replica",
                   [(f'pipeline_leader_ratio{{{f}}}', "{{service_instance_id}}")],
                   desc="Explains why cron fires land on one replica. Only cron fires "
                        "are fenced by leadership.",
                   minv=0, maxv=1, decimals=0, fill=20),
        timeseries(lay, "Hydration admitted by replica",
                   [(f'pipeline_hydration_admitted_ratio{{{f}}}',
                     "{{service_instance_id}}")],
                   minv=0, maxv=1, decimals=0, fill=20),
        timeseries(lay, "Dispatch by destination",
                   [(f'sum by (destination) (rate(pipeline_messages_produced_total'
                     f'{{{f},type="process-dispatch",destination=~"processor-$processor"}}'
                     f'[$__rate_interval]))', "{{destination}}")],
                   desc="Per-processor fan-out from this side of the hop.",
                   unit="reqps"),
        timeseries(lay, "Consumed by role",
                   [(f'sum by (role,type) (rate(pipeline_messages_consumed_total'
                     f'{{{f}{rf}}}[$__rate_interval]))', "{{role}} / {{type}}")],
                   desc="The role attribute records what this replica was AT THE TIME "
                        "it handled the delivery, so a replica carries both values "
                        "across a leadership change. It is not a replica selector -- "
                        "service_instance_id is.",
                   unit="reqps"),
        textpanel(lay, "What the Role filter reaches",
                  "`role` is an attribute on **three instruments only**: "
                  "`pipeline.messages.produced`, `pipeline.messages.consumed` and "
                  "`pipeline.produce.duration`. Verified against the live stack.\n\n"
                  "The gauges (`gate.open`, `leader`, `hydration.admitted`, "
                  "`consumer.consuming`, `consumer.inflight`) and "
                  "`consumer.channel.resets` carry **no** `role`, so the filter is "
                  "applied only to the four panels that can honour it. Applying it "
                  "board-wide would empty the rest, because a `role=~\"leader\"` "
                  "matcher does not match a series that has no `role` label.\n\n"
                  "The verdict tier is deliberately left unfiltered as well: it answers "
                  "*is anything wrong anywhere*, and a role selection there would let a "
                  "follower fault hide behind a leader view.",
                  w=8, h=8),
    ]

    rt = row(lay, "3 - Runtime: is the process why?", collapsed=True)
    rt["panels"] = runtime_row(lay, f)
    panels.append(rt)

    return dashboard(
        uid="skp-orchestrator",
        title="SKP Orchestrator",
        description=("Orchestrator control plane -- 3 replicas across 5 queues. Six "
                     "pipeline panels are shared with the processor board and generated "
                     "from one source so the two cannot drift."),
        variables=[
            var_datasource(),
            var_constant("service_name", "orchestrator"),
            var_query("service_version", "Version",
                      'label_values(pipeline_gate_open_ratio{service_name="orchestrator"}, service_version)'),
            var_query("service_instance_id", "Replica",
                      'label_values(pipeline_gate_open_ratio{service_name="orchestrator"}, service_instance_id)'),
            var_custom("role", "Role", ["leader", "follower"],
                       desc="Applies only to the produced / consumed / produce-duration "
                            "panels -- the three instruments that carry a role "
                            "attribute. See the note panel on the pipeline tier."),
            var_query("processor", "Processor",
                      'label_values(pipeline_messages_produced_total{service_name="orchestrator",type="process-dispatch"}, destination)'),
        ],
        panels=panels,
        links=NAV,
        tags=["skp", "skp-orchestrator", "pipeline"],
    )


# ---------------------------------------------------------------------------
# board 4 -- processor
# ---------------------------------------------------------------------------

def build_processor():
    lay = Layout()
    f = WORKER_F + ',processorId=~"$processorId"'
    panels = []

    panels.append(row(lay, "1 - Verdict: is the processor broken?"))
    v = verdict_shared(lay, f)
    panels += v[:2]
    panels += [
        stat(lay, "Identity ready",
             [f'min(pipeline_identity_ready_ratio{{{f}}}) or vector(0)'],
             desc="0 means the pod is up and waiting for a processor row whose "
                  "SourceHash matches its image. Running / NotReady with 0 restarts is "
                  "the designed behaviour, not a crash loop -- this is the metric that "
                  "makes that legible.",
             thresholds=T_POSTURE, decimals=0),
        stat(lay, "Duplicates suppressed",
             [f'sum(increase(pipeline_duplicate_suppressed_total{{{f}}}[$__range])) '
              f'or vector(0)'],
             desc="Deliveries acked having done no work, because the entry was already "
                  "absent. The primary idempotence mechanism; invisible under "
                  "disposition=acked. Rare is fine, frequent is a question.",
             thresholds=T_WARN, decimals=0),
    ]
    panels += v[2:]

    panels.append(row(lay, "2 - Pipeline: what is broken?"))
    panels += pipeline_shared(lay, f)
    panels += [
        timeseries(lay, "Process duration (mean) by outcome",
                   [(f'sum by (outcome) (rate(pipeline_process_duration_seconds_sum'
                     f'{{{f}}}[$__rate_interval])) '
                     f'/ sum by (outcome) (rate(pipeline_process_duration_seconds_count'
                     f'{{{f}}}[$__rate_interval]))', "{{outcome}}")],
                   desc="The author's own transform -- the only span here whose length "
                        "is somebody's implementation rather than this framework's "
                        "constant cost. returned vs faulted keeps a slow success and a "
                        "slow failure from averaging into a number describing neither."
                        + PARA + "MEAN, NOT p95, for the same bucket-boundary reason as the "
                        "produce-duration panel: 100% of observations sit in the first "
                        "(0,5] bucket, so every quantile reads ~4.9s regardless of the "
                        "real value.",
                   unit="s"),
        timeseries(lay, "Identity ready by replica",
                   [(f'pipeline_identity_ready_ratio{{{f}}}', "{{service_instance_id}}")],
                   minv=0, maxv=1, decimals=0, fill=20),
        timeseries(lay, "Duplicate suppression rate",
                   [(f'sum(rate(pipeline_duplicate_suppressed_total{{{f}}}'
                     f'[$__rate_interval])) or vector(0)', "suppressed")],
                   desc="Flat zero is healthy and is drawn, not left empty.",
                   unit="reqps", minv=0),
        timeseries(lay, "Replica fan-out",
                   [(f'sum by (service_instance_id) (rate(pipeline_messages_consumed_total'
                     f'{{{f},disposition="acked"}}[$__rate_interval]))',
                     "{{service_instance_id}}")],
                   desc="Replicas share one queue, so the broker round-robins. A "
                        "replica sitting near zero while the others work is consuming "
                        "nothing despite looking healthy.",
                   unit="reqps"),
    ]

    rt = row(lay, "3 - Runtime: is the process why?", collapsed=True)
    rt["panels"] = runtime_row(lay, f)
    panels.append(rt)

    return dashboard(
        uid="skp-processor",
        title="SKP Processor",
        description=("Processor replicas. service_name is a real multi-select here: a "
                     "processor takes its name and version from its database row via "
                     "the two-stage boot, so different images carry different "
                     "identities."),
        variables=[
            var_datasource(),
            # all_value=None is load-bearing here. This is the only board whose
            # service_name is a real selector rather than a constant, and with ".*" the
            # All option matched the orchestrator too -- the board rendered
            # next-step-handoff and process-dispatch, which no processor ever produces.
            var_query("service_name", "Processor image",
                      'label_values(pipeline_identity_ready_ratio, service_name)',
                      all_value=None),
            var_query("service_version", "Version",
                      'label_values(pipeline_identity_ready_ratio{service_name=~"$service_name"}, service_version)'),
            var_query("service_instance_id", "Replica",
                      'label_values(pipeline_identity_ready_ratio{service_name=~"$service_name"}, service_instance_id)'),
            var_query("processorId", "Processor id",
                      'label_values(pipeline_identity_ready_ratio{service_name=~"$service_name"}, processorId)'),
        ],
        panels=panels,
        links=NAV,
        tags=["skp", "skp-processor", "pipeline"],
    )


# ---------------------------------------------------------------------------

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    boards = [
        ("skp-flow.json", build_flow()),
        ("skp-baseapi.json", build_baseapi()),
        ("skp-orchestrator.json", build_orchestrator()),
        ("skp-processor.json", build_processor()),
    ]
    for name, board in boards:
        path = OUT / name
        path.write_text(json.dumps(board, indent=2) + "\n", encoding="utf-8")
        n = sum(1 + len(p.get("panels", [])) for p in board["panels"] if p["type"] == "row")
        n += sum(1 for p in board["panels"] if p["type"] != "row")
        print(f"{path.relative_to(OUT.parent.parent)}  "
              f"{len(board['templating']['list'])} variables, {n} panels")


if __name__ == "__main__":
    main()
