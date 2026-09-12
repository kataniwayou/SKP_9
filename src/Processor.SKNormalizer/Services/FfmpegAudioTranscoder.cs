using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;

namespace Processor.SKNormalizer;

/// <summary>
/// Runs ffmpeg over temp files. The ONLY place in this processor that starts a process.
/// </summary>
internal sealed partial class FfmpegAudioTranscoder(IOptions<SKNormalizerOptions> options)
    : IAudioTranscoder
{
    private readonly SKNormalizerOptions _options = options.Value;

    public NormalizedAudio Transcode(
        byte[] source, string sourceExtension, AudioProfile profile, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(profile);
        ct.ThrowIfCancellationRequested();

        var work = Path.Combine(Path.GetTempPath(), $"skn-{Guid.NewGuid():N}");
        Directory.CreateDirectory(work);

        var input = Path.Combine(work, $"in{Extension(sourceExtension)}");
        var output = Path.Combine(work, $"out{Extension(profile.TargetExtension)}");

        try
        {
            File.WriteAllBytes(input, source);

            var stderr = Run(BuildArguments(input, output, profile, source.Length > 0), ct);

            if (!File.Exists(output))
            {
                throw new NormalizationException(
                    $"the conversion produced no output file: {Tail(stderr)}");
            }

            var content = File.ReadAllBytes(output);

            return new NormalizedAudio(
                content,
                profile.TargetExtension,
                content.LongLength,
                Duration(stderr),
                Bitrate(stderr),
                Codec(stderr));
        }
        finally
        {
            // Best effort. A leaked temp directory is a disk problem an operator can see; throwing
            // from a finally would replace a real failure with a cleanup one.
            try
            {
                Directory.Delete(work, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    /// <summary>
    /// The handler's arguments, between the input and the output. <c>-y</c> overwrites and
    /// <c>-nostdin</c> stops ffmpeg blocking on a console this process does not have.
    /// </summary>
    private static List<string> BuildArguments(
        string input, string output, AudioProfile profile, bool hasInput)
    {
        var arguments = new List<string> { "-nostdin", "-y" };

        // A profile may name its own input (a lavfi source, for instance), in which case the temp
        // file is not one. Only supply -i when there are actually source bytes.
        if (hasInput)
        {
            arguments.Add("-i");
            arguments.Add(input);
        }

        arguments.AddRange(profile.Arguments);
        arguments.Add(output);

        return arguments;
    }

    private string Run(IReadOnlyList<string> arguments, CancellationToken ct)
    {
        var info = new ProcessStartInfo(_options.FfmpegPath)
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        foreach (var argument in arguments)
        {
            // ArgumentList, never a concatenated string: a file name carrying a space or a quote
            // would otherwise change the command's shape.
            info.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = info };

        try
        {
            process.Start();
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or FileNotFoundException)
        {
            // THE FIRST-DEPLOY FAILURE. An absent binary escaping as a Win32Exception would be
            // reported as an unhandled fault; as a business failure it names the path an operator
            // set, which is the fix.
            throw new NormalizationException(
                $"could not start '{_options.FfmpegPath}': {ex.Message}");
        }

        // Read before waiting: a full stderr pipe deadlocks a process that is still writing to it.
        var stderr = process.StandardError.ReadToEnd();
        _ = process.StandardOutput.ReadToEnd();

        if (!process.WaitForExit(TimeSpan.FromSeconds(_options.ConversionTimeoutSeconds)))
        {
            Kill(process);

            throw new NormalizationException(
                $"the conversion did not finish within {_options.ConversionTimeoutSeconds}s");
        }

        if (process.ExitCode != 0)
        {
            throw new NormalizationException(
                $"the conversion failed with exit code {process.ExitCode}: {Tail(stderr)}");
        }

        return stderr;
    }

    private static void Kill(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // Already gone between the timeout and the kill.
        }
    }

    /// <summary>
    /// The LAST few lines of ffmpeg's stderr, which is where its error actually is — the first
    /// several hundred are a build banner. Bounded because this reaches a FailedException message.
    /// </summary>
    private static string Tail(string stderr)
    {
        var lines = stderr.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        return lines.Length == 0 ? "no output" : string.Join(" | ", lines.TakeLast(3));
    }

    private static string Extension(string extension)
        => extension.StartsWith('.') ? extension : $".{extension}";

    private static TimeSpan? Duration(string stderr)
    {
        var match = DurationPattern().Match(stderr);

        return match.Success
               && TimeSpan.TryParse(match.Groups[1].Value, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;
    }

    private static int? Bitrate(string stderr)
    {
        var match = BitratePattern().Match(stderr);

        return match.Success
               && int.TryParse(match.Groups[1].Value, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;
    }

    private static string? Codec(string stderr)
    {
        var match = CodecPattern().Match(stderr);

        return match.Success ? match.Groups[1].Value : null;
    }

    // Parsed from stderr rather than by a second ffprobe run: one process per conversion, and the
    // numbers are already there. A null means the probe could not tell — stage 7 must not invent one.
    [GeneratedRegex(@"Duration:\s*(\d+:\d{2}:\d{2}\.\d+)")]
    private static partial Regex DurationPattern();

    [GeneratedRegex(@"bitrate:\s*(\d+)\s*kb/s")]
    private static partial Regex BitratePattern();

    [GeneratedRegex(@"Audio:\s*([a-zA-Z0-9_]+)")]
    private static partial Regex CodecPattern();
}
