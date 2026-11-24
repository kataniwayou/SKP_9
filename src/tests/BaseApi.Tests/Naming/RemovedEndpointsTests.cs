using System.Reflection;
using BaseApi.Service;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Routing;
using Xunit;

namespace BaseApi.Tests.Naming;

/// <summary>
/// The endpoints only WorkflowStudio and Valence called were removed with them (2026-11-24): Acto, the one client,
/// saves through /model/apply and checks through /model/validate and POST /workflows/{id}/validate. This pins that
/// they stay gone, and that the ones Acto uses stay.
/// </summary>
public sealed class RemovedEndpointsTests
{
    private static IReadOnlyList<(string Verb, string Template)> Routes() =>
        typeof(AppDbContext).Assembly.GetTypes()
            .Where(t => typeof(ControllerBase).IsAssignableFrom(t) && !t.IsAbstract)
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            .SelectMany(m => m.GetCustomAttributes<HttpMethodAttribute>())
            .SelectMany(a => a.HttpMethods.Select(v => (v, a.Template ?? "")))
            .ToList();

    [Theory]
    [InlineData("PUT", "{id:guid}/design")]
    [InlineData("GET", "{id:guid}/layout")]
    [InlineData("PUT", "{id:guid}/layout")]
    [InlineData("GET", "{id:guid}/graph")]
    [InlineData("PUT", "{id:guid}/graph")]
    [InlineData("POST", "{id:guid}/delete")]
    [InlineData("GET", "api/v{version:apiVersion}/model/fields")]
    [InlineData("GET", "api/v{version:apiVersion}/model/relations")]
    [InlineData("GET", "api/v{version:apiVersion}/workflows/{id:guid}/molecule")]
    public void AnEndpointOnlyTheRemovedAppsCalledIsGone(string verb, string template)
    {
        Assert.DoesNotContain((verb, template), Routes());
    }

    [Theory]
    [InlineData("POST", "api/v{version:apiVersion}/model/apply")]
    [InlineData("POST", "api/v{version:apiVersion}/model/validate")]
    [InlineData("POST", "{id:guid}/validate")]
    [InlineData("PUT", "{id:guid}/diagram")]
    [InlineData("GET", "{id:guid}.svg")]
    public void AnEndpointActoOrTheDashboardCallsStays(string verb, string template)
    {
        Assert.Contains((verb, template), Routes());
    }
}
