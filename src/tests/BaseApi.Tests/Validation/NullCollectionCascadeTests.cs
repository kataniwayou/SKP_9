using BaseApi.Service.Features.Schema;
using BaseApi.Service.Features.Workflow;
using Xunit;

namespace BaseApi.Tests.Validation;

/// <summary>
/// A validator must report a null required field as a validation failure, never throw. FluentValidation's
/// default cascade is <c>Continue</c>, so every predicate in a rule chain runs even after the null check
/// has already failed — and a predicate that dereferences its argument then throws out of the validator
/// instead of returning the failure it exists to report.
/// <para>
/// Over HTTP model binding rejects the null first, so this is only reachable in-process. That is not a
/// reason to leave it: the service is called directly from tests and from any non-HTTP entry point, and
/// a NullReferenceException surfaces as a 500 rather than the contracted 400.
/// </para>
/// </summary>
public sealed class NullCollectionCascadeTests
{
    [Fact]
    public void WorkflowCreateReportsANullEntryStepCollectionRatherThanThrowing()
    {
        var result = new WorkflowCreateDtoValidator()
            .Validate(new WorkflowCreateDto("wf", "1.0.0", null, null!, null, null));

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.PropertyName == nameof(WorkflowCreateDto.EntryStepIds));
    }

    [Fact]
    public void WorkflowUpdateReportsANullEntryStepCollectionRatherThanThrowing()
    {
        var result = new WorkflowUpdateDtoValidator()
            .Validate(new WorkflowUpdateDto("wf", "1.0.0", null, null!, null, null));

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.PropertyName == nameof(WorkflowUpdateDto.EntryStepIds));
    }

    [Fact]
    public void SchemaCreateReportsANullDefinitionRatherThanThrowing()
    {
        // Same defect, different type: the JSON parse in the Custom step runs on the null that NotEmpty
        // already rejected, and ArgumentNullException is not the JsonException the catch expects.
        var result = new SchemaCreateDtoValidator()
            .Validate(new SchemaCreateDto("sch", "1.0.0", null, null!));

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.PropertyName == nameof(SchemaCreateDto.Definition));
    }

    [Fact]
    public void SchemaUpdateReportsANullDefinitionRatherThanThrowing()
    {
        var result = new SchemaUpdateDtoValidator()
            .Validate(new SchemaUpdateDto("sch", "1.0.0", null, null!));

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.PropertyName == nameof(SchemaUpdateDto.Definition));
    }

    [Fact]
    public void ValidPayloadsStillPass()
    {
        // The cascade change must stop the chain only on failure — a well-formed DTO still runs every
        // rule and still passes.
        Assert.True(new WorkflowCreateDtoValidator()
            .Validate(new WorkflowCreateDto("wf", "1.0.0", null, [Guid.NewGuid()], null, "0 0 * * *")).IsValid);

        Assert.True(new SchemaCreateDtoValidator()
            .Validate(new SchemaCreateDto("sch", "1.0.0", null, """{"type":"object"}""")).IsValid);
    }

    [Fact]
    public void RulesAfterTheNullCheckStillFireOnNonNullInput()
    {
        // Cascade.Stop must not swallow the later predicates: a present-but-invalid collection is still
        // rejected by the rule that follows the null check.
        var result = new WorkflowCreateDtoValidator()
            .Validate(new WorkflowCreateDto("wf", "1.0.0", null, [Guid.Empty], null, null));

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.ErrorMessage.Contains("Guid.Empty"));
    }
}
