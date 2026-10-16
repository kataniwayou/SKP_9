using System.Collections;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FluentValidation;
using FluentValidation.Validators;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;

namespace BaseApi.Service.Features.Molecule;

/// <summary>
/// Describes every entity's writable fields with the rules a write must pass, read at runtime from the two places
/// BaseApi keeps them: the update validators (FluentValidation) and the EF model (store types, unique indexes). A
/// client checks an edit as BaseApi will, without a copy of the rules.
/// <para>
/// Nothing here names an entity, a field or a rule. A table's entity is paired with its update DTO through the
/// <c>BaseService</c> subclass that serves it; the DTO's properties are its
/// fields; the validator registered for the DTO gives each field's rules. A new field, a changed limit or a new index
/// changes the description with no edit here.
/// </para>
/// <para>
/// A rule written as code (<c>Must</c>, <c>Custom</c>) cannot be read as data: it is described as <c>code</c> with its
/// message when it has one of its own, and only BaseApi can run it. So are the rules that live in services rather than
/// validators (the schema definition freeze, the 409s of a unique index): this describes them where the model holds
/// them (the unique indexes) and not otherwise.
/// </para>
/// </summary>
internal static class ModelFields
{
    // The validators and the model are fixed for the life of the process, so the description is built once.
    private static readonly object Gate = new();
    private static ModelFieldsSnapshot? _cache;

    public static ModelFieldsSnapshot Describe(IModel model, IServiceProvider services)
    {
        lock (Gate) return _cache ??= Build(model, services);
    }

    /// <summary>Builds the description without the process-wide cache (for tests).</summary>
    internal static ModelFieldsSnapshot Build(IModel model, IServiceProvider services)
    {
        var served = ModelEntities.ByTable(model);
        var entities = new List<ModelEntityFieldsDto>();
        foreach (var entityType in model.GetEntityTypes().OrderBy(e => e.GetTableName(), StringComparer.Ordinal))
        {
            if (entityType.GetTableName() is not { } table || !served.TryGetValue(table, out var entity)) continue;
            var dto = entity.UpdateDto;
            var store = StoreObjectIdentifier.Table(table, entityType.GetSchema());
            var validator = (IValidator?)services.GetService(typeof(IValidator<>).MakeGenericType(dto))
                ?? throw new InvalidOperationException($"No IValidator<{dto.Name}> is registered.");
            var rules = RulesOf(validator);
            var nullability = new NullabilityInfoContext();

            var fields = dto.GetProperties(BindingFlags.Public | BindingFlags.Instance).Select(p =>
            {
                var column = entityType.FindProperty(p.Name);
                return new ModelFieldDto(
                    JsonNamingPolicy.CamelCase.ConvertName(p.Name),
                    column?.GetColumnName(store),
                    TypeOf(p.PropertyType),
                    nullability.Create(p).WriteState == NullabilityState.Nullable,
                    column?.GetColumnType(store),
                    rules.TryGetValue(p.Name, out var r) ? r : [],
                    EnumValues(p.PropertyType));
            }).ToList();

            var byColumn = fields.Where(f => f.Column is not null).ToDictionary(f => f.Column!, f => f.Field);
            var unique = entityType.GetIndexes().Where(i => i.IsUnique)
                .Select(i => new ModelUniqueDto(
                    i.GetDatabaseName(store) ?? i.Name ?? string.Join("_", i.Properties.Select(x => x.Name)),
                    i.Properties.Select(x => x.GetColumnName(store)!).Select(c => byColumn.TryGetValue(c, out var f) ? f : c).ToList(),
                    i.GetFilter()))
                .OrderBy(u => u.Index, StringComparer.Ordinal)
                .ToList();

            entities.Add(new ModelEntityFieldsDto(table, fields, unique));
        }

        var dtoOut = new ModelFieldsDto(entities);
        return new ModelFieldsSnapshot(dtoOut, ETagOf(dtoOut));
    }

    /// <summary>Every rule of a validator by DTO property, its included validators' rules first, as they run.</summary>
    private static Dictionary<string, List<ModelRuleDto>> RulesOf(IValidator validator)
    {
        var byField = new Dictionary<string, List<ModelRuleDto>>(StringComparer.Ordinal);
        Collect(validator, byField);
        return byField;
    }

    private static void Collect(IValidator validator, Dictionary<string, List<ModelRuleDto>> byField)
    {
        foreach (var rule in validator.CreateDescriptor().Rules)
        {
            // Include(...) is a rule with no property whose one component wraps the included validator.
            if (string.IsNullOrEmpty(rule.PropertyName))
            {
                foreach (var c in rule.Components)
                    if (c.Validator is IChildValidatorAdaptor && Included(c.Validator) is { } included) Collect(included, byField);
                continue;
            }

            // A rule inside When(x => x.P.HasValue) is written against P.Value: it applies only when P is given.
            var whenPresent = rule.PropertyName.EndsWith(".Value", StringComparison.Ordinal);
            var field = whenPresent ? rule.PropertyName[..^".Value".Length] : rule.PropertyName;
            if (!byField.TryGetValue(field, out var list)) byField[field] = list = [];
            foreach (var c in rule.Components)
                list.Add(Describe(c.Validator, c.GetUnformattedErrorMessage(), whenPresent || c.HasCondition || c.HasAsyncCondition, rule.TypeToValidate));
        }
    }

    /// <summary>
    /// The validator an <c>Include</c> wraps. FluentValidation 12 exposes it only through the adaptor's
    /// <c>GetValidator(context, value)</c>, which demands a live validation context, so it is read from the adaptor's
    /// field. A FluentValidation upgrade that moves it fails <c>ModelFieldsTests</c> (the shared name rules vanish).
    /// </summary>
    private static IValidator? Included(object adaptor) =>
        adaptor.GetType().GetField("_validator", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(adaptor) as IValidator;

    private static ModelRuleDto Describe(IPropertyValidator v, string? message, bool conditional, Type type)
    {
        // A message of the rule's own; FluentValidation's default template says nothing a client cannot say itself.
        var own = message is not null && message != v.GetDefaultMessageTemplate(null!) ? message : null;
        return v switch
        {
            INotEmptyValidator => new ModelRuleDto("required", null, own, conditional),
            INotNullValidator => new ModelRuleDto("notNull", null, own, conditional),
            IMaximumLengthValidator l => new ModelRuleDto("maxLength", l.Max.ToString(System.Globalization.CultureInfo.InvariantCulture), own, conditional),
            IMinimumLengthValidator l => new ModelRuleDto("minLength", l.Min.ToString(System.Globalization.CultureInfo.InvariantCulture), own, conditional),
            ILengthValidator l => new ModelRuleDto("length", $"{l.Min}..{l.Max}", own, conditional),
            IRegularExpressionValidator r => new ModelRuleDto("pattern", r.Expression, own, conditional),
            IEnumValidator => new ModelRuleDto("enum", null, own, conditional),
            IComparisonValidator { Comparison: Comparison.NotEqual } n => new ModelRuleDto("notEqual", ValueText(n.ValueToCompare, type), own, conditional),
            IComparisonValidator { Comparison: Comparison.Equal } e => new ModelRuleDto("equal", ValueText(e.ValueToCompare, type), own, conditional),
            _ => new ModelRuleDto("code", null, own, conditional),
        };
    }

    /// <summary>A compared value as the API writes it: an enum as its number (as the DTOs serialize it), else as text.</summary>
    private static string? ValueText(object? value, Type type) => value switch
    {
        null => null,
        Enum e => Convert.ToInt64(e, System.Globalization.CultureInfo.InvariantCulture).ToString(System.Globalization.CultureInfo.InvariantCulture),
        IFormattable f => f.ToString(null, System.Globalization.CultureInfo.InvariantCulture),
        _ => value.ToString(),
    };

    private static string TypeOf(Type t)
    {
        var u = Nullable.GetUnderlyingType(t) ?? t;
        if (u == typeof(string)) return "string";
        if (u == typeof(Guid)) return "guid";
        if (u == typeof(bool)) return "boolean";
        if (u.IsEnum) return "enum";
        if (u == typeof(int) || u == typeof(long) || u == typeof(short)) return "integer";
        if (u == typeof(decimal) || u == typeof(double) || u == typeof(float)) return "number";
        if (u == typeof(DateTime) || u == typeof(DateTimeOffset)) return "datetime";
        if (u != typeof(string) && typeof(IEnumerable).IsAssignableFrom(u))
        {
            var item = u.IsArray ? u.GetElementType() : u.GetGenericArguments().FirstOrDefault();
            return item is null ? "list" : $"{TypeOf(item)}[]";
        }
        return "object";
    }

    private static IReadOnlyList<ModelEnumValueDto>? EnumValues(Type t)
    {
        var u = Nullable.GetUnderlyingType(t) ?? t;
        if (!u.IsEnum) return null;
        return Enum.GetValues(u).Cast<Enum>()
            .Select(e => new ModelEnumValueDto(Convert.ToInt64(e, System.Globalization.CultureInfo.InvariantCulture), e.ToString()))
            .OrderBy(e => e.Value)
            .ToList();
    }

    // A strong validator for If-None-Match: the description changes only when BaseApi is redeployed with other rules.
    private static string ETagOf(ModelFieldsDto dto)
    {
        var text = JsonSerializer.Serialize(dto);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..16].ToLowerInvariant();
    }
}

internal sealed record ModelFieldsSnapshot(ModelFieldsDto Dto, string ETag);
