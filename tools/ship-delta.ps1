<#
.SYNOPSIS
    Computes what has changed in the working tree since the last drop to ship/, stages only
    those files for transport, and (separately) advances ship/ once the drop has landed.

.DESCRIPTION
    ship/ is the offline machine's baseline: a copy of the buildable tree as it was at the last
    drop. It is deliberately untracked, so the delta cannot come from git -- the snapshot is not
    aligned to a commit boundary and never will be. It comes from comparing content.

    THE SCOPE IS EXPLICIT, NOT DISCOVERED. ship/ is a curated subset of the repository: grafana/
    contributes only dashboards, and nothing outside $Scope/$RootFiles is shipped at all. Walking
    the repository instead would sweep in audit scripts, node_modules and planning artifacts that
    have never been part of a drop.

    LINE-ENDING-ONLY DIFFERENCES ARE NOT CHANGES. Three files are CRLF in ship/ and LF in the
    working tree after an earlier rewrite; shipping them would move no code. Text files are
    compared with line endings normalised, binaries by bytes.

.PARAMETER Out
    Stage the delta into this directory, relative paths preserved, plus a MANIFEST.txt.
    Defaults to drops/<timestamp>/ inside the repository.

.PARAMETER Zip
    Also produce <Out>.zip -- the thing you actually carry to the offline machine.

.PARAMETER Commit
    Advance the baseline: copy every added/changed file into ship/. Run this ONLY after the drop
    has been applied on the other side. Removals are reported but never applied without
    -PruneRemoved.

.PARAMETER PruneRemoved
    With -Commit, also delete from ship/ the files that no longer exist in the working tree.

.EXAMPLE
    pwsh tools/ship-delta.ps1
    # list the delta, change nothing

.EXAMPLE
    pwsh tools/ship-delta.ps1 -Zip
    # stage it and produce the archive to carry across

.EXAMPLE
    pwsh tools/ship-delta.ps1 -Commit
    # the offline machine has it; ship/ becomes the new baseline
#>
[CmdletBinding()]
param(
    [string] $Root,
    [string] $Ship,
    [string] $Out,
    [switch] $Zip,
    [switch] $Commit,
    [switch] $PruneRemoved
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (-not $Ship) { $Ship = Join-Path $Root 'ship' }

if (-not (Test-Path -LiteralPath $Ship)) {
    throw "No baseline at $Ship. Nothing to compute a delta against."
}

# The shipped surface. Directories are walked recursively -- new files AND new subdirectories under
# them are picked up, which is what makes a new class like Orchestrator/Observability/Foo.cs ship
# without anyone remembering to add it here. grafana is listed as grafana/dashboards precisely so
# that the audit scripts beside it do NOT.
$Scope = @(
    'src'
    'k8s'
    'nugets'
    'grafana/dashboards'
)

$RootFiles = @(
    'Directory.Build.props'
    'Directory.Packages.props'
    'NuGet.config'
    'SK_P.sln'
    'global.json'
)

# Build output and editor state. Present in the working tree, never in a drop.
$ExcludeDirs = @('bin', 'obj', 'node_modules', '.vs', '.git', 'TestResults')

function Get-ShipFiles {
    param([string] $Base, [string] $Relative)

    $full = Join-Path $Base $Relative
    if (-not (Test-Path -LiteralPath $full)) { return @() }

    Get-ChildItem -LiteralPath $full -Recurse -File -Force |
        ForEach-Object {
            $rel = $_.FullName.Substring($Base.Length).TrimStart('\', '/') -replace '\\', '/'
            # Tested segment by segment rather than as a substring: a directory called "obj" is
            # excluded, a file called "object-map.cs" is not.
            $hit = @($rel -split '/' | Where-Object { $ExcludeDirs -contains $_ })
            if ($hit.Count -eq 0) { $rel }
        }
}

function Test-SameContent {
    param([string] $A, [string] $B)

    # A NUL byte in the first 8 KB is the binary test, and the probe is a 8 KB read rather than a
    # whole-file one so that nugets/ -- a hundred-odd multi-megabyte packages -- is classified
    # without being loaded into memory.
    $head = [byte[]]::new(8192)
    $fs = [System.IO.File]::OpenRead($A)
    try { $read = $fs.Read($head, 0, $head.Length) } finally { $fs.Dispose() }

    $binary = $false
    for ($i = 0; $i -lt $read; $i++) { if ($head[$i] -eq 0) { $binary = $true; break } }

    if ($binary) {
        # Length first: it settles a changed package without either file being hashed. Compare-Object
        # over the byte arrays was the obvious alternative and is slow enough on this folder alone to
        # push the whole run past two minutes.
        if ([System.IO.FileInfo]::new($A).Length -ne [System.IO.FileInfo]::new($B).Length) {
            return $false
        }
        return (Get-FileHash -LiteralPath $A -Algorithm SHA256).Hash -eq
               (Get-FileHash -LiteralPath $B -Algorithm SHA256).Hash
    }

    $ba = [System.IO.File]::ReadAllBytes($A)
    $bb = [System.IO.File]::ReadAllBytes($B)

    $ta = [System.Text.Encoding]::UTF8.GetString($ba) -replace "`r`n", "`n"
    $tb = [System.Text.Encoding]::UTF8.GetString($bb) -replace "`r`n", "`n"
    return $ta -ceq $tb
}

$rootFull = (Resolve-Path -LiteralPath $Root).Path
$shipFull = (Resolve-Path -LiteralPath $Ship).Path

$live = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$base = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

foreach ($s in $Scope) {
    foreach ($f in Get-ShipFiles -Base $rootFull -Relative $s) { [void]$live.Add($f) }
    foreach ($f in Get-ShipFiles -Base $shipFull -Relative $s) { [void]$base.Add($f) }
}
foreach ($f in $RootFiles) {
    if (Test-Path -LiteralPath (Join-Path $rootFull $f)) { [void]$live.Add($f) }
    if (Test-Path -LiteralPath (Join-Path $shipFull $f)) { [void]$base.Add($f) }
}

$added   = [System.Collections.Generic.List[string]]::new()
$changed = [System.Collections.Generic.List[string]]::new()
$removed = [System.Collections.Generic.List[string]]::new()

foreach ($rel in ($live | Sort-Object)) {
    if (-not $base.Contains($rel)) { $added.Add($rel); continue }
    if (-not (Test-SameContent (Join-Path $rootFull $rel) (Join-Path $shipFull $rel))) {
        $changed.Add($rel)
    }
}
foreach ($rel in ($base | Sort-Object)) {
    if (-not $live.Contains($rel)) { $removed.Add($rel) }
}

$toShip = @(@($added) + @($changed) | Sort-Object)

Write-Host ""
Write-Host "baseline : $shipFull"
Write-Host "working  : $rootFull"
Write-Host ""
foreach ($f in $added)   { Write-Host "  A  $f" -ForegroundColor Green }
foreach ($f in $changed) { Write-Host "  M  $f" -ForegroundColor Yellow }
foreach ($f in $removed) { Write-Host "  D  $f" -ForegroundColor Red }
Write-Host ""
Write-Host ("{0} added, {1} changed, {2} removed -- {3} file(s) to ship" -f
    $added.Count, $changed.Count, $removed.Count, $toShip.Count)

if ($removed.Count -gt 0 -and -not $PruneRemoved) {
    Write-Host "  (removals are reported only; -Commit -PruneRemoved applies them to ship/)" -ForegroundColor DarkGray
}

if ($toShip.Count -eq 0 -and $removed.Count -eq 0) { Write-Host ""; return }

# ---- stage ------------------------------------------------------------------------------------
if ($Out -or $Zip) {
    if (-not $Out) {
        $Out = Join-Path (Join-Path $rootFull 'drops') (Get-Date -Format 'yyyyMMdd-HHmmss')
    }
    New-Item -ItemType Directory -Force -Path $Out | Out-Null

    foreach ($rel in $toShip) {
        $dest = Join-Path $Out $rel
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
        Copy-Item -LiteralPath (Join-Path $rootFull $rel) -Destination $dest -Force
    }

    $head = & git -C $rootFull rev-parse --short HEAD 2>$null

    $manifest = [System.Collections.Generic.List[string]]::new()
    $manifest.Add("# ship delta $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
    $manifest.Add("# repo HEAD: $head")
    $manifest.Add("#")
    $manifest.Add("# Copy these over the offline tree, preserving paths. Then, back here, run")
    $manifest.Add("#   pwsh tools/ship-delta.ps1 -Commit")
    $manifest.Add("# so ship/ becomes the baseline for the next drop.")
    $manifest.Add("")
    foreach ($f in $added)   { $manifest.Add("A  $f") }
    foreach ($f in $changed) { $manifest.Add("M  $f") }
    foreach ($f in $removed) { $manifest.Add("D  $f   (delete on the offline tree)") }
    Set-Content -LiteralPath (Join-Path $Out 'MANIFEST.txt') -Value $manifest -Encoding UTF8

    Write-Host ""
    Write-Host "staged   : $Out"

    if ($Zip) {
        $zipPath = "$Out.zip"
        if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
        Compress-Archive -Path (Join-Path $Out '*') -DestinationPath $zipPath
        Write-Host "archive  : $zipPath"
    }
}

# ---- advance the baseline ---------------------------------------------------------------------
if ($Commit) {
    foreach ($rel in $toShip) {
        $dest = Join-Path $shipFull $rel
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
        Copy-Item -LiteralPath (Join-Path $rootFull $rel) -Destination $dest -Force
    }
    if ($PruneRemoved) {
        foreach ($rel in $removed) {
            Remove-Item -LiteralPath (Join-Path $shipFull $rel) -Force
        }
    }
    $pruned = if ($PruneRemoved) { ", $($removed.Count) removed" } else { "" }
    Write-Host ""
    Write-Host ("baseline advanced: {0} file(s) written to ship/{1}" -f $toShip.Count, $pruned) -ForegroundColor Cyan
}

Write-Host ""
