using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Schema;
using FluentValidation;

namespace BaseApi.Service.Features.Workflow.Graph;

internal sealed class GraphAssignmentResolver
  {
      public GraphAssignmentResolver(BaseDbContext db, IValidator<AssignmentCreateDto> payloadValidator) { }
      public Task<List<Guid>> ResolveAsync(Guid workflowId, string workflowName, IReadOnlyList<GraphAssignmentIntent> intents, CancellationToken ct)
          => throw new NotImplementedException("Task 6");
  }
