param([string]$dir)
$ErrorActionPreference = 'Stop'
$v = New-Object -ComObject Visio.InvisibleApp
$v.AlertResponse = 1
$out = Join-Path $dir 'progress2.txt'
Remove-Item $out -ErrorAction SilentlyContinue
function L($s) { Add-Content $out $s }
function mm($x) { [math]::Round($x * 25.4, 1) }
function In($x) { ([double]$x).ToString([Globalization.CultureInfo]::InvariantCulture) + ' in' }
$doc = $v.Documents.AddEx('BASFLO_M.VSTX', 1, 0)
$st = $v.Documents.Item('BASFLO_M.vssx')
$procM = $st.Masters.ItemU('Process'); $conM = $st.Masters.ItemU('Dynamic connector')
function Box($p, $t, $x, $y) { $s = $p.Drop($procM, $x, $y); $s.Text = $t; $s }
function Wire($p, $a, $b, [int]$ap = -1, [int]$bp = -1) {
  $c = $p.Drop($conM, 0, 0)
  if ($ap -ge 0) { $c.CellsU('BeginX').GlueTo($a.CellsSRC(7, $ap, 0)) } else { $c.CellsU('BeginX').GlueTo($a.CellsSRC(1, 1, 0)) }
  if ($bp -ge 0) { $c.CellsU('EndX').GlueTo($b.CellsSRC(7, $bp, 0)) } else { $c.CellsU('EndX').GlueTo($b.CellsSRC(1, 1, 0)) }
  $c
}
function NameOf($s) { if ($s.Text) { $s.Text } else { $s.NameU } }
function Glue($c) { $parts = @(); foreach ($k in $c.Connects) { $parts += "$($k.FromCell.Name)->$(NameOf $k.ToSheet)" }; if ($parts.Count) { $parts -join ', ' } else { 'unglued' } }
function Ends($c) { "begin ({0},{1}) end ({2},{3}) mm" -f (mm $c.CellsU('BeginX').ResultIU), (mm $c.CellsU('BeginY').ResultIU), (mm $c.CellsU('EndX').ResultIU), (mm $c.CellsU('EndY').ResultIU) }
function Shift($s, $x, $y) { $s.CellsU('PinX').FormulaU = (In $x); $s.CellsU('PinY').FormulaU = (In $y) }
function Retry([scriptblock]$f) { for ($i = 0; $i -lt 25; $i++) { try { & $f; return } catch { if ($i -eq 24) { throw }; Start-Sleep -Milliseconds 400 } } }
try {
  $p = $doc.Pages.Item(1); $v.ActiveWindow.Page = $p
  L '=== paste keeps glue? (real clipboard, then the pasted B moved) ==='
  $A = Box $p 'A' 1.5 7; $B = Box $p 'B' 4 7; $ab = Wire $p $A $B
  foreach ($case in @(@('A, B and the wire', @($A, $B, $ab)), @('the wire alone', @($ab)), @('A and the wire', @($A, $ab)))) {
    $before = @(); foreach ($s in $p.Shapes) { $before += $s.ID }
    $w = $v.ActiveWindow; $w.DeselectAll(); foreach ($s in $case[1]) { $w.Select($s, 2) }
    Retry { $w.Selection.Copy() }; Start-Sleep -Milliseconds 400; Retry { $w.Paste() }; Start-Sleep -Milliseconds 400
    $new = @(); foreach ($s in $p.Shapes) { if ($before -notcontains $s.ID) { $new += $s } }
    $nw = @($new | Where-Object { $_.OneD }); $nb = @($new | Where-Object { -not $_.OneD })
    L ("  copied [{0}]: pasted {1} shapes, {2} wires" -f $case[0], $nb.Count, $nw.Count)
    foreach ($x in $nw) {
      L ("    pasted wire: {0}; {1}" -f (Glue $x), (Ends $x))
      foreach ($y in $nb) { if ((NameOf $y) -eq 'B') { Shift $y ($y.CellsU('PinX').ResultIU) ($y.CellsU('PinY').ResultIU - 1); L ("    pasted B moved 25 mm down -> pasted wire {0}" -f (Ends $x)) } }
    }
    foreach ($y in $nb) { L ("    pasted {0} at ({1},{2}) mm" -f (NameOf $y), (mm $y.CellsU('PinX').ResultIU), (mm $y.CellsU('PinY').ResultIU)) }
  }

  L ''; L '=== Check Diagram (flowchart rules) ==='
  foreach ($rs in $doc.Validation.RuleSets) { foreach ($r in $rs.Rules) { L ("  [{0}] {1} (category {2})" -f $r.NameU, $r.Description, $r.Category) } }

  L ''; L '=== line jumps ==='
  $p2 = $doc.Pages.Add(); $p2.Name = 'jumps'; $v.ActiveWindow.Page = $p2
  $ps = $p2.PageSheet
  L ("  page LineJumpCode={0} LineJumpStyle={1} LineJumpFactorX={2} LineJumpFactorY={3}" -f $ps.CellsU('LineJumpCode').FormulaU, $ps.CellsU('LineJumpStyle').FormulaU, $ps.CellsU('LineJumpFactorX').FormulaU, $ps.CellsU('LineJumpFactorY').FormulaU)
  $H1 = Box $p2 'H1' 1 6; $H2 = Box $p2 'H2' 6 6; $V1 = Box $p2 'V1' 3.5 8; $V2 = Box $p2 'V2' 3.5 3.5
  $h = Wire $p2 $H1 $H2 1 0; $vv = Wire $p2 $V1 $V2 2 3
  function Arcs($c) { $n = 0; for ($g = 0; $g -lt $c.GeometryCount; $g++) { for ($r = 1; $r -lt $c.RowCount(10 + $g); $r++) { if ($c.RowType(10 + $g, $r) -eq 140) { $n++ } } }; $n }
  foreach ($code in 0, 1, 2, 3, 4) {
    $ps.CellsU('LineJumpCode').FormulaU = "$code"; Shift $V2 3.5 3.51; Shift $V2 3.5 3.5
    L ("  LineJumpCode={0}: arcs on the horizontal wire {1}, on the vertical wire {2}" -f $code, (Arcs $h), (Arcs $vv))
  }
  $ps.CellsU('LineJumpCode').FormulaU = '1'
  foreach ($style in 0, 1, 2, 3, 4, 5, 6) {
    $ps.CellsU('LineJumpStyle').FormulaU = "$style"; Shift $V2 3.5 3.51; Shift $V2 3.5 3.5
    $types = @(); for ($r = 1; $r -lt $h.RowCount(10); $r++) { $types += $h.RowType(10, $r) }
    L ("  LineJumpStyle={0}: horizontal wire row types {1}" -f $style, ($types -join ','))
  }
  $ps.CellsU('LineJumpStyle').FormulaU = '0'; Shift $V2 3.5 3.51; Shift $V2 3.5 3.5
  for ($r = 1; $r -lt $h.RowCount(10); $r++) { if ($h.RowType(10, $r) -eq 140) { L ("  arc row: end X {0} mm, bow A {1} mm (from {2} mm)" -f (mm ($h.CellsSRC(10,$r,0).ResultIU)), (mm ($h.CellsSRC(10,$r,2).ResultIU)), (mm ($h.CellsSRC(10,$r-1,0).ResultIU))) } }
  $p2.Export((Join-Path $dir '16-jumps.png'))

  L ''; L '=== arrows and direction ==='
  $p3 = $doc.Pages.Add(); $p3.Name = 'arrows'; $v.ActiveWindow.Page = $p3
  $A = Box $p3 'A' 1 6; $B = Box $p3 'B' 4 6; $c = Wire $p3 $A $B
  L ("  new wire: BeginArrow={0} ({1}) EndArrow={2} ({3}) EndArrowSize={4} LineWeight={5} LineColor={6} Rounding={7}" -f $c.CellsU('BeginArrow').FormulaU, $c.CellsU('BeginArrow').ResultIU, $c.CellsU('EndArrow').FormulaU, $c.CellsU('EndArrow').ResultIU, $c.CellsU('EndArrowSize').ResultIU, (mm $c.CellsU('LineWeight').ResultIU), $c.CellsU('LineColor').FormulaU, $c.CellsU('Rounding').FormulaU)
  L ("  end handles: begin glued at ({0},{1}) mm on A's right side; end on B's left side; drawn from A (begin) to B (end)" -f (mm $c.CellsU('BeginX').ResultIU), (mm $c.CellsU('BeginY').ResultIU))
  try { $v.ActiveWindow.DeselectAll(); $v.ActiveWindow.Select($c, 2); $v.ActiveWindow.Selection.ReverseEnds(); L ("  Reverse Ends: {0}; {1}" -f (Glue $c), (Ends $c)) } catch { L "  ReverseEnds: $($_.Exception.Message)" }
  $p3.Export((Join-Path $dir '17-arrows.png'))

  L ''; L '=== overlapping shapes and a wire between touching shapes ==='
  $p4 = $doc.Pages.Add(); $p4.Name = 'touching'; $v.ActiveWindow.Page = $p4
  $A = Box $p4 'A' 2 6; $B = Box $p4 'B' 2.95 6
  $c = Wire $p4 $A $B 1 0; L ("  A and B 0.6 mm apart, A.right->B.left: {0}" -f (Ends $c))
  $c2 = Wire $p4 $A $B; L ("  same pair, dynamic glue: {0}" -f (Ends $c2))
  $C = Box $p4 'C' 2 3; $D = Box $p4 'D' 2.3 3.1
  $c3 = Wire $p4 $C $D 1 0; L ("  C and D overlapping, C.right->D.left: {0}" -f (Ends $c3))
  $p4.Export((Join-Path $dir '18-touching.png'))
} catch { L "FAILED: $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)" }
finally { $doc.Saved = $true; $v.Quit() }
