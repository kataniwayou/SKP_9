using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Schema;
using FluentValidation;

namespace BaseApi.Service.Features.Workflow.Graph;

internal sealed class GraphSchemaEditor{
      public GraphSchemaEditor(BaseDbContext db, IValidator<SchemaCreateDto> schemaValidator) { }
      public Task ApplyAsync(IReadOnlyList<GraphSchemaEdit> edits, CancellationToken ct) => Task.CompletedTask;
  }
