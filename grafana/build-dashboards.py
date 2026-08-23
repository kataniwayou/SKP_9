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
# For a conservation gap counted in messages. Scrape boundaries put a handful of messages
# on either side of zero even when nothing is lost, so the green band has to be wider than
# one message -- see the Outbound hop gap description for the measurement behind these.
#
# SYMMETRIC, and that is the fix rather than the decoration. The gap and its return-hop
# twin are the same quantity measured in opposite directions, so one physical event puts
# +N on one and -N on the other. With steps only on the positive side the pair disagreed
# about the same instant: measured across the chaos suite, one panel orange and its twin
# green, every time.
#
# +/-25 for the green band, and the old +/-10 was simply too tight to survive a run.
# Measured over a full suite with no restart anywhere in range -- the undisturbed baseline
# included -- the start and stop transients reach 12-13 EVERY time, so the primary board
# went orange on a healthy soak. With a replica restart inside the range the same panels
# reach 20-46, which is what the orange band is for: not "messages were lost" but "check
# Workers reporting before you read this number".
T_GAP = [{"color": "red", "value": None},
         {"color": "orange", "value": -50},
         {"color": "green", "value": -25},
         {"color": "orange", "value": 25},
         {"color": "red", "value": 50}]
# Share of deliveries that will be redone. Not red-at-any-non-zero: the counted form is
# sticky for a range width, so one parked delivery during a broker outage kept this stat
# red across the two scenarios that followed it, on the board an operator opens first.
# A handful of redone messages in a fifteen-minute window is a thing to notice, not an
# outage; a fifth of them being redone is an outage.
T_REDONE = [{"color": "green", "value": None},
            {"color": "orange", "value": 0.01},
            {"color": "red", "value": 0.05}]
# Seconds since the least-fresh service last exported. The effective resolution is 15s, so
# this sawtooths 0-15 in health; anything above that means a service has stopped reporting.
T_STALE = [{"color": "green", "value": None},
           {"color": "orange", "value": 45},
           {"color": "red", "value": 90}]

# ---------------------------------------------------------------------------
# reading a stale-held gauge, and counting a fault that is rare
# ---------------------------------------------------------------------------

# The collector's prometheus exporter keeps publishing a series after the process that
# fed it is gone, and Prometheus's own 5-minute lookback holds it after that. So a plain
# gauge selector reports replicas that no longer exist, at whatever value they held when
# they died.
#
# Measured, not theorised. During the chaos suite's orchestrator scenario all three
# orchestrator replicas were deleted for 58 seconds; throughout that window
# `min(pipeline_consumer_consuming_ratio)` stayed 1, `min(pipeline_gate_open_ratio)`
# stayed 1, and `count(count by (service_instance_id) (pipeline_gate_open_ratio))` stayed
# 5. In the processor scenario the same count went 5 -> 7 while two of five workers were
# being deleted, because the dead replicas were held alongside the new ones.
#
# `last_over_time(x[LIVENESS])` yields only series with a real sample inside the window,
# which is what "this replica is still reporting" means here.
#
# 40s, and the number is measured rather than chosen. The export cadence is 10s against a
# 15s scrape, so the effective sample spacing is 15s and the window has to survive one late
# sample without declaring a healthy replica dead -- and it has to be tight enough that a
# replica which vanishes for a minute falls out of it before its replacement starts
# reporting. At the old 60s cadence the equivalent number was 100s; 2m failed outright,
# never dipping on three recorded ~58s disappearances.
LIVENESS = "40s"


def live(series):
    """A gauge restricted to replicas that have actually reported recently."""
    return f"last_over_time({series}[{LIVENESS}])"


def counted(series, window="$__range"):
    """A fault counter read as a count over the range, correct at series birth.

    Fault counters here have no series at all in health -- the .NET counter is created on
    first increment -- so the first burst of a given fault type appears as a series whose
    very first exported sample is already non-zero. `increase()` measures growth WITHIN
    the window and therefore reports 0 for exactly that case: the first time a fault ever
    happens, which is the case the verdict tier exists to catch.

    Measured at the OLD 60s export cadence, which is when this shape was chosen: the
    broker scenario produced two transient publishes and one parked delivery.
    `sum(increase(...))` read 0 for all three for the rest of the run, while the
    rate-based stats these replace read 0.00 for the same reason plus the 240s rate
    window that cadence forced. This form -- the larger of the in-window growth and the
    absolute total -- read 2 and 1. The cadence is 10s now and the rate window 60s, which
    narrows the second half of that argument but not the first: the series-birth problem
    is a property of the .NET counter, not of the window, so this form is still required.

    The alert rules in k8s/02-configmaps.yaml carry the same shape for the same reason --
    see EgressFaults there, which shipped as bare `increase()` and could not have caught
    a first-ever fault.

    Consequence worth knowing: once a fault series exists it is exported for the life of
    the process, so this stat stays non-zero until the replica restarts. That is why the
    stats using it are thresholded warn-at-one rather than red: a fault that happened
    twenty minutes ago should not vanish from the verdict tier, but it should not read as
    an outage in progress either.
    """
    grew = f"sum(increase({series}[{window}])) or vector(0)"
    total = f"sum(max_over_time({series}[{window}])) or vector(0)"
    return f"(({grew}) > ({total})) or ({total})"


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
         decimals=None, w=3, h=4, text_mode="auto", no_value=None):
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
                # `or vector(0)` covers an empty result. It does NOT cover NaN, which is
                # what a quantile over zero traffic produces, so a stat that can go NaN
                # needs text as well or it renders indistinguishable from a broken query.
                **({"noValue": no_value} if no_value is not None else {}),
            },
            "overrides": [],
        },
    }


def timeseries(layout, title, exprs, desc="", unit="short", w=8, h=8,
               stack=False, fill=8, legend_mode="list", legend_pos="bottom",
               minv=None, maxv=None, thresholds=None, draw_style="line",
               decimals=None, no_value=None, soft_max=None):
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
    # A ratio that sits flat at zero in health gets an axis scaled to whatever transient
    # once spiked -- after a rollout, 10000%. A soft max floors the axis so the healthy
    # line is readable, while still expanding if the data genuinely exceeds it.
    if soft_max is not None:
        custom["axisSoftMax"] = soft_max
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


def table(layout, title, exprs, desc="", w=8, h=8, exclude=(), rename=None):
    return {
        "id": _next_id(),
        "type": "table",
        "title": title,
        "description": desc,
        "datasource": DS,
        "gridPos": layout.place(w, h),
        "targets": [dict(t, format="table", instant=True, range=False)
                    for t in targets(exprs)],
        "transformations": [
            {"id": "merge", "options": {}},
            # Instant queries still carry a Time column, identical on every row, which here
            # only steals width from the value.
            # Table format discards legendFormat, so a two-query table arrives with columns
            # called "Value #A" and "Value #B" and the reader has to guess which is which.
            {"id": "organize", "options": {
                "excludeByName": {k: True for k in exclude},
                "renameByName": rename or {},
            }},
        ],
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
             [f'min({live(f"pipeline_consumer_consuming_ratio{{{f}}}")}) or vector(0)'],
             desc="0 means no consumer tag on at least one queue -- nothing is "
                  "listening. No other signal answers this." + PARA +
                  "Restricted to replicas that have reported in the last " + LIVENESS +
                  ": a dead replica's gauge is held at its last value by the collector "
                  "and by Prometheus's lookback, so an unrestricted min() reads the "
                  "posture of processes that no longer exist.",
             thresholds=T_POSTURE, decimals=0),
        stat(layout, "L2 gate",
             [f'min({live(f"pipeline_gate_open_ratio{{{f}}}")}) or vector(0)'],
             desc="The single best answer to 'why did the pipeline stop'. 0 means "
                  "the gate is shut and deliveries are being requeued.",
             thresholds=T_POSTURE, decimals=0),
        stat(layout, "Not acked",
             [counted(f'pipeline_messages_consumed_total{{{f},'
                      f'disposition=~"requeued|parked"}}')],
             desc="Deliveries the consumer refused or sent back, COUNTED over the "
                  "visible range. Drill into 'reason' on the pipeline tier for why."
                  + PARA +
                  "Counted rather than rated. Measured at the old 60s export cadence, when "
                  "the rate window here was 240s: as a rate this read 0.00 through every "
                  "scenario in the chaos suite, because the single parked delivery the "
                  "broker outage produced was 1/240 = 0.004, which rounds to nothing at "
                  "any sane precision. The window is 60s now, which makes that same "
                  "delivery 0.017 -- still nothing at this precision, which is why the "
                  "panel is still counted rather than rated.",
             thresholds=T_WARN, decimals=0),
        stat(layout, "Ack lost",
             [counted(f'pipeline_messages_consumed_total{{{f},'
                      f'disposition="acked",landed="false"}}')],
             desc="The silent case: the handler ran to completion but the broker "
                  "never heard the ack, so it will redeliver. Cause is on the "
                  "channel-resets panel. Counted over the range, for the reason "
                  "'Not acked' gives.",
             thresholds=T_WARN, decimals=0),
        stat(layout, "Egress faults",
             [counted(f'pipeline_messages_produced_total{{{f},'
                      f'outcome=~"transient|unroutable|refused"}}')],
             desc="unroutable = the queue is not declared. transient = the broker "
                  "is unreachable. Opposite remedies; this is the only signal that "
                  "separates them." + PARA +
                  "Counted over the range. Scaling the broker to zero for sixty seconds "
                  "produced exactly two transient publishes; as a rate they were 0.00 on "
                  "every board and the only trace of them anywhere was a new legend entry "
                  "on the produced-by-outcome timeseries.",
             thresholds=T_WARN, decimals=0),
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
        timeseries(layout, "Produce duration p95 / p99",
                   [(f'histogram_quantile(0.95, sum by (le,destination) '
                     f'(rate(pipeline_produce_duration_seconds_bucket{{{f}{rf}}}'
                     f'[$__rate_interval])))', "p95 {{destination}}"),
                    (f'histogram_quantile(0.99, sum by (le,destination) '
                     f'(rate(pipeline_produce_duration_seconds_bucket{{{f}{rf}}}'
                     f'[$__rate_interval])))', "p99 {{destination}}"),
                    (f'sum by (destination) (rate(pipeline_produce_duration_seconds_sum'
                     f'{{{f}{rf}}}[$__rate_interval])) '
                     f'/ sum by (destination) (rate(pipeline_produce_duration_seconds_count'
                     f'{{{f}{rf}}}[$__rate_interval]))', "mean {{destination}}")],
                   desc="A real broker round-trip to publisher confirmation, not the "
                        "time to write a frame." + PARA + "The mean rides alongside the "
                        "quantiles deliberately. It comes from sum/count and so is "
                        "independent of bucket boundaries -- if it ever diverges wildly "
                        "from p50, the ladder has stopped fitting the data. That is "
                        "exactly how the millisecond-ladder defect was caught: p95 read "
                        "4.9s while the mean read 15ms.",
                   unit="s"),
        timeseries(layout, "Consumer inflight by queue",
                   [(f'max by (queue) ({live(f"pipeline_consumer_inflight{{{f}}}")})',
                     "{{queue}}")],
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
                   [(f'min by (queue) ({live(f"pipeline_consumer_consuming_ratio{{{f}}}")})',
                     "{{queue}}")],
                   desc="Per-queue view of the verdict stat. A queue reading 0 while "
                        "the others read 1 is one wedged consumer, not an outage." + PARA +
                        "A queue whose LINE STOPS is a replica that has gone away: the "
                        "series is restricted to replicas reporting inside " + LIVENESS +
                        ", so a departure ends the line instead of freezing it at 1." + PARA +
                        "Unfilled on purpose: the orchestrator has five queues, all sitting "
                        "at 1 in health, and five filled areas stacked on one line render as "
                        "a single opaque block in which a dip is invisible.",
                   minv=0, maxv=1, decimals=0, fill=0, draw_style="line"),
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

# Selectors the flow board names more than once.
REDONE = 'pipeline_messages_consumed_total{disposition=~"requeued|parked"}'
NOT_LANDED = 'pipeline_messages_consumed_total{landed="false"}'
EGRESS_FAULT = ('pipeline_messages_produced_total'
                '{outcome=~"transient|unroutable|refused"}')
# present_over_time rather than last_over_time: this counts reporters, and the value a
# reporter holds is irrelevant to whether it is still there.
LIVE_WORKERS = ('count(count by (service_instance_id) '
                f'(present_over_time(pipeline_gate_open_ratio[{LIVENESS}]))) or vector(0)')


def build_flow():
    lay = Layout()
    panels = []

    panels.append(row(lay, "1 - Verdict: is it broken right now?"))
    panels += [
        stat(lay, "System flowing",
             ['sum(rate(pipeline_messages_produced_total[$__rate_interval])) or vector(0)'],
             desc="Total egress across every worker. Zero during a run means the "
                  "pipeline has stopped, whatever else reads green." + PARA +
                  "**Slower than the fault you are chasing.** $__rate_interval is 60s on "
                  "this stack -- the datasource declares a 15s timeInterval, matching the "
                  "scrape, and Grafana floors the rate window at four times it. So this "
                  "number averages the last minute and still cannot fall to zero inside a "
                  "shorter outage." + PARA +
                  "Measured at the OLD 60s export cadence, when timeInterval was 60s and "
                  "$__rate_interval 240s: with the whole pipeline stopped this still read "
                  "1.12 req/s a hundred seconds later, and through a sixty-second broker "
                  "outage it only dipped 1.12 -> 0.92, never leaving green. Those are the "
                  "numbers that bought the cadence change; a sixty-second fault now falls "
                  "inside one rate window rather than a quarter of one, so the dilution is "
                  "four times smaller -- not gone. Read the posture stats beside it for "
                  "anything shorter than a minute; this one answers 'has throughput "
                  "changed', not 'is it down'.",
             thresholds=[{"color": "red", "value": None}, {"color": "green", "value": 0.0001}],
             unit="reqps", decimals=2),
        stat(lay, "Consuming",
             [f'min({live("pipeline_consumer_consuming_ratio")}) or vector(0)'],
             desc="Minimum across every queue in the deployment, over replicas that "
                  "have reported in the last " + LIVENESS + ".",
             thresholds=T_POSTURE, decimals=0),
        stat(lay, "L2 gate",
             [f'min({live("pipeline_gate_open_ratio")}) or vector(0)'],
             desc="0 means the gate is shut somewhere and deliveries are being "
                  "requeued." + PARA +
                  "**This is what separates a store fault from a broker fault**, and it "
                  "is on this board for that reason. Without it a Redis outage and a "
                  "RabbitMQ outage render identically here -- Consuming drops to 0 in "
                  "both and every other stat stays green -- and telling them apart means "
                  "opening a worker board. The gate goes with Redis and stays open for "
                  "the broker, so 'Consuming 0, gate 0' and 'Consuming 0, gate 1' are two "
                  "different call-outs.",
             thresholds=T_POSTURE, decimals=0),
        stat(lay, "Workers reporting",
             [LIVE_WORKERS],
             desc="Orchestrator replicas plus processor replicas that have exported "
                  "inside the last " + LIVENESS + "." + PARA +
                  "**Counts live reporters, not series.** The collector republishes a "
                  "series after the process feeding it is gone, and Prometheus holds it "
                  "for another five minutes, so the obvious count() counts the dead. "
                  "Measured: with all three orchestrator replicas deleted for 58 seconds "
                  "the old expression read a steady 5, and while two of five workers were "
                  "being deleted it read 7 -- the dead counted alongside their "
                  "replacements.",
             thresholds=T_NEUTRAL, decimals=0),
        stat(lay, "Data freshness",
             ['time() - min(max by (service_name) '
              '(timestamp(pipeline_gate_open_ratio))) or vector(0)'],
             desc="Seconds since the least-fresh service last exported anything." + PARA +
                  "Every other panel on this board is downstream of this number. The "
                  "export cadence is 10s against a 15s scrape, so the effective resolution "
                  "is 15s and this sawtooths 0-15 in health. Orange at 45 -- three missed "
                  "samples -- and red at 90. Sustained above green means a service has "
                  "stopped reporting and its gauges are being held at whatever they last "
                  "said." + PARA +
                  "The TelemetryStale alert rule fires off the same 45, deliberately, so "
                  "the alert and this panel change colour at the same instant.",
             thresholds=T_STALE, unit="s", decimals=0),
    ]

    lay.newline()
    # Titled by TENSE, not by window. It used to read "what happened in this range?",
    # which contradicted the one stat in the row whose window is not the range: Workers
    # missing (5m) was deliberately moved OFF $__range to a fixed five minutes so the
    # number stops changing when the reader zooms. Naming the row by its window made the
    # row label wrong for that stat; naming it by tense is true of all six.
    panels.append(row(lay, "2 - Since: what has already happened?"))
    panels += [
        stat(lay, "Outbound hop gap",
             ['sum(increase(pipeline_messages_produced_total{type="process-dispatch",'
              'outcome="accepted"}[$__range])) '
              '- sum(increase(pipeline_messages_consumed_total{type="process-dispatch",'
              'disposition="acked"}[$__range])) or vector(0)'],
             desc="Dispatches the orchestrator confirmed, minus acks the processors "
                  "issued, counted in MESSAGES over the visible range." + PARA +
                  "Counts rather than a difference of rates, and the distinction is what "
                  "makes the panel usable. Two counters scraped independently give a rate "
                  "difference that is noise centred on zero -- measured here over an hour: "
                  "p50 +0.000, max +0.074 req/s, tripping any near-zero threshold 13% of "
                  "the time on a perfectly healthy stack. The same hour in counts: 1311 "
                  "produced, 1313 acked. A real leak grows with the range; jitter does not."
                  + PARA +
                  "**A restart inside the range puts tens of messages here and none of "
                  "them are lost.** A replica that goes away and comes back gets a new "
                  "series, and produced and consumed counters for the same messages live "
                  "on different services that restart at different moments. Measured "
                  "across the chaos suite: +46/-47, +48/-46, +43/-44, every one an "
                  "artefact of a scale-to-zero and every one gone within a range width. "
                  "Check the Workers reporting stat before believing a number here.",
             thresholds=T_GAP, decimals=0),
        stat(lay, "Return hop gap",
             ['sum(increase(pipeline_messages_produced_total{type="step-outcome",'
              'outcome="accepted"}[$__range])) '
              '- sum(increase(pipeline_messages_consumed_total{type="step-outcome",'
              'disposition="acked"}[$__range])) or vector(0)'],
             desc="The same conservation check on the way back, in messages over the "
                  "visible range." + PARA +
                  "The API also consumes step-outcome and that consumption is not "
                  "instrumented, so a positive value here is the API's share before it is "
                  "anything else." + PARA +
                  "Thresholded symmetrically with its outbound twin. The two measure one "
                  "quantity in opposite directions, so a restart that puts +46 on one puts "
                  "-47 on the other; with steps on the positive side only, the pair used to "
                  "render one orange and one green for the same instant.",
             thresholds=T_GAP, decimals=0),
        stat(lay, "Retry amplification",
             [f'(({counted(REDONE)}) + ({counted(NOT_LANDED)})) '
              f'/ (sum(increase(pipeline_messages_consumed_total[$__range])) > 0) '
              f'or vector(0)'],
             desc="Share of deliveries that will be redone, in MESSAGES over the visible "
                  "range. Healthy is exactly zero." + PARA +
                  "Counted rather than rated, and that is what makes it able to fire at "
                  "all. Measured at the old 60s export cadence: as a ratio of two 240s "
                  "rates it read 0.0% through every scenario in the chaos suite, including "
                  "the broker outage that parked a delivery, because one parked message "
                  "against a 240s denominator was a rounding error. The rate window is 60s "
                  "now, which would make that same event 4x larger and still a rounding "
                  "error; one parked message in a fifteen-minute range is a number."
                  + PARA +
                  "Green below 1%. Counting rather than rating makes this stat sticky for a "
                  "range width, and thresholded red-at-any-non-zero it stayed red through "
                  "the two scenarios AFTER the one that parked a single delivery -- 0.2% of "
                  "traffic, on the board an operator opens first. A few redone messages is "
                  "something to notice; a twentieth of all deliveries being redone is the "
                  "outage.",
             thresholds=T_REDONE, unit="percentunit", decimals=1),
        stat(lay, "Ack lost",
             [counted('pipeline_messages_consumed_total{disposition="acked",'
                      'landed="false"}')],
             desc="Work completed that the broker will hand out again, counted over "
                  "the visible range.",
             thresholds=T_WARN, decimals=0),
        stat(lay, "Egress faults",
             [counted(EGRESS_FAULT)],
             desc="Any send that did not reach the broker, anywhere in the stack, "
                  "counted over the visible range.",
             thresholds=T_WARN, decimals=0),
        stat(lay, "Workers missing (5m)",
             [f'(max_over_time(({LIVE_WORKERS})[5m:15s]) '
              f'- min_over_time(({LIVE_WORKERS})[5m:15s])) or vector(0)'],
             desc="The deepest dip in live worker count over the last five minutes. Names "
                  "how many replicas went away, without having to be told how many there "
                  "ought to be -- it reads 3 for a lost orchestrator StatefulSet and 2 for "
                  "a lost processor pair." + PARA +
                  "**Five minutes, not the visible range.** Peak-minus-trough over "
                  "$__range makes the number change when the reader zooms, and made "
                  "back-to-back scenarios report the earlier, deeper one: 3 during the "
                  "processor scenario, whose own answer was 2. A stated window is worth "
                  "more than a wider one." + PARA +
                  "**Peak minus trough, not peak minus now.** The dip is narrow and a stat "
                  "panel is a range query at the datasource step, so a subtraction against "
                  "the current value lands on the wrong side of the dip about half the "
                  "time -- measured at the old 60s step, where it missed an outage the "
                  "same expression had caught an hour earlier. The step is 15s now, but "
                  "the `[5m:15s]` subqueries pin the evaluation at 15s regardless of it, "
                  "which is what keeps this independent of the panel's own step." + PARA +
                  "**It cannot be prompt.** A replica is only missing once it has skipped "
                  "its liveness window, so detection takes roughly the liveness window "
                  "plus one export. Nothing queryable fixes the remainder: a fault shorter "
                  "than the sampling period is not observable.",
             thresholds=T_WARN, decimals=0),
    ]

    panels.append(row(lay, "3 - Flow: where is it leaking?"))
    panels += [
        timeseries(lay, "Outbound hop - orchestrator to processor",
                   [('sum(rate(pipeline_messages_produced_total{type="process-dispatch",'
                     'outcome="accepted"}[$__rate_interval]))', "dispatched"),
                    ('sum(rate(pipeline_messages_consumed_total{type="process-dispatch",'
                     'disposition="acked"}[$__rate_interval]))', "picked up")],
                   desc="The two lines should track. A widening fork is backlog."
                        + PARA +
                        "Orchestrator and processor only. The API is not on this hop, "
                        "but note that its own queue paths emit no metrics at all, so "
                        "no panel on this board can see traffic the API publishes or "
                        "consumes -- see the note panel on SKP BaseAPI.",
                   unit="reqps", w=12),
        timeseries(lay, "Return hop - processor to orchestrator",
                   [('sum(rate(pipeline_messages_produced_total{type="step-outcome",'
                     'outcome="accepted"}[$__rate_interval]))', "sent"),
                    ('sum(rate(pipeline_messages_consumed_total{type="step-outcome",'
                     'disposition="acked"}[$__rate_interval]))', "picked up")],
                   desc="The same conservation check on the way back."
                        + PARA +
                        "The API also consumes step-outcome, and that consumption is "
                        "NOT instrumented, so 'picked up' here counts the orchestrator "
                        "alone. Read a shortfall as the API's share, not as loss.",
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
                   unit="percentunit", minv=0, soft_max=0.1),
        timeseries(lay, "Posture - consuming, gate, leader, hydration, identity",
                   [(f'min by (service_name) ({live("pipeline_consumer_consuming_ratio")})',
                     "consuming {{service_name}}"),
                    (f'min by (service_name) ({live("pipeline_gate_open_ratio")})',
                     "gate {{service_name}}"),
                    (f'count({live("pipeline_leader_ratio")} == 1) or vector(0)',
                     "leaders elected"),
                    (f'min({live("pipeline_hydration_admitted_ratio")}) or vector(0)',
                     "hydration"),
                    (f'min({live("pipeline_identity_ready_ratio")}) or vector(0)',
                     "identity")],
                   desc="Why the pipeline stopped, in one panel. Every series should "
                        "sit at 1 -- leaders elected included." + PARA +
                        "**Consuming is on here now because it is the series that "
                        "actually moves.** It was the only posture signal to change in "
                        "the Redis, broker and both-down scenarios, and it was the one "
                        "this panel did not draw -- so the board's single history of the "
                        "fault was a stat sparkline three centimetres wide." + PARA +
                        "Every series is restricted to replicas reporting inside " +
                        LIVENESS + ", so a replica going away ends its line rather than "
                        "freezing it at 1.",
                   minv=0, decimals=0),
        table(lay, "Message flow matrix",
              [('sum by (service_name,type) (rate(pipeline_messages_produced_total'
                '[$__rate_interval]))', "produced"),
               ('sum by (service_name,type) (rate(pipeline_messages_consumed_total'
                '[$__rate_interval]))', "consumed")],
              desc="Every service against every message type. The quickest way to see "
                   "a type that is produced and never consumed.",
              w=12,
              exclude=("Time",),
              rename={"Value #A": "produced /s", "Value #B": "consumed /s",
                      "service_name": "service"}),
    ]

    return dashboard(
        uid="skp-flow",
        title="SKP Flow",
        description=("Cross-service conservation for the SKP pipeline. The board to "
                     "open first: it answers whether the system is broken and where, "
                     "then links out to the source boards. The hop-gap panels span two "
                     "services and belong to neither source board." + PARA +
                     "The verdict tier is split by TENSE. Row 1 is the state right now. "
                     "Row 2 is the worst thing that has already happened, and those stats "
                     "stay non-zero after the event that caused them -- deliberately, so "
                     "an operator arriving late is still told." + PARA +
                     "Row 2's stats are scoped to the visible range, with ONE exception: "
                     "`Workers missing (5m)` is fixed at five minutes regardless of the "
                     "range, so its number does not change when you zoom. Its own "
                     "description says why."),
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
             desc="Across all routes. Break down by route on the ingress tier." + PARA +
                  "Blank means no requests in the range, not a broken query. "
                  "histogram_quantile over an all-zero rate is 0/0 = NaN, which `or "
                  "vector(0)` cannot rescue -- it substitutes for an EMPTY result, and NaN "
                  "is a result. The no-value text below is what covers that case.",
             thresholds=T_NEUTRAL, unit="s", decimals=3,
             no_value="no requests in range"),
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
        timeseries(lay, "Route matching by status",
                   [(f'sum by (aspnetcore_routing_match_status) '
                     f'(rate(aspnetcore_routing_match_attempts_total{{{f}}}'
                     f'[$__rate_interval]))', "{{aspnetcore_routing_match_status}}")],
                   desc="Split by match status. A `failure` series is a caller using the "
                        "wrong URL -- the singular-vs-plural controller mistake returns a "
                        "bare 404 with no body and looks like the API being down." + PARA +
                        "The success series is kept deliberately: it is the only panel here "
                        "that distinguishes 'no failures' from 'no traffic at all'.",
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
                  "that crosses into the API will not balance." + PARA +
                  "Deliberate, not an oversight. The reasoning is in section 10, "
                  "'Out of scope', of "
                  "`docs/superpowers/specs/2026-08-22-pipeline-metrics-design.md` "
                  "in the SK_P repository, which also names the second dark path: "
                  "`QueueFanoutPublisher` IS instrumented, but its only callers are "
                  "the API's start and stop handlers, whose host never registers the "
                  "`Messaging.Transport` meter -- so the instrument exists and emits "
                  "nothing."),
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
             [f'min({live(f"pipeline_hydration_admitted_ratio{{{f}}}")}) or vector(0)'],
             desc="One-shot readiness. Separates 'not consuming because the store is "
                  "down' from 'not consuming because the first hydration pass has not "
                  "finished'.",
             thresholds=T_POSTURE, decimals=0),
        stat(lay, "Leaders elected",
             [f'count({live(f"pipeline_leader_ratio{{{f}}}")} == 1) or vector(0)'],
             desc="Must be exactly 1. Followers reading 0 is by design and is NOT a "
                  "fault -- StepOutcomeHandler is deliberately not leader-gated, so a "
                  "follower is still expected to consume. Zero means nobody holds the "
                  "lease; two means a split." + PARA +
                  "This one stat did fall when all three replicas were deleted, and it "
                  "is worth knowing why it was able to: a leader releases its lease on "
                  "graceful shutdown and the SDK flushes that final export, so the gauge "
                  "genuinely reached 0. A replica killed outright leaves it held at 1. "
                  "Do not read a departure off this panel -- read it off Workers missing "
                  "on SKP Flow.",
             thresholds=T_EXACTLY_ONE, decimals=0),
    ]
    panels += v[2:]

    panels.append(row(lay, "2 - Pipeline: what is broken?"))
    panels += pipeline_shared(lay, f, role_f=rf)
    panels += [
        timeseries(lay, "Leader by replica",
                   [(f'{live(f"pipeline_leader_ratio{{{f}}}")}',
                     "{{service_instance_id}}")],
                   desc="Explains why cron fires land on one replica. Only cron fires "
                        "are fenced by leadership.",
                   minv=0, maxv=1, decimals=0, fill=20),
        timeseries(lay, "Hydration admitted by replica",
                   [(f'{live(f"pipeline_hydration_admitted_ratio{{{f}}}")}',
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
             [f'min({live(f"pipeline_identity_ready_ratio{{{f}}}")}) or vector(0)'],
             desc="0 means the pod is up and waiting for a processor row whose "
                  "SourceHash matches its image. Running / NotReady with 0 restarts is "
                  "the designed behaviour, not a crash loop -- this is the metric that "
                  "makes that legible.",
             thresholds=T_POSTURE, decimals=0),
        stat(lay, "Duplicates suppressed",
             [counted(f'pipeline_duplicate_suppressed_total{{{f}}}')],
             desc="Deliveries acked having done no work, because the entry was already "
                  "absent. The primary idempotence mechanism; invisible under "
                  "disposition=acked. Rare is fine, frequent is a question.",
             thresholds=T_WARN, decimals=0),
    ]
    panels += v[2:]

    panels.append(row(lay, "2 - Pipeline: what is broken?"))
    panels += pipeline_shared(lay, f)
    panels += [
        timeseries(lay, "Process duration p95 / p99 by outcome",
                   [(f'histogram_quantile(0.95, sum by (le,outcome) '
                     f'(rate(pipeline_process_duration_seconds_bucket{{{f}}}'
                     f'[$__rate_interval])))', "p95 {{outcome}}"),
                    (f'histogram_quantile(0.99, sum by (le,outcome) '
                     f'(rate(pipeline_process_duration_seconds_bucket{{{f}}}'
                     f'[$__rate_interval])))', "p99 {{outcome}}"),
                    (f'sum by (outcome) (rate(pipeline_process_duration_seconds_sum'
                     f'{{{f}}}[$__rate_interval])) '
                     f'/ sum by (outcome) (rate(pipeline_process_duration_seconds_count'
                     f'{{{f}}}[$__rate_interval]))', "mean {{outcome}}")],
                   desc="The author's own transform -- the only span here whose length "
                        "is somebody's implementation rather than this framework's "
                        "constant cost. returned vs faulted keeps a slow success and a "
                        "slow failure from averaging into a number describing neither."
                        + PARA + "The mean rides alongside the quantiles as a "
                        "bucket-independent cross-check, for the same reason it does on "
                        "the produce-duration panel.",
                   unit="s"),
        timeseries(lay, "Identity ready by replica",
                   [(f'{live(f"pipeline_identity_ready_ratio{{{f}}}")}',
                     "{{service_instance_id}}")],
                   desc="One line per replica that is still reporting." + PARA +
                        "Unrestricted, this panel GAINS series during a rollout: the "
                        "departed replicas are held by the collector and Prometheus while "
                        "their replacements start exporting, so two live processors "
                        "rendered as four lines all sitting at 1. A line that ends is a "
                        "replica that left.",
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

def normalize_imported():
    """Stamp the shared nav onto boards in this directory that are not generated here.

    skp-runtime.json is exported from the old provisioning ConfigMap rather than built by
    this script, and it arrived carrying the `skp` tag but no `links`. The tag put it in
    every other board's nav while the missing links left it with none of its own -- so
    clicking through to it stranded the reader with no way back, and only there. Nav is a
    property of the SET of boards, not of how any one of them was authored, so it is
    applied to whatever is in the directory.
    """
    generated = {"skp-flow", "skp-baseapi", "skp-orchestrator", "skp-processor"}
    for path in sorted(OUT.glob("*.json")):
        if path.stem in generated:
            continue
        board = json.loads(path.read_text(encoding="utf-8"))
        if board.get("links") == NAV:
            continue
        board["links"] = NAV
        if "skp" not in board.get("tags", []):
            board.setdefault("tags", []).append("skp")
        path.write_text(json.dumps(board, indent=2) + chr(10), encoding="utf-8")
        print(f"{path.relative_to(OUT.parent.parent)}  nav stamped (imported board)")


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

    normalize_imported()


if __name__ == "__main__":
    main()
