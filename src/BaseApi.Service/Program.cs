using BaseApi.Core.DependencyInjection;
using BaseApi.Service;
using BaseApi.Service.Composition;

var builder = WebApplication.CreateBuilder(args);
builder.AddBaseApiObservability(builder.Configuration, source: "webapi");
builder.Services.AddBaseApi<AppDbContext>(builder.Configuration);
builder.Services.AddAppMessaging(builder.Configuration);   // broker, gate, consumers
builder.Services.AddAppFeatures();
builder.Services.AddBaseApiFallbackHandler();   // catch-all last, after every domain handler

var app = builder.Build();
app.UseBaseApi();
app.MapControllers();
app.Run();

// Marker type so tests can target the host with WebApplicationFactory<Program>. Top-level
// statements generate an internal Program; this declaration promotes it to public.
//
// NOTHING USES IT TODAY. Microsoft.AspNetCore.Mvc.Testing was removed once it was found to have no
// PackageReference anywhere, and no test constructs a WebApplicationFactory. Kept rather than
// deleted because it costs one type and is the seam any future end-to-end HTTP test needs first
// — deleting it would make Program internal again and the next such test would open with an
// unexplained accessibility error. Delete it only alongside a decision not to test this host over
// HTTP at all.
public partial class Program { }
