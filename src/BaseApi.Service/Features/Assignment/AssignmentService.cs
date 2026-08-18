using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Core.Services;
using FluentValidation;

namespace BaseApi.Service.Features.Assignment;

/// <summary>
/// Service for <see cref="AssignmentEntity"/>. Assignment is a leaf entity with no junction tables,
/// so a pass-through constructor and an empty body are enough — the locked create order is inherited
/// unchanged from <see cref="BaseService{TEntity,TCreate,TUpdate,TRead}"/>.
/// </summary>
public sealed class AssignmentService :
    BaseService<AssignmentEntity, AssignmentCreateDto, AssignmentUpdateDto, AssignmentReadDto>
{
    public AssignmentService(
        IValidator<AssignmentCreateDto> createValidator,
        IValidator<AssignmentUpdateDto> updateValidator,
        IEntityMapper<AssignmentEntity, AssignmentCreateDto, AssignmentUpdateDto, AssignmentReadDto> mapper,
        IRepository<AssignmentEntity> repo,
        BaseDbContext dbContext)
        : base(createValidator, updateValidator, mapper, repo, dbContext) { }
}
