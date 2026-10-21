param([string]$dir)
# One guarded run on a visible Visio of our own: every mouse or key event first checks that this Visio is the foreground
# window, and the run stops at once if it is not (no input ever goes to another window).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [StructLayout(LayoutKind.Sequential)] public struct CI { public int cbSize; public int flags; public IntPtr h; public int x; public int y; }
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CI ci);
  [DllImport("user32.dll")] public static extern IntPtr LoadCursor(IntPtr inst, int id);
  [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
}
'@
[W]::SetProcessDPIAware() | Out-Null
$notes = Join-Path $dir 'ui5.txt'; Remove-Item $notes -ErrorAction SilentlyContinue
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
function Up() { Guard; [W]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 500 }
function Glide($x0, $y0, $x1, $y1, $n = 20) { for ($i = 1; $i -le $n; $i++) { MoveTo ($x0 + ($x1 - $x0) * $i / $n) ($y0 + ($y1 - $y0) * $i / $n); Start-Sleep -Milliseconds 25 }; Start-Sleep -Milliseconds 500 }
function Click($x, $y) { Down $x $y; Up }
function Key($vk) { Guard; [W]::keybd_event($vk, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60; [W]::keybd_event($vk, 0, 2, [IntPtr]::Zero); Start-Sleep -Milliseconds 300 }
function Grab($x, $y, $w, $h) { $b = New-Object System.Drawing.Bitmap $w, $h; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($x, $y, 0, 0, $b.Size); $g.Dispose(); $b }
function Shot($name, $x, $y, $w, $h) { $b = Grab $x $y $w $h; $b.Save((Join-Path $dir "ui5-$name.png")); $b.Dispose() }

# the cursor now: a standard one by name, or a picture of it (kept for the contact sheet)
$std = @{}; foreach ($k in @{ arrow = 32512; ibeam = 32513; cross = 32515; sizenwse = 32642; sizenesw = 32643; sizewe = 32644; sizens = 32645; sizeall = 32646; hand = 32649; no = 32648 }.GetEnumerator()) { $std[[string][W]::LoadCursor([IntPtr]::Zero, $k.Value)] = $k.Key }
$sheet = New-Object System.Collections.Generic.List[object]
function Cursor($label) {
  $ci = New-Object W+CI; $ci.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($ci); [W]::GetCursorInfo([ref]$ci) | Out-Null
  $name = $std[[string]$ci.h]; if (-not $name) { $name = "custom#$($ci.h)" }
  $bmp = New-Object System.Drawing.Bitmap 48, 48; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::White)
  $hdc = $g.GetHdc(); [W]::DrawIconEx($hdc, 0, 0, $ci.h, 48, 48, 0, [IntPtr]::Zero, 3) | Out-Null; $g.ReleaseHdc($hdc); $g.Dispose()
  $sheet.Add(@($label, $name, $bmp)); N ("cursor over {0}: {1}" -f $label, $name)
}
function Sheet() {
  $rows = $sheet.Count; $out = New-Object System.Drawing.Bitmap 520, ([math]::Max(1, $rows) * 60 + 10); $g = [System.Drawing.Graphics]::FromImage($out); $g.Clear([System.Drawing.Color]::White)
  $f = New-Object System.Drawing.Font 'Segoe UI', 11
  for ($i = 0; $i -lt $rows; $i++) { $r = $sheet[$i]; $g.DrawImage($r[2], 10, 6 + 60 * $i, 48, 48); $g.DrawString(("{0}  ({1})" -f $r[0], $r[1]), $f, [System.Drawing.Brushes]::Black, 70, 20 + 60 * $i) }
  $g.Dispose(); $out.Save((Join-Path $dir 'ui5-cursors.png')); $out.Dispose()
}

try {
  Front
  $win.Zoom = [double]1
  $A = $page.Drop($procM, 2, 7); $A.Text = 'A'; $B = $page.Drop($procM, 5, 6); $B.Text = 'B'
  $win.ScrollViewTo([double]3.5, [double]6.3); $win.DeselectAll(); Start-Sleep -Seconds 1
  # page -> screen from A's blue box (no wire on the page yet)
  $scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = Grab 0 0 $scr.Width $scr.Height
  function Blob($bmp, $xa, $xb) { $mnx = 1e9; $mxx = -1; $mny = 1e9; $mxy = -1; for ($i = $xa; $i -lt $xb; $i += 2) { for ($j = 200; $j -lt $bmp.Height - 60; $j += 2) { $c = $bmp.GetPixel($i, $j); if ([math]::Abs($c.R - 68) -lt 10 -and [math]::Abs($c.G - 114) -lt 10 -and [math]::Abs($c.B - 196) -lt 10) { if ($i -lt $mnx) { $mnx = $i }; if ($i -gt $mxx) { $mxx = $i }; if ($j -lt $mny) { $mny = $j }; if ($j -gt $mxy) { $mxy = $j } } } }; @($mnx, $mxx, $mny, $mxy) }
  $boxA = Blob $bmp 360 1150; $boxB = Blob $bmp 1150 1900; $bmp.Dispose()
  $k = ($boxB[0] + $boxB[1] - $boxA[0] - $boxA[1]) / 2 / 3.0      # px per inch from A's and B's centres, 3 in apart
  $ax = ($boxA[0] + $boxA[1]) / 2; $ay = ($boxA[2] + $boxA[3]) / 2
  function S($xin, $yin) { @([int]($ax + ($xin - 2) * $k), [int]($ay - ($yin - 7) * $k)) }
  N ("calibration: A box px {0}; B box px {1}; {2:N1} px per inch" -f ($boxA -join ','), ($boxB -join ','), $k)

  $c = $page.Drop($conM, 0, 0); $c.CellsU('BeginX').GlueTo($A.CellsSRC(7, 1, 0)); $c.CellsU('EndX').GlueTo($B.CellsSRC(1, 1, 0))
  Start-Sleep -Milliseconds 600
  function PathIn() { $o = @(); $ox = $c.CellsU('PinX').ResultIU - $c.CellsU('LocPinX').ResultIU; $oy = $c.CellsU('PinY').ResultIU - $c.CellsU('LocPinY').ResultIU; for ($r = 1; $r -lt $c.RowCount(10); $r++) { $o += , @(($ox + $c.CellsSRC(10, $r, 0).ResultIU), ($oy + $c.CellsSRC(10, $r, 1).ResultIU)) }; , $o }
  function Report($what) {
    $p = PathIn; $txt = @(); $right = $true
    for ($i = 0; $i -lt $p.Count; $i++) { $txt += "({0},{1})" -f [math]::Round($p[$i][0] * 25.4, 1), [math]::Round($p[$i][1] * 25.4, 1); if ($i -gt 0 -and [math]::Abs($p[$i][0] - $p[$i - 1][0]) -gt 1e-6 -and [math]::Abs($p[$i][1] - $p[$i - 1][1]) -gt 1e-6) { $right = $false } }
    $g = @(); foreach ($q in $c.Connects) { $g += "$($q.FromCell.Name)->$($q.ToSheet.Text) part $($q.ToPart)" }
    N ("{0}: path(mm) {1} | right angles: {2} | glue {3} | ConFixedCode {4} | B {5}x{6} mm at ({7},{8})" -f $what, ($txt -join ' '), $right, ($g -join ', '), $c.CellsU('ConFixedCode').ResultIU, [math]::Round($B.CellsU('Width').ResultIU * 25.4, 1), [math]::Round($B.CellsU('Height').ResultIU * 25.4, 1), [math]::Round($B.CellsU('PinX').ResultIU * 25.4, 1), [math]::Round($B.CellsU('PinY').ResultIU * 25.4, 1))
  }
  Report 'drawn'
  $view = @(($ax - 300), ($ay - 200), 1300, 640)
  Shot 'start' $view[0] $view[1] $view[2] $view[3]

  # A (2,7) stays; the wire and B go; B placed level with A, 2 in right; D below, to be dragged
  $c.Delete(); $B.CellsU('PinX').FormulaU = '4 in'; $B.CellsU('PinY').FormulaU = '7 in'
  $Dd = $page.Drop($procM, 5.5, 4.8); $Dd.Text = 'D'; $win.DeselectAll(); Start-Sleep -Milliseconds 600
  $gapIn = 4 - 2   # centre to centre, A to B
  N ("A at (2,7) in, B at (4,7) in: edge gap {0:N1} mm; D at (5.5,4.8) in, {1:N1} px per inch" -f (($gapIn - $A.CellsU('Width').ResultIU) * 25.4), $k)
  $empty = S 6.5 3.6
  function DragD($tx, $ty, $shot) {
    $from = S ($Dd.CellsU('PinX').ResultIU) ($Dd.CellsU('PinY').ResultIU)
    Click $empty[0] $empty[1]
    Down $from[0] $from[1]; Glide $from[0] $from[1] $tx $ty 25; MoveTo $tx $ty; Start-Sleep -Milliseconds 700
    if ($shot) { Shot $shot $view[0] $view[1] $view[2] $view[3] }
    Up
    $res = @($Dd.CellsU('PinX').ResultIU, $Dd.CellsU('PinY').ResultIU)
    $Dd.CellsU('PinX').FormulaU = '5.5 in'; $Dd.CellsU('PinY').FormulaU = '4.8 in'; Start-Sleep -Milliseconds 300
    , $res
  }
  # alignment: D released at x 7 in (no gap match), its centre `off` px below A's centre line
  foreach ($off in 3, 6, 10, 16) {
    $t = S 7 7; $r = DragD $t[0] ($t[1] + $off) $(if ($off -eq 6) { 'align-held-6px' } else { $null })
    N ("alignment: released {0} px below level with A -> D lands {1:N1} px below level ({2})" -f $off, ((7 - $r[1]) * $k), $(if ([math]::Abs($r[1] - 7) -lt 1e-6) { 'SNAPPED level' } else { 'not snapped' }))
  }
  # equal gaps: D level with A and B, released `off` px right of the spot that repeats A-B's gap (centre at 6 in)
  foreach ($off in 3, 6, 10, 16) {
    $t = S 6 7; $r = DragD ($t[0] + $off) $t[1] $(if ($off -eq 6) { 'gap-held-6px' } else { $null })
    N ("equal gap: released {0} px past the equal-gap spot -> D lands {1:N1} px past it ({2}); level: {3}" -f $off, (($r[0] - 6) * $k), $(if ([math]::Abs($r[0] - 6) -lt 1e-6) { 'SNAPPED to the equal gap' } else { 'not snapped' }), ([math]::Abs($r[1] - 7) -lt 1e-6))
  }
  # equal gaps, vertically: a column A (2,7) and E (2,5); D dragged below E near the repeat (2,3)
  $E = $page.Drop($procM, 2, 5); $E.Text = 'E'; Start-Sleep -Milliseconds 300
  $t = S 2 3; $r = DragD $t[0] ($t[1] + 6) 'gap-vertical-held-6px'
  N ("vertical equal gap: released 6 px past -> D lands {0:N1} px past ({1}); in line: {2}" -f ((3 - $r[1]) * $k), $(if ([math]::Abs($r[1] - 3) -lt 1e-6) { 'SNAPPED' } else { 'not snapped' }), ([math]::Abs($r[0] - 2) -lt 1e-6))
  # centred between two shapes: D dragged near the middle between A (2,7) and B (4,7), 1.2 in lower
  $t = S 3 5.8; $r = DragD ($t[0] + 6) $t[1] 'centre-between-held-6px'
  N ("between A and B, released 6 px off their middle -> D lands {0:N1} px off ({1})" -f (($r[0] - 3) * $k), $(if ([math]::Abs($r[0] - 3) -lt 1e-6) { 'SNAPPED to the middle' } else { 'not snapped' }))
  N 'done'
} catch { N "STOPPED: $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))" }
finally {
  try { Sheet } catch { }
  foreach ($d in $v.Documents) { $d.Saved = $true }
  $v.Quit()
}
