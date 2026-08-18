using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("BaseApi.Tests")]

// NSubstitute uses Castle DynamicProxy, which emits proxy types into this dynamic assembly.
// Stubbing the internal orchestration seam interfaces requires that proxy assembly to see them;
// this is the canonical mechanism for mocking internal types.
[assembly: InternalsVisibleTo("DynamicProxyGenAssembly2")]
