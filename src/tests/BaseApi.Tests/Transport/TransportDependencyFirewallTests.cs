using System.Reflection;
using Messaging.Transport;
using Xunit;

namespace BaseApi.Tests.Transport;

public sealed class TransportDependencyFirewallTests
{
    [Fact]
    public void TransportReferencesNoWebOrDataStack()
    {
        var referenced = typeof(RabbitMqConnection).Assembly
            .GetReferencedAssemblies()
            .Select(a => a.Name ?? string.Empty)
            .ToArray();

        Assert.DoesNotContain(referenced, n => n.StartsWith("Microsoft.AspNetCore", StringComparison.Ordinal));
        Assert.DoesNotContain(referenced, n => n.StartsWith("Microsoft.EntityFrameworkCore", StringComparison.Ordinal));
        Assert.DoesNotContain(referenced, n => n.StartsWith("Swashbuckle", StringComparison.Ordinal));
    }
}
