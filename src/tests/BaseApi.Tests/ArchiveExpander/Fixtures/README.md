# FileReader test fixtures

`three-entries.rar` — a.csv (3 bytes), b.csv (8 bytes), c.wav (12 bytes).

**This is the only test input in this repo that is not built from source, and the reason is
structural rather than convenience.** SharpCompress READS rar and cannot write one, and there is no
in-box or offline-feed writer either — so a test cannot construct a rar the way `ZipExtractorTests`
constructs a zip and `TarExtractorTests` constructs a tar.

Regenerate it with the WinRAR CLI:

    printf 'id\n' > a.csv
    printf 'id,name\n' > b.csv
    printf 'RIFFWAVEfake' > c.wav
    "C:\Program Files\WinRAR\Rar.exe" a -ep three-entries.rar a.csv b.csv c.wav

`-ep` stores bare names with no directory paths. If you regenerate with different content, update
the byte lengths asserted in `RarExtractorTests`.
