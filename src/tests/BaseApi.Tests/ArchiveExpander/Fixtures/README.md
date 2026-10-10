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

## Gzip

`named.csv.gz`, `unnamed.csv.gz`, `two-entries.tar.gz` — written by GNU gzip 1.13 / GNU tar, not
built in the tests, because .NET's `GZipStream` never writes FNAME or MTIME and the real tool's
default header is what an operator's files actually carry.

    printf 'id,name\n1,a\n' > report.csv
    touch -d '2026-09-08 10:58:00 UTC' report.csv
    gzip -c report.csv > named.csv.gz        # records FNAME report.csv and MTIME
    gzip -n -c report.csv > unnamed.csv.gz   # records neither
    printf 'id\n' > a.csv
    printf 'id,name\n' > b.csv
    tar --format=ustar -czf two-entries.tar.gz a.csv b.csv
