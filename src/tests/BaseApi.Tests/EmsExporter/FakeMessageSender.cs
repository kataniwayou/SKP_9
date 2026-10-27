using Processor.EmsExporter.Ems;

namespace BaseApi.Tests.EmsExporter;

/// <summary>
/// The seam, scripted, after <c>FakeRecordProducer</c>. Every send is recorded; faults are scheduled
/// by position, so a test says "the second send throws" rather than reaching into the step.
/// </summary>
internal sealed class FakeMessageSender : IMessageSender
{
    private int _sendCalls;

    /// <summary>Every send, with the execution id it was asked to stamp in the message's property.</summary>
    public List<(string Queue, byte[] Body, Guid ExecutionId)> Sent { get; } = new();
    public bool Disposed { get; private set; }

    /// <summary>1-based index of the SendAsync call that throws; null means none ever does.</summary>
    public int? SendThrowsOnCall { get; set; }

    /// <summary>1-based index of the SendAsync call that never completes: a server gone quiet.</summary>
    public int? SendHangsOnCall { get; set; }

    public string FaultCode { get; set; } = "SERVER_NOT_CONNECTED";

    /// <summary>
    /// Recorded BEFORE the scheduled fault fires, for <c>FakeRecordProducer</c>'s reason: a send that
    /// throws may still have reached the server.
    /// </summary>
    public Task<string> SendAsync(string queue, byte[] body, Guid executionId, CancellationToken ct)
    {
        _sendCalls++;
        Sent.Add((queue, body, executionId));

        if (_sendCalls == SendThrowsOnCall)
        {
            throw new EmsSendException(FaultCode, "scripted fault");
        }

        if (_sendCalls == SendHangsOnCall)
        {
            return new TaskCompletionSource<string>().Task;
        }

        return Task.FromResult($"ID:EMS-SERVER.{_sendCalls}");
    }

    public void Dispose() => Disposed = true;
}

/// <summary>Hands out scripted senders and counts how often it was asked for a new one.</summary>
internal sealed class FakeMessageSenderFactory(params FakeMessageSender[] senders) : IMessageSenderFactory
{
    private int _created;

    public int Created => _created;

    /// <summary>The delivery timeouts asked for, in order.</summary>
    public List<TimeSpan> Requests { get; } = new();

    /// <summary>True makes <see cref="Create"/> throw, the only hermetic way to reach the Rent failure.</summary>
    public bool CreateThrows { get; set; }

    public IMessageSender Create(TimeSpan deliveryTimeout)
    {
        Requests.Add(deliveryTimeout);
        if (CreateThrows)
        {
            throw new EmsSendException("SERVER_NOT_CONNECTED", "scripted connect fault");
        }

        return senders[_created++];
    }
}
