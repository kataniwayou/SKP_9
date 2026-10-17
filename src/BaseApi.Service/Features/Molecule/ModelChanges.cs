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
/// Runs a set of changes as BaseApi would apply them — creates, updates and deletes — and keeps none of them: <c>POST /model/validate</c>;
/// or applies them, all or none: <c>POST /model/apply</c> runs the same way and commits only when every change passed
/// (the user, 2026-10-17: the apply, approved). A client
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
        var (results, _, _) = await RunAllAsync(changes, http, commit: false, ct);
        return new ModelValidateResultDto(results.All(r => r.Ok), results);
    }

    public async Task<ModelApplyResultDto> ApplyAsync(IReadOnlyList<ModelChangeDto> changes, HttpContext http, CancellationToken ct)
    {
        var (results, made, applied) = await RunAllAsync(changes, http, commit: true, ct);
        return new ModelApplyResultDto(results.All(r => r.Ok), applied, results, made);
    }

    /// <summary>
    /// Every change in order in one transaction, a savepoint each. A dry run always rolls back; an apply commits when
    /// every change passed, and otherwise rolls back too — all of them, or none.
    /// </summary>
    private async Task<(List<ModelChangeResultDto> Results, Dictionary<Guid, Guid> Made, bool Applied)> RunAllAsync(IReadOnlyList<ModelChangeDto> changes, HttpContext http, bool commit, CancellationToken ct)
    {
        var tables = ModelEntities.ByTable(_db.Model);
        var strategy = _db.Database.CreateExecutionStrategy();
        return await strategy.ExecuteAsync(async () =>
        {
            var list = new List<ModelChangeResultDto>(changes.Count);
            // a created row's client id → the id BaseApi gave it, for the changes after it
            var made = new Dictionary<Guid, Guid>();
            // the rows whose updatedAt was checked: only a row's first change in the run is checked (a later one sees the
            // updatedAt this run gave it, e.g. a deleted step's next-step rows cleared first)
            var checkedRows = new HashSet<(string, Guid)>();
            var applied = false;
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
                        await CheckFreshAsync(change, tables, made, checkedRows, ct);
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
                if (commit && list.Count == changes.Count && list.All(r => r.Ok))
                {
                    await tx.CommitAsync(ct); // the apply: every change passed, all of them are kept
                    applied = true;
                }
                else
                {
                    await tx.RollbackAsync(CancellationToken.None); // a dry run, or an apply with a refused change: none kept
                }
                _db.ChangeTracker.Clear();
            }
            return (list, made, applied);
        });
    }

    /// <summary>
    /// An update or a delete that says when its row was read: refused with a 409 when the row was changed since (its
    /// updatedAt differs, to the microsecond the database keeps). A row created in this run, or already changed by an
    /// earlier change of it, is not checked; a row that is gone is left to the service (its 404).
    /// </summary>
    private async Task CheckFreshAsync(ModelChangeDto change, IReadOnlyDictionary<string, ModelEntity> tables, Dictionary<Guid, Guid> made, HashSet<(string, Guid)> checkedRows, CancellationToken ct)
    {
        if (change.UpdatedAt is not { } read || change.Op is not ("update" or "delete") || made.ContainsKey(change.Id)) return;
        if (!tables.TryGetValue(change.Table ?? "", out var entity) || !checkedRows.Add((entity.Table, change.Id))) return;
        var found = await _db.FindAsync(entity.Entity, [change.Id], ct);
        if (found is not BaseApi.Core.Entities.BaseEntity row) return;
        _db.Entry(found).State = EntityState.Detached; // the service reads it afresh
        if (Micros(row.UpdatedAt) != Micros(read)) throw new ModelStaleException(entity.Table, change.Id, read, row.UpdatedAt);
    }

    private static long Micros(DateTime t) => (t.Kind == DateTimeKind.Local ? t.ToUniversalTime() : t).Ticks / 10;

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
        if (ex is ModelStaleException stale)
        {
            var problem = new ProblemDetails
            {
                Status = 409,
                Title = "Changed since it was read",
                Detail = $"This {stale.Table} row was changed in BaseApi at {stale.Current:O}, after it was read at {stale.Read:O}: refresh, then apply again.",
            };
            problem.Extensions["code"] = "stale";
            return (StatusCodes.Status409Conflict, JsonSerializer.SerializeToElement(problem, _json));
        }
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

/// <summary>An update or delete of a row changed since the client read it: a 409 of its own (code <c>stale</c>).</summary>
internal sealed class ModelStaleException(string table, Guid id, DateTime read, DateTime current) : Exception($"{table} {id} changed since it was read.")
{
    public string Table { get; } = table;
    public Guid Id { get; } = id;
    public DateTime Read { get; } = read;
    public DateTime Current { get; } = current;
}
