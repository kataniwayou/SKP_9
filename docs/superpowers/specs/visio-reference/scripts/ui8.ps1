param([string]$dir)
# Plan 10 phase 5 follow-up (2026-10-22): does Visio make room when a shape dropped on a connector splits it between two
# shapes close together? One guarded run on a visible Visio of our own (as ui7): every mouse or key event first checks
# that this Visio is the foreground window, and the run stops at once if it is not (no input ever goes to another window).
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
$notes = Join-Path $dir 'ui8.txt'; Remove-Item $notes -ErrorAction SilentlyContinue
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
function Up() { Guard; [W]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 700 }
function Glide($x0, $y0, $x1, $y1, $n = 20) { for ($i = 1; $i -le $n; $i++) { MoveTo ($x0 + ($x1 - $x0) * $i / $n) ($y0 + ($y1 - $y0) * $i / $n); Start-Sleep -Milliseconds 25 }; Start-Sleep -Milliseconds 500 }
function Click($x, $y) { Down $x $y; Up }
function Grab($x, $y, $w, $h) { $b = New-Object System.Drawing.Bitmap $w, $h; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($x, $y, 0, 0, $b.Size); $g.Dispose(); $b }
function Shot($name, $x, $y, $w, $h) { $b = Grab $x $y $w $h; $b.Save((Join-Path $dir "ui8-$name.png")); $b.Dispose() }
$mm = { param($in) [math]::Round($in * 25.4, 1) }

try {
  Front
  $win.Zoom = [double]1
  # calibration exactly as ui7: A (2,7), B (5,6), the view at (3.5, 6.3)
  $A = $page.Drop($procM, 2, 7); $A.Text = 'A'; $B = $page.Drop($procM, 5, 6); $B.Text = 'B'
  $win.ScrollViewTo([double]3.5, [double]6.3); $win.DeselectAll(); Start-Sleep -Seconds 1
  $scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = Grab 0 0 $scr.Width $scr.Height
  function Blob($bmp, $xa, $xb) { $mnx = 1e9; $mxx = -1; $mny = 1e9; $mxy = -1; for ($i = $xa; $i -lt $xb; $i += 2) { for ($j = 200; $j -lt $bmp.Height - 60; $j += 2) { $c = $bmp.GetPixel($i, $j); if ([math]::Abs($c.R - 68) -lt 10 -and [math]::Abs($c.G - 114) -lt 10 -and [math]::Abs($c.B - 196) -lt 10) { if ($i -lt $mnx) { $mnx = $i }; if ($i -gt $mxx) { $mxx = $i }; if ($j -lt $mny) { $mny = $j }; if ($j -gt $mxy) { $mxy = $j } } } }; @($mnx, $mxx, $mny, $mxy) }
  $boxA = Blob $bmp 360 1150; $boxB = Blob $bmp 1150 1900; $bmp.Dispose()
  $k = ($boxB[0] + $boxB[1] - $boxA[0] - $boxA[1]) / 2 / 3.0
  $ax = ($boxA[0] + $boxA[1]) / 2; $ay = ($boxA[2] + $boxA[3]) / 2
  function S($xin, $yin) { @([int]($ax + ($xin - 2) * $k), [int]($ay - ($yin - 7) * $k)) }
  N ("calibration: A box px {0}; B box px {1}; {2:N1} px per inch" -f ($boxA -join ','), ($boxB -join ','), $k)
  $w = $A.CellsU('Width').ResultIU
  $view = @(($ax - 300), ($ay - 260), 1300, 640)
  $empty = S 6.5 3.4

  # the settings that could make room or split: the page's plow and split cells, the Process master's
  N ("settings: page PlowCode={0} PageShapeSplit={1} PlaceStyle={2}; Process ShapePlowCode={3} ShapeSplittable={4} ShapeSplit={5}; app AutoConnect={6}" -f `
    $page.PageSheet.CellsU('PlowCode').ResultIU, $page.PageSheet.CellsU('PageShapeSplit').ResultIU, $page.PageSheet.CellsU('PlaceStyle').ResultIU, `
    $A.CellsU('ShapePlowCode').ResultIU, $A.CellsU('ShapeSplittable').ResultIU, $A.CellsU('ShapeSplit').ResultIU, $v.Settings.EnableAutoConnect)

  function Spot($s) { "{0} ({1},{2}) mm" -f $s.Text, (& $mm $s.CellsU('PinX').ResultIU), (& $mm $s.CellsU('PinY').ResultIU) }
  function Wires() {
    $o = @()
    foreach ($s in $page.Shapes) { if ($s.OneD) { $g = @(); foreach ($q in $s.Connects) { $g += "$($q.FromCell.Name)->$($q.ToSheet.Text)" }; $o += "[" + ($g -join ', ') + "]" } }
    $o -join ' '
  }

  N ("spacing: page AvenueSizeX={0} mm AvenueSizeY={1} mm BlockSizeX={2} mm BlockSizeY={3} mm LineToNodeX={4} mm; Process {5}x{6} mm" -f `
    (& $mm $page.PageSheet.CellsU('AvenueSizeX').ResultIU), (& $mm $page.PageSheet.CellsU('AvenueSizeY').ResultIU), (& $mm $page.PageSheet.CellsU('BlockSizeX').ResultIU), `
    (& $mm $page.PageSheet.CellsU('BlockSizeY').ResultIU), (& $mm $page.PageSheet.CellsU('LineToNodeX').ResultIU), (& $mm $w), (& $mm $A.CellsU('Height').ResultIU))
  $page.PageSheet.CellsU('PageWidth').FormulaU = '420 mm'

  # one scene: A, B, C, F in a row (y 7 in), `gap` (in) apart; wired A -> B -> C and B -> G (G lower right); F unwired in the
  # row past C; E unwired, lower right of the drop point; D below, dragged by the mouse onto A -> B, `at` of the way along
  function Scene($name, $gap, $at = 0.5) {
    foreach ($s in @($page.Shapes)) { $s.Delete() }
    $step = $w + $gap
    $script:A = $page.Drop($procM, 2, 7); $A.Text = 'A'
    $script:B = $page.Drop($procM, 2 + $step, 7); $B.Text = 'B'
    $script:C = $page.Drop($procM, 2 + 2 * $step, 7); $C.Text = 'C'
    $script:F = $page.Drop($procM, 2 + 3 * $step, 7); $F.Text = 'F'
    $script:G = $page.Drop($procM, 2 + 2 * $step, 5.4); $G.Text = 'G'
    $script:E = $page.Drop($procM, 2 + 1.5 * $step, 6.2); $E.Text = 'E'
    $con1 = $page.Drop($conM, 0, 0); $con1.CellsU('BeginX').GlueTo($A.CellsSRC(7, 1, 0)); $con1.CellsU('EndX').GlueTo($B.CellsSRC(1, 1, 0))
    $con2 = $page.Drop($conM, 1, 1); $con2.CellsU('BeginX').GlueTo($B.CellsSRC(1, 1, 0)); $con2.CellsU('EndX').GlueTo($C.CellsSRC(1, 1, 0))
    $con3 = $page.Drop($conM, 1, 2); $con3.CellsU('BeginX').GlueTo($B.CellsSRC(1, 1, 0)); $con3.CellsU('EndX').GlueTo($G.CellsSRC(1, 1, 0))
    $script:D = $page.Drop($procM, 2 + $step / 2, 4.2); $D.Text = 'D'
    $win.DeselectAll(); Start-Sleep -Milliseconds 800
    $all = { (@($A, $B, $C, $F, $G, $E, $D) | ForEach-Object { Spot $_ }) -join '; ' }
    N ("{0}: gap {1} mm, released {2} of the way from A's right to B's left; before: {3}" -f $name, (& $mm $gap), $at, (& $all))
    $from = S ($D.CellsU('PinX').ResultIU) ($D.CellsU('PinY').ResultIU)
    $to = S (2 + $w / 2 + $gap * $at) 7
    Click $empty[0] $empty[1]
    Down $from[0] $from[1]; Glide $from[0] $from[1] $to[0] $to[1] 25; MoveTo $to[0] $to[1]; Start-Sleep -Milliseconds 900
    Shot "$name-held" $view[0] $view[1] $view[2] $view[3]
    Up
    Click $empty[0] $empty[1]; Start-Sleep -Milliseconds 500
    Shot "$name-after" $view[0] $view[1] $view[2] $view[3]
    N ("{0}: after: {1}; wires {2}" -f $name, (& $all), (Wires))
  }

  # our layout gap scaled to Visio's shape (128 of a 224 px step), released in the middle and near B
  Scene 'narrow' ($w * 128 / 224)
  Scene 'narrow-nearB' ($w * 128 / 224) 0.85
  # a gap D just fits with nothing to spare on either side, and one with room
  Scene 'snug' ($w + 0.4)
  Scene 'wide' ($w * 3) 0.7
  # the page's avenue doubled: does D land further from A, and B get pushed further?
  $page.PageSheet.CellsU('AvenueSizeX').FormulaU = '30 mm'
  Scene 'avenue30' ($w * 128 / 224)
  N 'done'
} catch { N "STOPPED: $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))" }
finally {
  foreach ($d in $v.Documents) { $d.Saved = $true }
  $v.Quit()
}
