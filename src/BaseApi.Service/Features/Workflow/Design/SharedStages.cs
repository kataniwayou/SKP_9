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
        foreach (var s in run.Request.Schemas ?? [])
        {
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
        }
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
        foreach (var p in run.Request.Processors ?? [])
        {
            var slots = p.Slots ?? new Dictionary<string, Guid>();
            foreach (var (slot, _) in slots.Where(kv => run.FailedSchemas.Contains(kv.Value)))
                run.Fail("processor", p.Id, "processors", $"{slot}SchemaId", $"Not re-pointed: the {slot} schema copy failed.");

            await run.UnitAsync("processor", p.Id, "processors", async () =>
            {
                var entity = await _db.Set<ProcessorEntity>().FirstOrDefaultAsync(x => x.Id == p.Id, ct);
                if (entity is null) return [new FieldError(null, "This processor no longer exists.")];
                var errors = new List<FieldError>();
                var dto = DesignFields.Apply(DesignFields.UpdateOf(entity), p.Fields, errors);
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
                return problems;
            }, ct, shared: true);
        }
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
        foreach (var c in run.Request.Caches ?? [])
            await run.UnitAsync("cache", c.Id, "caches", async () =>
            {
                var entity = await _db.Set<CacheEntity>().FirstOrDefaultAsync(x => x.Id == c.Id, ct);
                if (entity is null) return [new FieldError(null, "This cache no longer exists.")];
                var errors = new List<FieldError>();
                var dto = DesignFields.Apply(DesignFields.UpdateOf(entity), c.Fields, errors);
                if (errors.Count > 0) return errors;
                var problems = DesignFields.Failures(await _validator.ValidateAsync(dto, ct));
                if (problems.Count > 0) return problems;
                _mapper.Update(dto, entity);
                return problems;
            }, ct, shared: true);
    }
}
