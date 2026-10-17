using System.Reflection;
using System.Text.Json;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Workflow.Delete;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace BaseApi.Service.Features.Molecule;

/// <summary>
/// Runs a set of changes as BaseApi would apply them — creates, updates and deletes — and keeps none of them: <c>POST /model/validate</c>. A client
/// that holds its edits virtually (Valence) learns, before anything is written, whether every change passes every rule
/// — the validators, the services' own checks (a frozen schema definition), the database's keys and unique indexes,
/// and the delete guard of a running workflow — in the order it means to send them.
/// <para>
/// Each change goes through the same <c>BaseService</c> a <c>PUT</c> or <c>DELETE</c> uses, inside one transaction that
/// is always rolled back. Each change has its own savepoint: one that fails is rolled back to it and the next change
/// still runs on the state the passing ones left, so a later change that depends on an earlier one is judged on it. A
/// failure is reported as the problem the real call would answer — it is written by BaseApi's own exception handlers.
/// </para>
/// <para>
/// The services touch only the database, so rolling the transaction back undoes everything; the workflow delete guard
/// only reads Redis.
/// </para>
/// </summary>
internal sealed class ModelChangeRunner : IModelChangesValidator
{
    /// <summary>A bound on one request's work; a whole project's edits fit well within it.</summary>
    public const int MaxChanges = 500;

    private readonly AppDbContext _db;
    private readonly IServiceProvider _services;
    private readonly IWorkflowRunGuard _guard;
    private readonly IEnumerable<IExceptionHandler> _handlers;
    private readonly JsonSerializerOptions _json;

    public ModelChangeRunner(AppDbContext db, IServiceProvider services, IWorkflowRunGuard guard, IEnumerable<IExceptionHandler> handlers, IOptions<JsonOptions> json)
    {
        _db = db ?? throw new ArgumentNullException(nameof(db));
        _services = services ?? throw new ArgumentNullException(nameof(services));
        _guard = guard ?? throw new ArgumentNullException(nameof(guard));
        _handlers = handlers ?? throw new ArgumentNullException(nameof(handlers));
        _json = json?.Value.JsonSerializerOptions ?? throw new ArgumentNullException(nameof(json));
    }

    public async Task<ModelValidateResultDto> DryRunAsync(IReadOnlyList<ModelChangeDto> changes, HttpContext http, CancellationToken ct)
    {
        var tables = ModelEntities.ByTable(_db.Model);
        var strategy = _db.Database.CreateExecutionStrategy();
        var results = await strategy.ExecuteAsync(async () =>
        {
            var list = new List<ModelChangeResultDto>(changes.Count);
            // a created row's client id → the id BaseApi gave it, for the changes after it
            var made = new Dictionary<Guid, Guid>();
            await using var tx = await _db.Database.BeginTransactionAsync(ct);
            try
            {
                for (var i = 0; i < changes.Count; i++)
                {
                    var change = changes[i];
                    var savepoint = $"change_{i}";
                    await tx.CreateSavepointAsync(savepoint, ct);
                    try
                    {
                        var status = await RunAsync(change, tables, made, ct);
                        list.Add(new ModelChangeResultDto(i, change.Op, change.Table, change.Id, true, status, null));
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
                    {
                        await tx.RollbackToSavepointAsync(savepoint, ct);
                        var (status, problem) = await ProblemOfAsync(Unwrap(ex), http, ct);
                        list.Add(new ModelChangeResultDto(i, change.Op, change.Table, change.Id, false, status, problem));
                    }
                    finally
                    {
                        _db.ChangeTracker.Clear(); // the next change reads its row afresh, as a separate request would
                    }
                }
            }
            finally
            {
                await tx.RollbackAsync(CancellationToken.None); // a dry run: nothing is ever kept
                _db.ChangeTracker.Clear();
            }
            return list;
        });
        return new ModelValidateResultDto(results.All(r => r.Ok), results);
    }

    /// <summary>One change through its entity's service; the status the real call would answer on success.</summary>
    private async Task<int> RunAsync(ModelChangeDto change, IReadOnlyDictionary<string, ModelEntity> tables, Dictionary<Guid, Guid> made, CancellationToken ct)
    {
        var id = made.TryGetValue(change.Id, out var real) ? real : change.Id;
        // a row naming a row created earlier in this run names it by the id BaseApi gave it
        JsonElement? row = change.Row;
        if (row is { ValueKind: JsonValueKind.Object } r && made.Count > 0)
        {
            var text = r.GetRawText();
            foreach (var (client, given) in made) text = text.Replace($"\"{client:D}\"", $"\"{given:D}\"", StringComparison.OrdinalIgnoreCase);
            using var doc = JsonDocument.Parse(text);
            row = doc.RootElement.Clone();
        }
        if (!tables.TryGetValue(change.Table ?? "", out var entity))
            throw new ModelChangeException($"'{change.Table}' is not an entity table; one of: {string.Join(", ", tables.Keys.Order(StringComparer.Ordinal))}.");
        var service = _services.GetRequiredService(entity.Service);

        switch (change.Op)
        {
            case "create":
            {
                if (row is not { ValueKind: JsonValueKind.Object } body) throw new ModelChangeException("A create carries its row: the body a POST would send.");
                object? dto;
                try { dto = body.Deserialize(entity.CreateDto, _json); }
                catch (JsonException ex) { throw new ModelChangeException($"The row could not be read as a {entity.Table} create: {ex.Message}"); }
                if (dto is null) throw new ModelChangeException("A create carries its row: the body a POST would send.");
                var read = await InvokeFor(entity.Service.GetMethod("CreateAsync")!, service, dto, ct);
                if (read is BaseApi.Core.Contracts.IHasId hasId) made[change.Id] = hasId.Id;
                return StatusCodes.Status201Created;
            }
            case "update":
            {
                if (row is not { ValueKind: JsonValueKind.Object } body) throw new ModelChangeException("An update carries its row: the body a PUT would send.");
                object? dto;
                try { dto = body.Deserialize(entity.UpdateDto, _json); }
                catch (JsonException ex) { throw new ModelChangeException($"The row could not be read as a {entity.Table} update: {ex.Message}"); }
                if (dto is null) throw new ModelChangeException("An update carries its row: the body a PUT would send.");
                await Invoke(entity.Service.GetMethod("UpdateAsync")!, service, id, dto, ct);
                return StatusCodes.Status200OK;
            }
            case "delete":
                // DELETE /workflows/{id} runs the delete guard first (WorkflowDeleteGuardFilter); so does its dry run
                if (entity.Table == "workflows")
                {
                    if (await _guard.IsLiveAsync(id, ct)) throw OrchestrationValidationException.WorkflowRunning(id);
                    if (await _guard.IsDeletionRunningAsync(id, ct)) throw OrchestrationValidationException.WorkflowDeleting(id, "deleted again");
                }
                await Invoke(entity.Service.GetMethod("DeleteAsync")!, service, id, ct);
                return StatusCodes.Status204NoContent;
            default:
                throw new ModelChangeException($"'{change.Op}' is not a change: create, update or delete.");
        }
    }

    private static async Task Invoke(MethodInfo method, object target, params object?[] args)
    {
        Task task;
        try { task = (Task)method.Invoke(target, args)!; }
        catch (TargetInvocationException ex) when (ex.InnerException is not null) { throw ex.InnerException; }
        await task;
    }

    /** Like Invoke, for a method whose task carries a result (CreateAsync's read DTO). */
    private static async Task<object?> InvokeFor(MethodInfo method, object target, params object?[] args)
    {
        Task task;
        try { task = (Task)method.Invoke(target, args)!; }
        catch (TargetInvocationException ex) when (ex.InnerException is not null) { throw ex.InnerException; }
        await task;
        return task.GetType().GetProperty("Result")?.GetValue(task);
    }

    private static Exception Unwrap(Exception ex) => ex is TargetInvocationException { InnerException: { } inner } ? inner : ex;

    /// <summary>
    /// The problem the real call would answer: BaseApi's own exception handlers, in their registered order, write it to
    /// a private response, exactly as the request pipeline would.
    /// </summary>
    private async Task<(int Status, JsonElement? Problem)> ProblemOfAsync(Exception ex, HttpContext http, CancellationToken ct)
    {
        if (ex is ModelChangeException bad)
        {
            var body = JsonSerializer.SerializeToElement(new ProblemDetails { Status = 400, Title = "The change could not be read", Detail = bad.Message }, _json);
            return (StatusCodes.Status400BadRequest, body);
        }

        var ctx = new DefaultHttpContext { RequestServices = http.RequestServices, TraceIdentifier = http.TraceIdentifier };
        ctx.Request.Method = HttpMethods.Post;
        ctx.Request.Path = http.Request.Path;
        ctx.Request.Headers.Accept = "application/problem+json, application/json";
        foreach (var (key, value) in http.Items) ctx.Items[key] = value; // the correlation id rides here
        await using var stream = new MemoryStream();
        ctx.Response.Body = stream;

        foreach (var handler in _handlers)
            if (await handler.TryHandleAsync(ctx, ex, ct)) break;

        var status = ctx.Response.StatusCode is >= 400 ? ctx.Response.StatusCode : StatusCodes.Status500InternalServerError;
        if (stream.Length == 0) return (status, null);
        stream.Position = 0;
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        return (status, doc.RootElement.Clone());
    }
}

/// <summary>A change that cannot be read (an unknown table or op, a missing or malformed row): a 400 of its own.</summary>
internal sealed class ModelChangeException(string message) : Exception(message);
