using BaseApi.Core.Exceptions;
using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Core.Services;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Processor;

/// <summary>
/// Service for <see cref="ProcessorEntity"/>. The processor has only scalar foreign-key references
/// — the many-to-many graph lives at the step, assignment and workflow levels — so the locked create
/// order is inherited unchanged.
/// <para>
/// It adds <see cref="GetBySourceHashAsync"/>, a single-row lookup on the processor-specific source
/// hash. That lives here rather than on the base service because the column is processor-specific,
/// and it queries the context directly, so the repository interface stays at its five methods.
/// </para>
/// <para>
/// The mapper is injected a second time and held in a field, because the base class keeps its own
/// copy private. It costs nothing: the mapper is a singleton, so both references are the same
/// instance.
/// </para>
/// </summary>
public sealed class ProcessorService :
    BaseService<ProcessorEntity, ProcessorCreateDto, ProcessorUpdateDto, ProcessorReadDto>
{
    private readonly IEntityMapper<ProcessorEntity, ProcessorCreateDto, ProcessorUpdateDto, ProcessorReadDto> _mapper;

    public ProcessorService(
        IValidator<ProcessorCreateDto> createValidator,
        IValidator<ProcessorUpdateDto> updateValidator,
        IEntityMapper<ProcessorEntity, ProcessorCreateDto, ProcessorUpdateDto, ProcessorReadDto> mapper,
        IRepository<ProcessorEntity> repo,
        BaseDbContext dbContext)
        : base(createValidator, updateValidator, mapper, repo, dbContext)
    {
        _mapper = mapper ?? throw new ArgumentNullException(nameof(mapper));
    }

    /// <summary>
    /// Looks a processor up by its source hash. A miss throws <see cref="NotFoundException"/>, which
    /// the handler chain turns into a 404 naming the resource type and the supplied hash. There is no
    /// route-level format validation, so an off-format hash simply misses and 404s.
    /// </summary>
    /// <remarks>
    /// <b>The caller must supply the hash lowercased.</b> The create-side validator enforces a
    /// lowercase 64-character hex string, and this lookup compares case-sensitively, so an uppercase
    /// or mixed-case variant returns 404 even when a row with the same logical hash exists. The read
    /// path deliberately does not normalize: doing so would silently accept inputs the validator
    /// rejects on write.
    /// </remarks>
    public async Task<ProcessorReadDto> GetBySourceHashAsync(string sourceHash, CancellationToken ct)
    {
        // A null, empty or whitespace hash cannot match any row, so short-circuit rather than paying
        // for a round trip and then returning a 404 with an empty resource id.
        if (string.IsNullOrWhiteSpace(sourceHash))
            throw new NotFoundException(nameof(ProcessorEntity), sourceHash ?? "(null)");

        var entity = await DbContext.Set<ProcessorEntity>()
            .AsNoTracking()
            .FirstOrDefaultAsync(p => p.SourceHash == sourceHash, ct);
        if (entity is null) throw new NotFoundException(nameof(ProcessorEntity), sourceHash);
        return _mapper.ToRead(entity);
    }
}
