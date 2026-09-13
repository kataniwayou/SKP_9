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
/// hash and instance id. That lives here rather than on the base service because the columns are
/// processor-specific, and it queries the context directly, so the repository interface stays at its
/// five methods.
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
    /// Looks a processor up by its source hash and, where one is supplied, its instance id. A miss
    /// throws <see cref="NotFoundException"/>, which the handler chain turns into a 404 naming the
    /// resource type and the supplied hash. There is no route-level format validation, so an
    /// off-format hash simply misses and 404s.
    /// </summary>
    /// <param name="sourceHash">The lowercase 64-hex build identity to look up.</param>
    /// <param name="instanceId">
    /// The replica identity to resolve, or null/blank for the row shared by every replica of this
    /// build. <b>Matching is exact in both directions and never falls back.</b> A supplied instance
    /// id that names no row is a miss even when the hash has a shared row, and a request carrying
    /// none is a miss when every row for that hash claims an instance. Falling back either way would
    /// hand a pod an identity that belongs to something else — and since the work queue is named
    /// after the identity, the pod would go on to consume another replica's queue. A miss leaves it
    /// waiting and visible; a fallback would leave it running and wrong.
    /// </param>
    /// <param name="ct">Cancellation token.</param>
    /// <remarks>
    /// <b>The caller must supply the hash lowercased.</b> The create-side validator enforces a
    /// lowercase 64-character hex string, and this lookup compares case-sensitively, so an uppercase
    /// or mixed-case variant returns 404 even when a row with the same logical hash exists. The read
    /// path deliberately does not normalize: doing so would silently accept inputs the validator
    /// rejects on write. The instance id is compared the same way, and is not normalized for case
    /// either — a pod name is already lowercase by Kubernetes' own rules.
    /// </remarks>
    public async Task<ProcessorReadDto> GetBySourceHashAsync(
        string sourceHash, string? instanceId, CancellationToken ct)
    {
        // A null, empty or whitespace hash cannot match any row, so short-circuit rather than paying
        // for a round trip and then returning a 404 with an empty resource id.
        if (string.IsNullOrWhiteSpace(sourceHash))
            throw new NotFoundException(nameof(ProcessorEntity), sourceHash ?? "(null)");

        // Blank folds to null on the way in, mirroring the entity's own setter. Without it a caller
        // sending "" would be asking for a row that cannot exist: the column never holds a blank.
        var wanted = string.IsNullOrWhiteSpace(instanceId) ? null : instanceId;

        var query = DbContext.Set<ProcessorEntity>()
            .AsNoTracking()
            .Where(p => p.SourceHash == sourceHash);

        // Written as two branches rather than one `p.InstanceId == wanted`, because that translates
        // to `instance_id = NULL` when wanted is null, which is NULL in SQL and matches nothing.
        query = wanted is null
            ? query.Where(p => p.InstanceId == null)
            : query.Where(p => p.InstanceId == wanted);

        // At most one row can satisfy both predicates — that is what the two unique indexes buy —
        // so the ordering decides nothing that exists to be decided. It is here for rows that
        // predate the constraint, where an unordered read could answer differently call to call and
        // hand two restarts of one pod two different identities.
        var entity = await query
            .OrderBy(p => p.CreatedAt)
            .FirstOrDefaultAsync(ct);

        if (entity is null)
        {
            throw new NotFoundException(
                nameof(ProcessorEntity),
                wanted is null ? sourceHash : $"{sourceHash} (instance {wanted})");
        }

        return _mapper.ToRead(entity);
    }
}
