using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>Stage 1: insert each schema copy (new id, the original's name and version), judged by the schema CRUD's rules.</summary>
internal sealed class SchemaStage : IDesignStage
{
    private readonly BaseDbContext _db;
    private readonly IValidator<SchemaCreateDto> _validator;
    private readonly IEntityMapper<SchemaEntity, SchemaCreateDto, SchemaUpdateDto, SchemaReadDto> _mapper;

    public SchemaStage(BaseDbContext db, IValidator<SchemaCreateDto> validator,
        IEntityMapper<SchemaEntity, SchemaCreateDto, SchemaUpdateDto, SchemaReadDto> mapper)
    {
        _db = db;
        _validator = validator;
        _mapper = mapper;
    }

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        var schemas = run.Request.Schemas ?? [];
        run.BeginStage("schemas", schemas.Count, schemas.Count == 1 ? "copy to insert" : "copies to insert");
        foreach (var s in schemas)
        {
            run.Label(s.Id, $"schema copy '{s.Name}' {s.Version}");
            var applied = await run.UnitAsync("schema", s.Id, "schemas", async () =>
            {
                var dto = new SchemaCreateDto(s.Name, s.Version, s.Description, s.Definition);
                var problems = DesignFields.Failures(await _validator.ValidateAsync(dto, ct));
                if (problems.Count > 0) return problems;
                var entity = _mapper.ToEntity(dto);
                entity.Id = s.Id;
                _db.Add(entity);
                return problems;
            }, ct);
            if (!applied) run.FailedSchemas.Add(s.Id);
            else run.Changed("schema", s.Id, "inserted", $"inserted as {DesignLogText.Short(s.Id)}");
        }
        run.EndStage();
    }
}

/// <summary>
/// Stage 2: a processor's fields, and its slots re-pointed to their copies. Shared, so no conflict check
/// (last write wins). A re-point to a copy that failed in stage 1 is skipped, with an error of its own.
/// </summary>
internal sealed class ProcessorStage : IDesignStage
{
    private readonly BaseDbContext _db;
    private readonly IValidator<ProcessorUpdateDto> _validator;
    private readonly IEntityMapper<ProcessorEntity, ProcessorCreateDto, ProcessorUpdateDto, ProcessorReadDto> _mapper;

    public ProcessorStage(BaseDbContext db, IValidator<ProcessorUpdateDto> validator,
        IEntityMapper<ProcessorEntity, ProcessorCreateDto, ProcessorUpdateDto, ProcessorReadDto> mapper)
    {
        _db = db;
        _validator = validator;
        _mapper = mapper;
    }

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        var processors = run.Request.Processors ?? [];
        run.BeginStage("processors", processors.Count, processors.Count == 1 ? "processor to update" : "processors to update");
        var ids = processors.Select(p => p.Id).ToList();
        var names = await _db.Set<ProcessorEntity>().AsNoTracking().Where(x => ids.Contains(x.Id))
            .Select(x => new { x.Id, x.Name }).ToListAsync(ct);
        foreach (var n in names) run.Label(n.Id, $"processor '{n.Name}'");
        foreach (var p in processors)
        {
            var slots = p.Slots ?? new Dictionary<string, Guid>();
            foreach (var (slot, _) in slots.Where(kv => run.FailedSchemas.Contains(kv.Value)))
                run.Fail("processor", p.Id, "processors", $"{slot}SchemaId", $"Not re-pointed: the {slot} schema copy failed.");

            string? change = null;
            var applied = await run.UnitAsync("processor", p.Id, "processors", async () =>
            {
                var entity = await _db.Set<ProcessorEntity>().FirstOrDefaultAsync(x => x.Id == p.Id, ct);
                if (entity is null) return [new FieldError(null, "This processor no longer exists.")];
                var errors = new List<FieldError>();
                var before = DesignFields.UpdateOf(entity);
                var dto = DesignFields.Apply(before, p.Fields, errors);
                foreach (var (slot, schemaId) in slots.Where(kv => !run.FailedSchemas.Contains(kv.Value)))
                    dto = slot switch
                    {
                        "input" => dto with { InputSchemaId = schemaId },
                        "output" => dto with { OutputSchemaId = schemaId },
                        _ => dto with { ConfigSchemaId = schemaId },
                    };
                // a field already refused (unknown name, wrong type) is its own error: no CRUD verdict on top of it
                if (errors.Count > 0) return errors;
                var problems = DesignFields.Failures(await _validator.ValidateAsync(dto, ct));
                if (problems.Count > 0) return problems;
                _mapper.Update(dto, entity);
                change = DesignLogText.Join(DesignLogText.Fields(
                    ("name", before.Name, dto.Name), ("version", before.Version, dto.Version), ("description", before.Description, dto.Description),
                    ("sourceHash", before.SourceHash, dto.SourceHash), ("instanceId", before.InstanceId, dto.InstanceId),
                    ("input schema", before.InputSchemaId, dto.InputSchemaId), ("output schema", before.OutputSchemaId, dto.OutputSchemaId),
                    ("config schema", before.ConfigSchemaId, dto.ConfigSchemaId)));
                return problems;
            }, ct, shared: true);
            if (!applied) continue;
            if (change is null) run.Unchanged();
            else run.Changed("processor", p.Id, "updated", change);
        }
        run.EndStage();
    }
}

/// <summary>Stage 3: a cache's fields. Shared, so no conflict check (last write wins).</summary>
internal sealed class CacheStage : IDesignStage
{
    private readonly BaseDbContext _db;
    private readonly IValidator<CacheUpdateDto> _validator;
    private readonly IEntityMapper<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto> _mapper;

    public CacheStage(BaseDbContext db, IValidator<CacheUpdateDto> validator,
        IEntityMapper<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto> mapper)
    {
        _db = db;
        _validator = validator;
        _mapper = mapper;
    }

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        var caches = run.Request.Caches ?? [];
        run.BeginStage("caches", caches.Count, caches.Count == 1 ? "cache to update" : "caches to update");
        var ids = caches.Select(c => c.Id).ToList();
        var names = await _db.Set<CacheEntity>().AsNoTracking().Where(x => ids.Contains(x.Id))
            .Select(x => new { x.Id, x.Name }).ToListAsync(ct);
        foreach (var n in names) run.Label(n.Id, $"cache '{n.Name}'");
        foreach (var c in caches)
        {
            string? change = null;
            var applied = await run.UnitAsync("cache", c.Id, "caches", async () =>
            {
                var entity = await _db.Set<CacheEntity>().FirstOrDefaultAsync(x => x.Id == c.Id, ct);
                if (entity is null) return [new FieldError(null, "This cache no longer exists.")];
                var errors = new List<FieldError>();
                var before = DesignFields.UpdateOf(entity);
                var dto = DesignFields.Apply(before, c.Fields, errors);
                if (errors.Count > 0) return errors;
                var problems = DesignFields.Failures(await _validator.ValidateAsync(dto, ct));
                if (problems.Count > 0) return problems;
                _mapper.Update(dto, entity);
                change = DesignLogText.Join(DesignLogText.Fields(
                    ("name", before.Name, dto.Name), ("version", before.Version, dto.Version), ("description", before.Description, dto.Description),
                    ("root", before.Root, dto.Root), ("items", before.Items, dto.Items)));
                return problems;
            }, ct, shared: true);
            if (!applied) continue;
            if (change is null) run.Unchanged();
            else run.Changed("cache", c.Id, "updated", change);
        }
        run.EndStage();
    }
}
