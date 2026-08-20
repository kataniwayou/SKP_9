using Json.Schema;

namespace BaseApi.Service.Features.Schema;

/// <summary>
/// The single place JSON Schema evaluation is configured, consumed by the schema validators and by
/// the payload-against-config-schema validator.
///
/// <para>
/// <b>The static constructor is the security control.</b> It runs once on first member access and
/// does two things: it sets the dialect to draft 2020-12, because the library defaults to an older
/// one; and it pins the registry's fetch delegate to return null, which blocks server-side request
/// forgery through an external <c>$ref</c>. Any consumer that evaluates a schema must touch a member
/// of this type — <see cref="DefaultOptions"/> is the natural one — so the constructor fires before
/// evaluation. If nothing ever touches it, the constructor never runs and the lockdown silently
/// regresses.
/// </para>
///
/// <para>
/// <b>This type is deliberately duplicated by
/// <c>BaseProcessor.Core/Validation/ProcessorJsonSchemaValidator.cs</c></b> — same
/// <c>Dialect.Default</c>, same <c>SchemaRegistry.Global.Fetch</c> lockdown, same options. Both mutate
/// process-global library state, and neither can call the other: they live in assemblies that must not
/// reference each other, since a worker host must not load the web stack. <b>The two must stay in
/// sync.</b> A dialect or fetch setting changed here and not there means the same schema row evaluates
/// differently on the API side and the processor side — a divergence no test on either side would
/// catch alone.
/// </para>
/// </summary>
public static class JsonSchemaConfig
{
    static JsonSchemaConfig()
    {
        // The library's default dialect is an older draft, so set it explicitly.
        Dialect.Default = Dialect.Draft202012;
        // Defence in depth: an explicit no-op fetch, even though the library default already is one.
        SchemaRegistry.Global.Fetch = (_, _) => null;
    }

    /// <summary>
    /// Shared evaluation options. Referencing this property is what fires the static constructor and
    /// therefore applies the dialect and fetch lockdown.
    /// </summary>
    public static EvaluationOptions DefaultOptions { get; } = new() { OutputFormat = OutputFormat.List };
}
