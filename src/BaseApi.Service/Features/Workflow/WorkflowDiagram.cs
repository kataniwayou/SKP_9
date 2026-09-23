namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// The placeholder served for a workflow that has no published diagram.
/// <para>
/// <b>A placeholder rather than a 404, and that is the whole point of it.</b> The dashboard's panel
/// builds an image tag with deliberately empty alt text, so a missing image collapses to nothing at
/// all. Without this, "no operator has drawn this workflow" and "the API is unreachable" render
/// identically — an empty panel — and an operator has no way to tell a choice from an outage. A
/// placeholder that says so makes the two distinguishable: absence of the drawing is visible,
/// absence of the server is still blank.
/// </para>
/// <para>
/// <b>It is served, never stored.</b> Writing a copy into every unenriched row would duplicate it
/// across the table and turn changing this text into a data migration. The column stays null and
/// this is substituted at read time, so one edit here changes every unenriched workflow at once.
/// </para>
/// <para>
/// The tokens, type stack and 1580 viewBox width match the generated drawings exactly, so the panel
/// does not resize or change character when a workflow is enriched. <c>tools/verify-diagram-style.py</c>
/// asserts that, and this string is checked by it like any other drawing.
/// </para>
/// </summary>
internal static class WorkflowDiagram
{
    internal const string ContentType = "image/svg+xml";

    internal const string Placeholder = """
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1580 330" role="img"
     aria-label="No diagram published for this workflow">
  <style>
    :root {
      --fail: #A8481A;
      --fail-soft: rgba(168, 72, 26, 0.10);
      --ground: #EEF0EC;
      --ink: #191D1A;
      --mono: "IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;
      --muted: #667069;
      --ok: #0E6B5E;
      --ok-soft: rgba(14, 107, 94, 0.10);
      --rule: #D0D6CE;
      --rule-soft: #E1E6DF;
      --sans: "IBM Plex Sans Condensed", "Helvetica Neue", Arial, sans-serif;
      --serif: "IBM Plex Serif", Georgia, "Times New Roman", serif;
      --sheet: #FAFBF8;
    }
    .node-box { fill: var(--sheet); stroke: var(--rule); stroke-width: 1.4; }
    .legend-txt { fill: var(--muted); font-family: var(--sans); font-size: 12px; }
    .lbl-out { fill: var(--ink); font-family: var(--mono); font-size: 11px; }
  </style>
  <rect fill="var(--sheet)" x="0" y="0" width="1580" height="330"/>
  <rect class="node-box" x="40" y="40" width="1500" height="250" rx="4" stroke-dasharray="6 5"/>
  <text class="legend-txt" x="790" y="158" text-anchor="middle">No diagram published for this workflow</text>
  <text class="lbl-out" x="790" y="186" text-anchor="middle">PUT /api/v1/workflows/{id}/diagram</text>
</svg>
""";
}
