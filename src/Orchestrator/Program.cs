using System.Runtime.InteropServices;
using Microsoft.Extensions.Hosting;
using Orchestrator;

// Both signals are registered, not just Ctrl+C: until the host exists there is no ConsoleLifetime to
// answer SIGTERM, and a pod deleted before the host finishes building would otherwise be killed
// outright when the grace period expired.
using var lifetime = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; lifetime.Cancel(); };
using var term = PosixSignalRegistration.Create(
    PosixSignal.SIGTERM, ctx => { ctx.Cancel = true; lifetime.Cancel(); });

using var host = await OrchestratorHost.StartAsync(args, lifetime.Token);
await host.WaitForShutdownAsync();
