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
public partial class Program { }
