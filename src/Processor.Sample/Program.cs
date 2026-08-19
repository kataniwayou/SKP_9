using Microsoft.Extensions.Hosting;
using Processor.Sample;

// A thin shell by design — see ProcessorHost for what it composes, and the csproj for why the source
// hash is stamped here rather than in the library.
await ProcessorHost.Create(args).RunAsync();
