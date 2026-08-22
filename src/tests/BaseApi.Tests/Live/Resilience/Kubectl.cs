using System.Diagnostics;
using System.Text;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// Runs kubectl and captures what it said.
/// <para>
/// <b>Shelling out is unavoidable here.</b> TcpForwarder — the lever the existing live tests use —
/// can only interpose on this process's own connections, never on the pods'. A fault that has to
/// reach a consumer running inside the cluster has to be applied inside the cluster.
/// </para>
/// </summary>
internal static class Kubectl
{
    private static readonly TimeSpan Budget = TimeSpan.FromMinutes(5);

    public static async Task<(int ExitCode, string Stdout, string Stderr)> RunAsync(
        CancellationToken ct, params string[] arguments)
    {
        ArgumentNullException.ThrowIfNull(arguments);

        var info = new ProcessStartInfo("kubectl")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        foreach (var argument in arguments)
        {
            info.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = info };
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();

        process.OutputDataReceived += (_, e) => { if (e.Data is not null) stdout.AppendLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) stderr.AppendLine(e.Data); };

        if (!process.Start())
        {
            throw new InvalidOperationException("kubectl did not start; is it on PATH?");
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(Budget);

        try
        {
            await process.WaitForExitAsync(budget.Token);
        }
        catch (OperationCanceledException)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // Already gone. Nothing to kill, and nothing worth failing a restore over.
            }

            throw;
        }

        return (process.ExitCode, stdout.ToString(), stderr.ToString());
    }

    /// <summary>Runs kubectl and throws when it fails, for steps whose failure must stop the scenario.</summary>
    public static async Task<string> RunOrThrowAsync(CancellationToken ct, params string[] arguments)
    {
        var (exitCode, stdout, stderr) = await RunAsync(ct, arguments);
        if (exitCode != 0)
        {
            throw new InvalidOperationException(
                $"kubectl {string.Join(' ', arguments)} exited {exitCode}: {stderr}");
        }

        return stdout;
    }
}
