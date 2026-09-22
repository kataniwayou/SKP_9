<#
.SYNOPSIS
Refreshes the vendored ffmpeg that Processor.SKNormalizer's image carries.

.DESCRIPTION
THIS SCRIPT IS THE ONLY THING HERE THAT REACHES THE INTERNET, and it is deliberately not part of
any build. The image used to `apt-get install ffmpeg`, which put a network call in the one place
this repo refuses to have one -- NuGet.config clears nuget.org and restores from the offline
`nugets/` feed, and the image build had no equivalent. The binary is committed instead, so a build
on a disconnected machine works, and this script exists to update that committed copy from a
machine that does have a connection.

LGPL, NOT GPL, AND IT IS CHECKED RATHER THAN TRUSTED. SKNormalizer encodes mp3 through
libmp3lame, which is LGPL; the gpl variants bundle x264, x265 and xvid that no AudioProfile in this
solution names. The deployment is internal-only today, so neither licence obliges anything -- both
trigger on distribution, and FFmpeg is not AGPL, so running it in the cluster is not that. The
variant is pinned anyway because "internal-only" is a fact about today, and discovering a GPL
binary in the image the week someone decides to ship it is a bad week. The Dockerfile re-checks
the configure line at build time; see the RUN there.

THE PIN IS THE CHECKSUM, NOT THE URL. BtbN's `n8.1-latest` tag moves -- it is the latest build of
the 8.1 release branch, not one immutable artefact -- so the committed .sha256 is what makes the
vendored copy reproducible. A refresh that changes the binary changes that file, which is the diff
a reviewer should be looking at.

.PARAMETER Variant
The BtbN asset to take. Defaults to the 8.1 release branch, static, LGPL. Do not point this at a
`-shared` asset: those link against libraries that ship beside them, and the Dockerfile copies one
file. Do not point it at a `gpl` one either -- the build will refuse it.

.EXAMPLE
./tools/fetch-ffmpeg.ps1
#>
[CmdletBinding()]
param(
    [string]$Variant = 'ffmpeg-n8.1-latest-linux64-lgpl-8.1',
    [string]$Destination = 'vendor/ffmpeg/linux-x64'
)

$ErrorActionPreference = 'Stop'

$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$Variant.tar.xz"
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("ffmpeg-fetch-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null

try {
    $archive = Join-Path $work 'ffmpeg.tar.xz'
    Write-Host "downloading $Variant ..."
    Invoke-WebRequest -Uri $url -OutFile $archive

    # --strip-components lands bin/ffmpeg at the root of $work; tar on Windows 10+ is bsdtar and
    # handles .tar.xz without a separate xz.
    tar -xf $archive -C $work --strip-components=2 "$Variant/bin/ffmpeg"
    $binary = Join-Path $work 'ffmpeg'
    if (-not (Test-Path $binary)) { throw "the archive did not contain bin/ffmpeg" }

    $target = Join-Path (Get-Location) $Destination
    New-Item -ItemType Directory -Path $target -Force | Out-Null

    Copy-Item $binary (Join-Path $target 'ffmpeg') -Force

    # The checksum file the Dockerfile verifies. Written in sha256sum's own binary-mode format --
    # "<hash> *ffmpeg" -- because that is what `sha256sum` itself produced for the committed copy,
    # and `sha256sum -c` reads it from /usr/local/bin, where the file is a bare `ffmpeg`.
    $hash = (Get-FileHash (Join-Path $target 'ffmpeg') -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash *ffmpeg" | Set-Content -Path (Join-Path $target 'ffmpeg.sha256') -Encoding ascii

    Write-Host "vendored $Destination/ffmpeg"
    Write-Host "sha256   $hash"
    Write-Host ""
    Write-Host "Update vendor/ffmpeg/README.md with the version and configure line, then rebuild:"
    Write-Host "  docker build -f src/Processor.SKNormalizer/Dockerfile -t processor-sknormalizer:local ."
}
finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
