using BaseApi.Core.Controllers;
using BaseApi.Core.Services;

namespace BaseApi.Service.Features.Cache;

public sealed class CachesController :
    BaseController<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto>
{
    public CachesController(
        BaseService<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto> service)
        : base(service) { }
}
