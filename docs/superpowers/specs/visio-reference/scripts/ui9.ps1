param([string]$dir)
# Plan 10 phase 6 (2026-10-22): Visio's AutoConnect arrows, measured with the real mouse. One guarded run on a visible
# Visio of our own (as ui7, ui8): every mouse or key event first checks that this Visio is the foreground window, and the
# run stops at once if it is not (no input ever goes to another window). Names: PowerShell variables are case-insensitive,
# so shapes are $sA, $sB, ... and connectors $k1, ...; `Where` is an alias, so the position printer is Spot.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
}
'@
[W]::SetProcessDPIAware() | Out-Null
$notes = Join-Path $dir 'ui9.txt'; Remove-Item $notes -ErrorAction SilentlyContinue
function N($s) { Add-Content $notes $s }

$v = New-Object -ComObject Visio.Application
$doc = $v.Documents.AddEx('BASFLO_M.VSTX', 1, 0)
$hwnd = [IntPtr]$v.WindowHandle32
$st = $v.Documents.Item('BASFLO_M.vssx'); $procM = $st.Masters.ItemU('Process'); $conM = $st.Masters.ItemU('Dynamic connector')
$win = $v.ActiveWindow; $page = $win.Page

function Front() {
  $me = [W]::GetCurrentThreadId(); $fg = [W]::GetForegroundWindow(); $t = [W]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  [W]::AttachThreadInput($me, $t, $true) | Out-Null
  [W]::ShowWindow($hwnd, 3) | Out-Null; [W]::BringWindowToTop($hwnd) | Out-Null; [W]::SetForegroundWindow($hwnd) | Out-Null
  [W]::AttachThreadInput($me, $t, $false) | Out-Null
  Start-Sleep -Milliseconds 400
}
function Guard() { if ([W]::GetForegroundWindow() -ne $hwnd) { Front; if ([W]::GetForegroundWindow() -ne $hwnd) { throw 'STOPPED: our Visio is not the foreground window; no input sent' } } }
function MoveTo($x, $y) { Guard; [W]::SetCursorPos([int]$x, [int]$y) | Out-Null }
function Down($x, $y) { MoveTo $x $y; Start-Sleep -Milliseconds 120; Guard; [W]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 150 }
function Up() { Guard; [W]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 800 }
function Glide($x0, $y0, $x1, $y1, $n = 20) { for ($i = 1; $i -le $n; $i++) { MoveTo ($x0 + ($x1 - $x0) * $i / $n) ($y0 + ($y1 - $y0) * $i / $n); Start-Sleep -Milliseconds 25 }; Start-Sleep -Milliseconds 500 }
function Click($x, $y) { Down $x $y; Up }
function Grab($x, $y, $w, $h) { $b = New-Object System.Drawing.Bitmap $w, $h; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($x, $y, 0, 0, $b.Size); $g.Dispose(); $b }
function Shot($name, $x, $y, $w, $h) { $b = Grab $x $y $w $h; $b.Save((Join-Path $dir "ui9-$name.png")); $b.Dispose() }
$mm = { param($in) [math]::Round($in * 25.4, 1) }

try {
  Front
  $win.Zoom = [double]1
  # calibration exactly as ui7/ui8: A (2,7), B (5,6), the view at (3.5, 6.3)
  $sA = $page.Drop($procM, 2, 7); $sB = $page.Drop($procM, 5, 6)
  $win.ScrollViewTo([double]3.5, [double]6.3); $win.DeselectAll(); Start-Sleep -Seconds 1
  $scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = Grab 0 0 $scr.Width $scr.Height
  function Blob($bmp, $xa, $xb) { $mnx = 1e9; $mxx = -1; $mny = 1e9; $mxy = -1; for ($i = $xa; $i -lt $xb; $i += 2) { for ($j = 200; $j -lt $bmp.Height - 60; $j += 2) { $c = $bmp.GetPixel($i, $j); if ([math]::Abs($c.R - 68) -lt 10 -and [math]::Abs($c.G - 114) -lt 10 -and [math]::Abs($c.B - 196) -lt 10) { if ($i -lt $mnx) { $mnx = $i }; if ($i -gt $mxx) { $mxx = $i }; if ($j -lt $mny) { $mny = $j }; if ($j -gt $mxy) { $mxy = $j } } } }; @($mnx, $mxx, $mny, $mxy) }
  $boxA = Blob $bmp 360 1150; $boxB = Blob $bmp 1150 1900; $bmp.Dispose()
  $k = ($boxB[0] + $boxB[1] - $boxA[0] - $boxA[1]) / 2 / 3.0
  $ax = ($boxA[0] + $boxA[1]) / 2; $ay = ($boxA[2] + $boxA[3]) / 2
  function S($xin, $yin) { @([int]($ax + ($xin - 2) * $k), [int]($ay - ($yin - 7) * $k)) }
  N ("calibration: A box px {0}; B box px {1}; {2:N1} px per inch" -f ($boxA -join ','), ($boxB -join ','), $k)
  $w = $sA.CellsU('Width').ResultIU; $h = $sA.CellsU('Height').ResultIU
  $view = @(($ax - 300), ($ay - 260), 1300, 640)
  $empty = S 6.5 3.4
  N ("shape {0}x{1} mm; page AvenueSizeX={2} mm AvenueSizeY={3} mm" -f (& $mm $w), (& $mm $h), (& $mm $page.PageSheet.CellsU('AvenueSizeX').ResultIU), (& $mm $page.PageSheet.CellsU('AvenueSizeY').ResultIU))

  function Spot($s) { "{0} ({1},{2}) mm" -f $s.Text, (& $mm $s.CellsU('PinX').ResultIU), (& $mm $s.CellsU('PinY').ResultIU) }
  function All() { (@($page.Shapes) | Where-Object { -not $_.OneD } | ForEach-Object { Spot $_ }) -join '; ' }
  function Wires() {
    $o = @()
    foreach ($s in $page.Shapes) { if ($s.OneD) { $g = @(); foreach ($q in $s.Connects) { $g += "$($q.FromCell.Name)->$($q.ToSheet.Text) part $($q.ToPart)" }; $o += "[" + ($g -join ', ') + "]" } }
    $o -join ' '
  }
  function Picked() { (@($win.Selection) | ForEach-Object { if ($_.OneD) { 'a connector' } else { $_.Text } }) -join ', ' }
  # every 2D shape not named yet gets the next letter, so what a click made shows in the notes
  $script:nextName = [int][char]'N'
  function NameNew() { foreach ($s in $page.Shapes) { if (-not $s.OneD -and $s.Text -eq '') { $s.Text = [string][char]$script:nextName; $script:nextName++ } } }
  function Reset() { foreach ($s in @($page.Shapes)) { $s.Delete() }; $script:nextName = [int][char]'N'; $win.DeselectAll(); Start-Sleep -Milliseconds 500 }
  function Shape($name, $x, $y) { $s = $page.Drop($procM, $x, $y); $s.Text = $name; $s }
  function Wire($from, $to) { $c = $page.Drop($conM, 1, 1); $c.CellsU('BeginX').GlueTo($from.CellsSRC(1, 1, 0)); $c.CellsU('EndX').GlueTo($to.CellsSRC(1, 1, 0)); $c }

  # the arrows round a shape: hovered, the pixels that changed in a band round it, sorted to the side they are on
  function Arrows($s, $label) {
    $px = $s.CellsU('PinX').ResultIU; $py = $s.CellsU('PinY').ResultIU
    $c = S $px $py; $hw = [int]($w * $k / 2); $hh = [int]($h * $k / 2); $m = 70
    $rx = $c[0] - $hw - $m; $ry = $c[1] - $hh - $m; $rw = 2 * ($hw + $m); $rh = 2 * ($hh + $m)
    $win.DeselectAll(); MoveTo $empty[0] $empty[1]; Start-Sleep -Milliseconds 900
    $b0 = Grab $rx $ry $rw $rh
    MoveTo $c[0] $c[1]; Start-Sleep -Milliseconds 1500
    $b1 = Grab $rx $ry $rw $rh
    Shot "$label-hover" $view[0] $view[1] $view[2] $view[3]
    $sides = @{ left = @(); right = @(); up = @(); down = @() }
    for ($i = 0; $i -lt $rw; $i++) { for ($j = 0; $j -lt $rh; $j++) {
      $p0 = $b0.GetPixel($i, $j); $p1 = $b1.GetPixel($i, $j)
      if ([math]::Abs($p0.R - $p1.R) + [math]::Abs($p0.G - $p1.G) + [math]::Abs($p0.B - $p1.B) -lt 60) { continue }
      $x = $i + $rx; $y = $j + $ry
      if ($x -lt $c[0] - $hw) { $sides.left += , @($x, $y) } elseif ($x -gt $c[0] + $hw) { $sides.right += , @($x, $y) }
      elseif ($y -lt $c[1] - $hh) { $sides.up += , @($x, $y) } elseif ($y -gt $c[1] + $hh) { $sides.down += , @($x, $y) }
    } }
    $b0.Dispose(); $b1.Dispose()
    $out = @{}
    foreach ($d in 'left', 'right', 'up', 'down') {
      $pts = $sides[$d]
      if ($pts.Count -eq 0) { N ("{0}: {1} arrow: none seen" -f $label, $d); continue }
      $mx = ($pts | ForEach-Object { $_[0] } | Measure-Object -Average).Average; $my = ($pts | ForEach-Object { $_[1] } | Measure-Object -Average).Average
      $xs = $pts | ForEach-Object { $_[0] } | Measure-Object -Minimum -Maximum; $ys = $pts | ForEach-Object { $_[1] } | Measure-Object -Minimum -Maximum
      # how far its centre is outside the side, screen px and mm
      $off = switch ($d) { 'left' { ($c[0] - $hw) - $mx } 'right' { $mx - ($c[0] + $hw) } 'up' { ($c[1] - $hh) - $my } 'down' { $my - ($c[1] + $hh) } }
      N ("{0}: {1} arrow centre ({2:N0},{3:N0}) px, {4:N1} px ({5:N1} mm) outside the side, {6}x{7} px, {8} changed px" -f $label, $d, $mx, $my, $off, ($off / $k * 25.4), ($xs.Maximum - $xs.Minimum + 1), ($ys.Maximum - $ys.Minimum + 1), $pts.Count)
      $out[$d] = @([int]$mx, [int]$my)
    }
    $out
  }
  # hover shape $s, then its $d arrow (held, the preview and the toolbar shown), then click it
  function ClickArrow($s, $d, $label, $arrows) {
    $c = S ($s.CellsU('PinX').ResultIU) ($s.CellsU('PinY').ResultIU)
    $a = $arrows[$d]
    if ($null -eq $a) {
      # where ui3 found them: 0.2 in outside the middle of the side
      $px = $s.CellsU('PinX').ResultIU; $py = $s.CellsU('PinY').ResultIU
      $a = switch ($d) { 'left' { S ($px - $w / 2 - 0.2) $py } 'right' { S ($px + $w / 2 + 0.2) $py } 'up' { S $px ($py + $h / 2 + 0.2) } 'down' { S $px ($py - $h / 2 - 0.2) } }
    }
    $win.DeselectAll(); MoveTo $empty[0] $empty[1]; Start-Sleep -Milliseconds 600
    MoveTo $c[0] $c[1]; Start-Sleep -Milliseconds 1200
    Glide $c[0] $c[1] $a[0] $a[1] 10; Start-Sleep -Milliseconds 1200
    Shot "$label-arrow-held" $view[0] $view[1] $view[2] $view[3]
    $before = $page.Shapes.Count
    Click $a[0] $a[1]; Start-Sleep -Milliseconds 900
    NameNew
    Shot "$label-clicked" $view[0] $view[1] $view[2] $view[3]
    N ("{0}: {1} arrow of {2} clicked: shapes {3} -> {4}; {5}; wires {6}; picked: {7}" -f $label, $d, $s.Text, $before, $page.Shapes.Count, (All), (Wires), (Picked))
  }
  # press $s's $d arrow and drag it to page point ($tx, $ty) in
  function DragArrow($s, $d, $tx, $ty, $label, $arrows) {
    $c = S ($s.CellsU('PinX').ResultIU) ($s.CellsU('PinY').ResultIU)
    $a = $arrows[$d]
    $t = S $tx $ty
    $win.DeselectAll(); MoveTo $empty[0] $empty[1]; Start-Sleep -Milliseconds 600
    MoveTo $c[0] $c[1]; Start-Sleep -Milliseconds 1200
    Glide $c[0] $c[1] $a[0] $a[1] 10; Start-Sleep -Milliseconds 800
    $before = $page.Shapes.Count
    Down $a[0] $a[1]; Glide $a[0] $a[1] $t[0] $t[1] 25; MoveTo $t[0] $t[1]; Start-Sleep -Milliseconds 900
    Shot "$label-held" $view[0] $view[1] $view[2] $view[3]
    Up; Start-Sleep -Milliseconds 500
    NameNew
    Shot "$label-after" $view[0] $view[1] $view[2] $view[3]
    N ("{0}: {1} arrow of {2} dragged to ({3},{4}) mm: shapes {5} -> {6}; {7}; wires {8}; picked: {9}" -f $label, $d, $s.Text, (& $mm $tx), (& $mm $ty), $before, $page.Shapes.Count, (All), (Wires), (Picked))
  }

  $av = $page.PageSheet.CellsU('AvenueSizeX').ResultIU
  # 1. A alone: its arrows, then the right one clicked; then again (a second next shape); then the new one's right arrow
  Reset; $sA = Shape 'A' 2 7
  $arr = Arrows $sA 'alone'
  ClickArrow $sA 'right' 'alone-right' $arr
  ClickArrow $sA 'right' 'again-right' (Arrows $sA 'again')
  $n1 = @($page.Shapes) | Where-Object { $_.Text -eq 'N' } | Select-Object -First 1
  if ($n1) { ClickArrow $n1 'right' 'chain-right' (Arrows $n1 'chain') }
  # 2. the other three arrows of a shape alone
  foreach ($d in 'left', 'up', 'down') { Reset; $sA = Shape 'A' 3 6; ClickArrow $sA $d "alone-$d" (Arrows $sA "alone-$d") }
  # 3. a shape already in the way: one avenue right, level; four avenues right, level; one avenue right but half a shape lower
  Reset; $sA = Shape 'A' 2 7; $sB = Shape 'B' (2 + $w + $av) 7; ClickArrow $sA 'right' 'near-right' (Arrows $sA 'near')
  Reset; $sA = Shape 'A' 2 7; $sB = Shape 'B' (2 + $w + 4 * $av + $w) 7; ClickArrow $sA 'right' 'far-right' (Arrows $sA 'far')
  Reset; $sA = Shape 'A' 2 7; $sB = Shape 'B' (2 + $w + $av) (7 - $h / 2); ClickArrow $sA 'right' 'offset-right' (Arrows $sA 'offset')
  # 4. A wired to B already: the right arrow again
  Reset; $sA = Shape 'A' 2 7; $sB = Shape 'B' (2 + $w + $av) 7; $k1 = Wire $sA $sB; ClickArrow $sA 'right' 'wired-right' (Arrows $sA 'wired')
  # 5. the right arrow dragged: onto C (below right) and onto empty canvas
  Reset; $sA = Shape 'A' 2 7; $sC = Shape 'C' 4.5 5.4; DragArrow $sA 'right' 4.5 5.4 'drag-onto' (Arrows $sA 'drag')
  Reset; $sA = Shape 'A' 2 7; DragArrow $sA 'right' 4.5 5.4 'drag-empty' (Arrows $sA 'drag2')
  N 'done'
} catch { N "STOPPED: $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))" }
finally {
  foreach ($d in $v.Documents) { $d.Saved = $true }
  $v.Quit()
}
