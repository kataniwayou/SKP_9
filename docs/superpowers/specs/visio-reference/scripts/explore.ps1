param([string]$dir)
$ErrorActionPreference = 'Stop'
$v = New-Object -ComObject Visio.InvisibleApp
$v.AlertResponse = 1   # answer every dialog with OK, never wait on one
$log = New-Object System.Collections.Generic.List[string]
function L($s) { $log.Add($s); Add-Content (Join-Path $dir 'progress.txt') $s }
Remove-Item (Join-Path $dir 'progress.txt') -ErrorAction SilentlyContinue
function mm($x) { [math]::Round($x * 25.4, 1) }
$doc = $v.Documents.AddEx('BASFLO_M.VSTX', 1, 0)
$st = $v.Documents.Item('BASFLO_M.vssx')
$procM = $st.Masters.ItemU('Process')
$conM = $st.Masters.ItemU('Dynamic connector')
$script:pageN = 0
function NewPage($name) {
  $script:pageN++
  $p = if ($script:pageN -eq 1) { $doc.Pages.Item(1) } else { $doc.Pages.Add() }
  $p.Name = $name
  $v.ActiveWindow.Page = $p
  # the template's own routing on every page (a new page copies the one before it)
  foreach ($k in @{ RouteStyle = '6'; LineRouteExt = '0'; AvenueSizeX = '15 mm'; AvenueSizeY = '15 mm'; BlockSizeX = '6.35 mm'; BlockSizeY = '6.35 mm' }.GetEnumerator()) { $p.PageSheet.CellsU($k.Key).FormulaU = $k.Value }
  L ""; L "=== $name ==="
  return $p
}
function Box($p, $text, $x, $y) { $s = $p.Drop($procM, $x, $y); $s.Text = $text; return $s }
function Wire($p, $a, $b, [int]$ap = -1, [int]$bp = -1) {
  $c = $p.Drop($conM, 0, 0)
  if ($ap -ge 0) { $c.CellsU('BeginX').GlueTo($a.CellsSRC(7, $ap, 0)) } else { $c.CellsU('BeginX').GlueTo($a.CellsSRC(1, 1, 0)) }
  if ($bp -ge 0) { $c.CellsU('EndX').GlueTo($b.CellsSRC(7, $bp, 0)) } else { $c.CellsU('EndX').GlueTo($b.CellsSRC(1, 1, 0)) }
  return $c
}
function NameOf($s) { if ($s.Text) { $s.Text } else { $s.NameU } }
function Glue($c) {
  $parts = @()
  foreach ($k in $c.Connects) {
    $kind = if ($k.ToPart -eq 3) { 'whole shape (dynamic glue)' } elseif ($k.ToPart -ge 100) { "point $($k.ToCell.Name) (static glue)" } else { "part $($k.ToPart) $($k.ToCell.Name)" }
    $parts += "$($k.FromCell.Name)->$(NameOf $k.ToSheet) $kind"
  }
  $g = if ($parts.Count -eq 0) { 'unglued (Connects)' } else { $parts -join '; ' }
  $b = $c.CellsU('BeginX').FormulaU; $e = $c.CellsU('EndX').FormulaU
  $fb = if ($b -match 'PNT|GLUE|PAR\(') { 'begin formula glued' } else { 'begin formula free' }
  $fe = if ($e -match 'PNT|GLUE|PAR\(') { 'end formula glued' } else { 'end formula free' }
  "$g [$fb, $fe] {BeginX=$b | EndX=$e}"
}
function Path($c) {
  $ox = $c.CellsU('PinX').ResultIU - $c.CellsU('LocPinX').ResultIU
  $oy = $c.CellsU('PinY').ResultIU - $c.CellsU('LocPinY').ResultIU
  $out = @()
  for ($g = 0; $g -lt $c.GeometryCount; $g++) {
    $sec = 10 + $g; $n = $c.RowCount($sec)
    for ($r = 1; $r -lt $n; $r++) {
      $rt = $c.RowType($sec, $r)
      if ($rt -eq 195) {
        # a polyline row: POLYLINE(xType, yType, x1, y1, ...) then its own X, Y; type 0 = a fraction of the width/height
        $f = $c.CellsSRC($sec, $r, 2).FormulaU -replace '^POLYLINE\(|\)$', ''
        $a = @($f -split ',' | ForEach-Object { $_.Trim() })
        $w = $c.CellsU('Width').ResultIU; $h = $c.CellsU('Height').ResultIU
        for ($i = 2; $i + 1 -lt $a.Count; $i += 2) {
          $px = [double]::Parse(($a[$i] -replace ' in',''), [Globalization.CultureInfo]::InvariantCulture); $py = [double]::Parse(($a[$i+1] -replace ' in',''), [Globalization.CultureInfo]::InvariantCulture)
          if ($a[0] -eq '0') { $px = $px * $w }; if ($a[1] -eq '0') { $py = $py * $h }
          $out += "L($(mm ($ox + $px)),$(mm ($oy + $py)))"
        }
        $out += "L($(mm ($ox + $c.CellsSRC($sec,$r,0).ResultIU)),$(mm ($oy + $c.CellsSRC($sec,$r,1).ResultIU)))"
        continue
      }
      $t = switch ($rt) { 138 { 'M' } 139 { 'L' } 140 { 'A' } default { "?$rt" } }
      $out += "$t($(mm ($ox + $c.CellsSRC($sec,$r,0).ResultIU)),$(mm ($oy + $c.CellsSRC($sec,$r,1).ResultIU)))"
    }
  }
  $out -join ' '
}
function Show($label, $c) { L ("  {0}: {1}`n      path(mm): {2}" -f $label, (Glue $c), (Path $c)) }
function In($x) { ([double]$x).ToString([Globalization.CultureInfo]::InvariantCulture) + ' in' }
function Shift($s, $x, $y) { $s.CellsU('PinX').FormulaU = (In $x); $s.CellsU('PinY').FormulaU = (In $y) }
function Box2($s) { "{0} at ({1},{2}) mm, {3}x{4}" -f (NameOf $s), (mm $s.CellsU('PinX').ResultIU), (mm $s.CellsU('PinY').ResultIU), (mm $s.CellsU('Width').ResultIU), (mm $s.CellsU('Height').ResultIU) }
function Sel($shapes) { $w = $v.ActiveWindow; $w.DeselectAll(); foreach ($s in $shapes) { $w.Select($s, 2) }; return $w.Selection }
function Export($p) { $p.Export((Join-Path $dir ("{0:00}-{1}.png" -f $script:pageN, ($p.Name -replace '[^\w]+','-')))) }
function Retry([scriptblock]$f) { for ($i = 0; $i -lt 20; $i++) { try { & $f; return } catch { if ($i -eq 19) { throw }; Start-Sleep -Milliseconds 400 } } }
function Exists($p, $id) { try { $null = $p.Shapes.ItemFromID($id); $true } catch { $false } }

try {
  # 1. glue kinds and moving a shape
  $p = NewPage 'glue and moves'
  $A = Box $p 'A' 3 6; $B = Box $p 'B' 6 6
  L ("  " + (Box2 $A) + " | " + (Box2 $B))
  $dyn = Wire $p $A $B; $dyn.Text = 'dynamic'
  $sta = Wire $p $A $B 1 0; $sta.Text = 'static'
  Show 'dynamic A->B' $dyn; Show 'static A.right->B.left' $sta
  Shift $B 3 3; L "  B moved straight below A (3,3 in)"; Show 'dynamic' $dyn; Show 'static' $sta
  Shift $B 0.5 6; L "  B moved to the left of A (0.5,6 in)"; Show 'dynamic' $dyn; Show 'static' $sta
  Shift $B 6 6; Export $p

  # 2. fan-out, fan-in, two wires between the same pair
  $p = NewPage 'fan-out fan-in parallel'
  $A = Box $p 'A' 1.5 6; $B = Box $p 'B' 4 7.5; $C = Box $p 'C' 4 4.5; $D = Box $p 'D' 6.5 6
  $ab = Wire $p $A $B; $ac = Wire $p $A $C; $bd = Wire $p $B $D; $cd = Wire $p $C $D
  Show 'A->B' $ab; Show 'A->C' $ac; Show 'B->D' $bd; Show 'C->D' $cd
  $ab2 = Wire $p $A $B; Show 'second A->B' $ab2
  $ab3 = Wire $p $A $B 1 0; $ab4 = Wire $p $A $B 1 0; Show 'static A.right->B.left #1' $ab3; Show 'static A.right->B.left #2' $ab4
  Export $p

  # 3. obstacles and crossings
  $p = NewPage 'obstacle and crossing'
  $A = Box $p 'A' 1 6; $O = Box $p 'Obstacle' 3.5 6; $B = Box $p 'B' 6 6
  $ob = Wire $p $A $B 1 0; Show 'A.right->B.left past an obstacle' $ob
  $T = Box $p 'Top' 3.5 8; $U = Box $p 'Bottom' 3.5 3.5
  $tu = Wire $p $T $U 2 3; Show 'Top.bottom->Bottom.top (vertical)' $tu
  Show 'A->B after the vertical wire' $ob
  Shift $O 3.5 7; L "  obstacle moved up 1 in"; Show 'A->B' $ob; Show 'Top->Bottom' $tu
  Export $p

  # 4. drop connected and AutoConnect
  $p = NewPage 'autoconnect'
  $A = Box $p 'A' 2 6
  try {
    $n = $p.DropConnected($procM, $A, 4)
    L ("  DropConnected right: new " + (Box2 $n) + " ; gap from A " + (mm ($n.CellsU('PinX').ResultIU - $A.CellsU('PinX').ResultIU - $A.CellsU('Width').ResultIU)) + " mm")
    foreach ($s in $p.Shapes) { if ($s.OneD) { Show 'its connector' $s } }
  } catch { L "  DropConnected: $($_.Exception.Message)" }
  $B = Box $p 'B' 2 2.5
  try {
    $A.AutoConnect($B, 0, $conM)
    foreach ($s in $p.Shapes) { if ($s.OneD -and (Glue $s) -match '->B') { Show 'AutoConnect A->B' $s } }
  } catch { L "  AutoConnect: $($_.Exception.Message)" }
  Export $p

  # 5. copy/paste and duplicate
  $p = NewPage 'copy paste'
  $A = Box $p 'A' 1.5 7; $B = Box $p 'B' 4 7; $ab = Wire $p $A $B
  $cases = @(
    @{ name = 'wire alone'; sel = @($ab) },
    @{ name = 'A and B, not the wire'; sel = @($A, $B) },
    @{ name = 'A, B and the wire'; sel = @($A, $B, $ab) },
    @{ name = 'A and the wire (not B)'; sel = @($A, $ab) }
  )
  foreach ($k in $cases) {
    $before = @(); foreach ($s in $p.Shapes) { $before += $s.ID }
    $sel = Sel $k.sel; L ("  selected: {0}" -f $sel.Count); $sel.Duplicate()
    $new = @(); foreach ($s in $p.Shapes) { if ($before -notcontains $s.ID) { $new += $s } }
    $wires = @($new | Where-Object { $_.OneD })
    L ("  duplicate (Ctrl+D, copy/paste without the clipboard) [{0}]: {1} new shapes ({2} wires)" -f $k.name, $new.Count, $wires.Count)
    foreach ($w in $wires) { Show 'pasted wire' $w }
    foreach ($s in $new) { if (-not $s.OneD) { L ("    pasted " + (Box2 $s)) } }
  }
  $before = @(); foreach ($s in $p.Shapes) { $before += $s.ID }
  $sel = Sel @($A, $B, $ab); $sel.Duplicate()
  $new = @(); foreach ($s in $p.Shapes) { if ($before -notcontains $s.ID) { $new += $s } }
  L ("  duplicate [A, B and the wire]: {0} new" -f $new.Count)
  foreach ($w in ($new | Where-Object { $_.OneD })) { Show 'duplicated wire' $w }
  Export $p

  # 6. deleting a shape with wires on it
  $p = NewPage 'delete'
  $A = Box $p 'A' 1.5 6; $B = Box $p 'B' 4 6; $C = Box $p 'C' 6.5 6
  $ab = Wire $p $A $B; $bc = Wire $p $B $C
  $ids = @($ab.ID, $bc.ID)
  $sel = Sel @($B); $sel.Delete()
  $left = @($ids | Where-Object { Exists $p $_ })
  L ("  B deleted with the selection's Delete (as the Delete key): wires on it left: {0} of 2" -f $left.Count)
  foreach ($id in $left) { Show 'kept wire' ($p.Shapes.ItemFromID($id)) }
  $D = Box $p 'D' 4 3; $ad = Wire $p $A $D; $adId = $ad.ID; $D.Delete()
  if (Exists $p $adId) { L "  D deleted by Shape.Delete (code): its wire kept"; Show 'kept wire' ($p.Shapes.ItemFromID($adId)) } else { L "  D deleted by Shape.Delete: its wire deleted too" }
  Export $p

  # 7. a wire onto a wire, and a shape dropped on a wire
  $p = NewPage 'wire on wire, split'
  $A = Box $p 'A' 1.5 6; $B = Box $p 'B' 6 6; $ab = Wire $p $A $B
  $C = Box $p 'C' 3.75 3; $c2 = $p.Drop($conM, 0, 0); $c2.CellsU('BeginX').GlueTo($C.CellsSRC(1,1,0))
  try { $c2.CellsU('EndX').GlueTo($ab.CellsSRC(1,1,0)); L ("  wire end glued onto another wire's PinX: " + (Glue $c2)) } catch { L "  wire end onto another wire: refused ($($_.Exception.Message))" }
  L ("  connection points on a connector: " + $ab.RowCount(7))
  $before = $p.Shapes.Count
  $S = $p.Drop($procM, 3.75, 6); $S.Text = 'S'
  L ("  a Process dropped on the middle of A->B by code (Page.Drop): shapes {0} -> {1}; A->B now {2}" -f $before, $p.Shapes.Count, (Glue $ab))
  Export $p

  # 8. reroute policy (ConFixedCode)
  $p = NewPage 'reroute policy'
  foreach ($code in 0, 1, 2, 3) {
    $y = 8 - 1.8 * $code
    $A = Box $p "A$code" 1 $y; $B = Box $p "B$code" 4 ($y - 0.8)
    $c = Wire $p $A $B; $c.CellsU('ConFixedCode').FormulaU = "$code"
    $pre = Path $c
    Shift $B 5.5 ($y + 0.4)
    L ("  ConFixedCode={0}: before {1}`n      after B moved: {2}" -f $code, $pre, (Path $c))
  }
  Export $p

  # 9. route styles of the page
  $p = NewPage 'route styles'
  foreach ($style in 1, 2, 16, 6) {
    $p.PageSheet.CellsU('RouteStyle').FormulaU = "$style"
    $A = Box $p "A" 1 7; $B = Box $p "B" 4 5; $c = Wire $p $A $B
    L ("  page RouteStyle={0}: {1}" -f $style, (Path $c))
    $c.Delete(); $A.Delete(); $B.Delete()
  }
  $p.PageSheet.CellsU('RouteStyle').FormulaU = '6'
  $p.PageSheet.CellsU('LineRouteExt').FormulaU = '2'
  $A = Box $p "A" 1 7; $B = Box $p "B" 4 5; $c = Wire $p $A $B
  L ("  LineRouteExt=2 (curved): {0}" -f (Path $c))
  Export $p

  # 10. layout
  $p = NewPage 'layout'
  $A = Box $p 'A' 1 2; $B = Box $p 'B' 5 7; $C = Box $p 'C' 2.5 5; $D = Box $p 'D' 6 3
  $null = Wire $p $A $B; $null = Wire $p $A $C; $null = Wire $p $C $D
  L "  before layout: $(Box2 $A) | $(Box2 $B) | $(Box2 $C) | $(Box2 $D)"
  $p.Layout()
  L "  after Page.Layout (flowchart top to bottom): $(Box2 $A) | $(Box2 $B) | $(Box2 $C) | $(Box2 $D)"
  foreach ($s in $p.Shapes) { if ($s.OneD) { Show 'wire' $s } }
  Export $p

  # 11. getting past components
  $p = NewPage 'overtaking'
  $A = Box $p 'A' 0.8 8; $O = Box $p 'O' 3.5 8; $B = Box $p 'B' 6.2 8
  $c = Wire $p $A $B 1 0; Show 'one shape in the way (A.right->B.left)' $c
  L ("  shape O: top edge at {0} mm, bottom at {1} mm" -f (mm (8 + $O.CellsU('Height').ResultIU / 2)), (mm (8 - $O.CellsU('Height').ResultIU / 2)))
  $c.Delete(); $c = Wire $p $A $B; Show 'same, dynamic glue (Visio picks the sides)' $c
  $A2 = Box $p 'A2' 0.8 5; $W1 = Box $p 'W1' 3.5 5; $W2 = Box $p 'W2' 3.5 5.6; $W3 = Box $p 'W3' 3.5 4.4; $B2 = Box $p 'B2' 6.2 5
  $c = Wire $p $A2 $B2 1 0; Show 'a wall of three shapes in the way' $c
  $A3 = Box $p 'A3' 5 2.2; $B3 = Box $p 'B3' 2 2.2
  $c = Wire $p $A3 $B3 1 0; Show 'target behind the start (A3.right->B3.left, B3 left of A3)' $c
  $c2 = Wire $p $A3 $B3; Show 'same pair, dynamic glue' $c2
  Export $p
  $p = NewPage 'tight gap and avenue size'
  $A = Box $p 'A' 0.8 6; $B = Box $p 'B' 6.2 6
  $G1 = Box $p 'G1' 3.5 6.45; $G2 = Box $p 'G2' 3.5 5.55
  L ("  G1/G2 gap between them: {0} mm" -f (mm (($G1.CellsU('PinY').ResultIU - $G1.CellsU('Height').ResultIU / 2) - ($G2.CellsU('PinY').ResultIU + $G2.CellsU('Height').ResultIU / 2))))
  $c = Wire $p $A $B 1 0; Show 'through or around a narrow gap' $c
  Shift $G1 3.5 6.6; Shift $G2 3.5 5.4
  L ("  gap widened to {0} mm" -f (mm (($G1.CellsU('PinY').ResultIU - $G1.CellsU('Height').ResultIU / 2) - ($G2.CellsU('PinY').ResultIU + $G2.CellsU('Height').ResultIU / 2))))
  Show 'wider gap' $c
  $O = Box $p 'O' 3.5 3; $A4 = Box $p 'A4' 0.8 3; $B4 = Box $p 'B4' 6.2 3
  $c4 = Wire $p $A4 $B4 1 0; Show 'around one shape, page AvenueSize 15 mm' $c4
  $p.PageSheet.CellsU('AvenueSizeX').FormulaU = '40 mm'; $p.PageSheet.CellsU('AvenueSizeY').FormulaU = '40 mm'
  Shift $B4 6.2 3.01; Shift $B4 6.2 3
  Show 'same, AvenueSize 40 mm' $c4
  $p.PageSheet.CellsU('BlockSizeX').FormulaU = '20 mm'; $p.PageSheet.CellsU('BlockSizeY').FormulaU = '20 mm'
  Shift $B4 6.2 3.01; Shift $B4 6.2 3
  Show 'same, BlockSize 20 mm' $c4
  Export $p

  # 12. zoom
  $p = NewPage 'zoom'
  $A = Box $p 'A' 1 7; $O = Box $p 'O' 3.5 6.5; $B = Box $p 'B' 6 6
  $c = Wire $p $A $B 1 0
  foreach ($z in [double[]](0.25, 0.5, 1, 2, 4)) {
    $v.ActiveWindow.Zoom = $z
    Shift $B 6 6.01; Shift $B 6 6
    L ("  zoom {0}%: {1}" -f ($z * 100), (Path $c))
  }
  $v.ActiveWindow.Zoom = [double]1
  Export $p

  # 13. labels
  $p = NewPage 'labels'
  $A = Box $p 'A' 1 7; $B = Box $p 'B' 5 5.5
  $c = Wire $p $A $B; $c.Text = 'yes'
  function TextAt($c) {
    $ox = $c.CellsU('PinX').ResultIU - $c.CellsU('LocPinX').ResultIU; $oy = $c.CellsU('PinY').ResultIU - $c.CellsU('LocPinY').ResultIU
    "label centre ({0},{1}) mm; TxtPinX={2} TxtPinY={3}; background={4}" -f (mm ($ox + $c.CellsU('TxtPinX').ResultIU)), (mm ($oy + $c.CellsU('TxtPinY').ResultIU)), $c.CellsU('TxtPinX').FormulaU, $c.CellsU('TxtPinY').FormulaU, $c.CellsU('TextBkgnd').FormulaU
  }
  L ("  label 'yes': " + (TextAt $c)); Show 'its wire' $c
  Shift $B 5 3.5; L ("  B moved down 2 in: " + (TextAt $c)); Show 'its wire' $c
  try {
    $n = $c.RowCount(9); L "  control handles on the connector: $n"
    for ($r = 0; $r -lt $n; $r++) { L ("    {0}: X={1} Y={2}" -f $c.CellsSRC(9,$r,0).Name, $c.CellsSRC(9,$r,0).FormulaU, $c.CellsSRC(9,$r,1).FormulaU) }
    $c.CellsSRC(9,0,0).FormulaU = '"' + '0' + '"' -replace '"',''
  } catch { L "  controls: $($_.Exception.Message)" }
  # the label dragged off the line by hand: its handle set to a point 20 mm right of where it was
  try {
    $tx = $c.CellsU('Controls.TextPosition').ResultIU; $ty = $c.CellsU('Controls.TextPosition.Y').ResultIU
    $c.CellsU('Controls.TextPosition').FormulaU = (In ($tx + 0.8)); $c.CellsU('Controls.TextPosition.Y').FormulaU = (In $ty)
    L ("  label dragged 20 mm right by its handle: " + (TextAt $c))
    Shift $B 6 2.5; L ("  then B moved again: " + (TextAt $c)); Show 'its wire' $c
  } catch { L "  label handle: $($_.Exception.Message)" }
  Export $p

  # 14. overlaps, shared points, crossings and the diagram check
  $p = NewPage 'overlaps and checks'
  $T = Box $p 'T' 6 7
  $S1 = Box $p 'S1' 1 7.6; $S2 = Box $p 'S2' 1 6.4
  $w1 = Wire $p $S1 $T 1 0; $w2 = Wire $p $S2 $T 1 0
  Show 'S1.right->T.left' $w1; Show 'S2.right->T.left (the same point of T)' $w2
  $O = Box $p 'O' 3.5 4
  $P1 = Box $p 'P1' 1 4.15; $Q1 = Box $p 'Q1' 6 4.15; $P2 = Box $p 'P2' 1 3.85; $Q2 = Box $p 'Q2' 6 3.85
  $x1 = Wire $p $P1 $Q1 1 0; $x2 = Wire $p $P2 $Q2 1 0
  Show 'P1->Q1 past O' $x1; Show 'P2->Q2 past O (do they share a track?)' $x2
  $L1 = Box $p 'Loop' 3.5 1.5; $self = Wire $p $L1 $L1 1 0; Show 'a shape wired to itself (right->left)' $self
  $free = $p.Drop($conM, 1, 1); $free.CellsU('BeginX').GlueTo($S1.CellsSRC(7,2,0)); $free.CellsU('EndX').FormulaU = '2 in'; $free.CellsU('EndY').FormulaU = '0.5 in'
  Show 'a wire with one end free' $free
  $alone = Box $p 'Alone' 6 1.5
  try {
    $val = $doc.Validation
    $names = @(); foreach ($rs in $val.RuleSets) { $names += "$($rs.NameU) ($($rs.Rules.Count) rules)" }
    L ("  diagram check rule sets: " + ($names -join ', '))
    $rs1 = $null; foreach ($rs in $val.RuleSets) { $rs1 = $rs; break }; $val.Validate($rs1, 0)
    L ("  Check Diagram found {0} issues:" -f $val.Issues.Count)
    foreach ($i in $val.Issues) { $on = try { NameOf $i.TargetShape } catch { '-' }; L ("    [{0}] {1} on {2}" -f $i.Rule.NameU, $i.Rule.Description, $on) }
  } catch { L "  diagram check: $($_.Exception.Message)" }
  Export $p

  $doc.SaveAs((Join-Path $dir 'visio-connector-exploration.vsdx'))
} catch { L "FAILED: $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)" }
finally { $log | Set-Content (Join-Path $dir 'findings.txt'); $v.Quit() }
