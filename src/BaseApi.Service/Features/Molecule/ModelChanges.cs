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
/// Runs a set of changes as BaseApi would apply them, and keeps none of them: <c>POST /model/validate</c>. A client
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
                        var status = await RunAsync(change, tables, ct);
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
    private async Task<int> RunAsync(ModelChangeDto change, IReadOnlyDictionary<string, ModelEntity> tables, CancellationToken ct)
    {
        if (!tables.TryGetValue(change.Table ?? "", out var entity))
            throw new ModelChangeException($"'{change.Table}' is not an entity table; one of: {string.Join(", ", tables.Keys.Order(StringComparer.Ordinal))}.");
        var service = _services.GetRequiredService(entity.Service);

        switch (change.Op)
        {
            case "update":
            {
                if (change.Row is not { ValueKind: JsonValueKind.Object } row) throw new ModelChangeException("An update carries its row: the body a PUT would send.");
                object? dto;
                try { dto = row.Deserialize(entity.UpdateDto, _json); }
                catch (JsonException ex) { throw new ModelChangeException($"The row could not be read as a {entity.Table} update: {ex.Message}"); }
                if (dto is null) throw new ModelChangeException("An update carries its row: the body a PUT would send.");
                await Invoke(entity.Service.GetMethod("UpdateAsync")!, service, change.Id, dto, ct);
                return StatusCodes.Status200OK;
            }
            case "delete":
                // DELETE /workflows/{id} runs the delete guard first (WorkflowDeleteGuardFilter); so does its dry run
                if (entity.Table == "workflows")
                {
                    if (await _guard.IsLiveAsync(change.Id, ct)) throw OrchestrationValidationException.WorkflowRunning(change.Id);
                    if (await _guard.IsDeletionRunningAsync(change.Id, ct)) throw OrchestrationValidationException.WorkflowDeleting(change.Id, "deleted again");
                }
                await Invoke(entity.Service.GetMethod("DeleteAsync")!, service, change.Id, ct);
                return StatusCodes.Status204NoContent;
            default:
                throw new ModelChangeException($"'{change.Op}' is not a change: update or delete.");
        }
    }

    private static async Task Invoke(MethodInfo method, object target, params object?[] args)
    {
        Task task;
        try { task = (Task)method.Invoke(target, args)!; }
        catch (TargetInvocationException ex) when (ex.InnerException is not null) { throw ex.InnerException; }
        await task;
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
