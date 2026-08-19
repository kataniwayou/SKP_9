using System.Runtime.InteropServices;
using Microsoft.Extensions.Hosting;
using Processor.Sample;

// The boot resolves identity before building anything, so this is the one place the process can be
// cancelled while it is still deciding who it is.
//
// Both signals are registered, not just Ctrl+C. Until the host exists there is no ConsoleLifetime to
// answer SIGTERM, and Stage 1 is explicitly allowed to run forever — so a processor waiting on an
// unregistered row is exactly the pod an operator deletes, and without this it would ignore the
// request and be killed outright when the grace period expired.
using var lifetime = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; lifetime.Cancel(); };
using var term = PosixSignalRegistration.Create(
    PosixSignal.SIGTERM, ctx => { ctx.Cancel = true; lifetime.Cancel(); });

using var host = await ProcessorHost.StartAsync(args, lifetime.Token);
await host.WaitForShutdownAsync();
