$ErrorActionPreference = 'Stop'
$v = New-Object -ComObject Visio.InvisibleApp
try {
  "Visio $($v.Version) build $($v.Build)"
  $doc = $v.Documents.AddEx('BASFLO_M.VSTX', 1, 0)   # US units template, metric
  "doc: $($doc.Name)  stencils:"
  foreach ($d in $v.Documents) { "  $($d.Name) type $($d.Type)" }
  $st = $v.Documents | Where-Object { $_.Name -like 'BASFLO*S*' -or $_.Name -like '*SHAPES*' } | Select-Object -First 1
  "shapes stencil: $($st.Name)"
  foreach ($m in $st.Masters) { "  master: $($m.NameU)" }
  $page = $doc.Pages.Item(1)
  $proc = $page.Drop($st.Masters.ItemU('Process'), 2, 4)
  "Process size: W $($proc.CellsU('Width').ResultIU) in, H $($proc.CellsU('Height').ResultIU) in"
  $n = $proc.RowCount(7)   # connection points section
  "Process connection points: $n"
  for ($r = 0; $r -lt $n; $r++) { "  row $r : X=$($proc.CellsSRC(7,$r,0).FormulaU)  Y=$($proc.CellsSRC(7,$r,1).FormulaU)  type=$($proc.CellsSRC(7,$r,5).ResultIU)" }
  "Process glue/plow cells: GlueType=$($proc.CellsU('GlueType').ResultIU) ShapePlowCode=$($proc.CellsU('ShapePlowCode').ResultIU) ShapeRouteStyle=$($proc.CellsU('ShapeRouteStyle').ResultIU) ShapeSplittable=$($proc.CellsU('ShapeSplittable').ResultIU) ShapeSplit=$($proc.CellsU('ShapeSplit').ResultIU)"
  $c = $page.Drop($v.ConnectorToolDataObject, 5, 5)
  "Connector master: $($c.Master.NameU)  1-D: $($c.OneD)"
  foreach ($name in 'ShapeRouteStyle','ConFixedCode','ConLineJumpCode','ConLineJumpStyle','ConLineJumpDirX','ConLineRouteExt','GlueType','WalkPreference','BegTrigger','EndTrigger','ShapeSplittable','ObjType','BeginArrow','EndArrow','LayerMember') {
    try { "  connector $name = $($c.CellsU($name).FormulaU)" } catch { "  connector $name : n/a" }
  }
  $ps = $page.PageSheet
  foreach ($name in 'RouteStyle','LineRouteExt','LineJumpCode','LineJumpStyle','PageLineJumpDirX','PageLineJumpDirY','LineToNodeX','LineToNodeY','LineToLineX','LineToLineY','BlockSizeX','BlockSizeY','AvenueSizeX','AvenueSizeY','LineAdjustFrom','LineAdjustTo','PlaceStyle','PlaceDepth','PageShapeSplit','DynamicsOff','PlowCode','ResizePage','EnableGrid','CtrlAsInput','AvoidPageBreaks') {
    try { "  page $name = $($ps.CellsU($name).FormulaU)" } catch { "  page $name : n/a" }
  }
  "app settings:"
  $set = $v.Settings
  foreach ($p in ($set | Get-Member -MemberType Property | Where-Object { $_.Name -match 'Connect|Glue|Snap|Split|Delete|Dynamic|Grid|Route' })) { "  $($p.Name) = $($set.($p.Name))" }
  "glue settings (app.ActiveWindow? doc): GlueSettings=$($doc.GlueSettings) SnapSettings=$($doc.SnapSettings) SnapExtensions=$($doc.SnapExtensions) DynamicGridEnabled=$($doc.DynamicGridEnabled)"
  $doc.Saved = $true
} finally { $v.Quit() }
