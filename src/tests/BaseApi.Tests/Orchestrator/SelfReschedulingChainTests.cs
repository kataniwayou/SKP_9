using System.Collections.Specialized;
using Microsoft.Extensions.Logging.Abstractions;
using Orchestrator.Scheduling;
using Quartz;
using Quartz.Impl;
using Quartz.Spi;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// The one test in this branch that proves a workflow fires more than once.
/// <para>
/// <b>Every other scheduling test proves a half that never meets the other.</b>
/// <c>WorkflowSchedulerTests</c> reads the job store back through a scheduler it deliberately never
/// starts, so nothing there ever fires; <c>WorkflowFireJobTests</c> calls <c>Execute</c> directly
/// against a recording scheduler, so nothing there is a Quartz fire. The mechanism that keeps a
/// workflow alive — a no-repeat trigger firing, the fire calling <c>RescheduleAsync</c> from inside
/// itself, and the successor arming — exists only in the seam between the two.
/// </para>
/// <para>
/// <b>And that seam rests on a claim about Quartz's internals</b> that <c>WorkflowScheduler</c>'s own
/// remarks state and nothing else checked: that a completed no-repeat trigger is still in the store
/// while <c>Execute</c> is on the stack, so <c>RescheduleJob</c> on that trigger's own key replaces it
/// rather than finding nothing. If that were wrong, every workflow on every replica would fire exactly
/// once and stop — no exception, no log, no probe. This test is what makes it a checked claim.
/// </para>
/// <para>
/// <b>Hermetic, and bounded on a signal rather than a sleep.</b> A RAM job store and a real clock,
/// no broker and no Redis; the job under the trigger does nothing but reschedule itself and count.
/// The wait ends on the second fire or on the first exception out of a fire, so a broken chain fails
/// in milliseconds with the reason attached instead of burning the timeout.
/// </para>
/// </summary>
public sealed class SelfReschedulingChainTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");

    /// <summary>Six fields, so the leading one is seconds: every second.</summary>
    private const string EverySecond = "* * * * * *";

    /// <summary>
    /// Hands Quartz the one job instance the test is holding. The real path builds a fresh job per
    /// fire out of the DI container, which this cannot do — the job needs a reference to the very
    /// scheduler wrapper under test — and none of what is being asserted here is about job
    /// construction.
    /// </summary>
    private sealed class FixedJobFactory(IJob job) : IJobFactory
    {
        public IJob NewJob(TriggerFiredBundle bundle, IScheduler scheduler) => job;

        public void ReturnJob(IJob job)
        {
        }
    }

    /// <summary>
    /// A stand-in for <c>WorkflowFireJob</c> reduced to the one thing this test is about: it arms its
    /// successor from inside its own fire, exactly where the real job does (spec §8.3, step 4).
    /// </summary>
    private sealed class ReschedulingJob : IJob
    {
        private readonly TaskCompletionSource _settled =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        private IWorkflowScheduler? _scheduler;
        private Guid _jobId;
        private int _fires;

        /// <summary>Completes on the second fire, or on the first fire that throws.</summary>
        public Task Settled => _settled.Task;

        /// <summary>How many times Quartz has run this job.</summary>
        public int Fires => Volatile.Read(ref _fires);

        /// <summary>What a fire threw, if one did. Null is what a working chain leaves behind.</summary>
        public Exception? Failure { get; private set; }

        public void Arm(IWorkflowScheduler scheduler, Guid jobId)
        {
            _scheduler = scheduler;
            _jobId = jobId;
        }

        public async Task Execute(IJobExecutionContext context)
        {
            var count = Interlocked.Increment(ref _fires);

            try
            {
                // Inside the fire, before anything else, which is the case the type remarks on
                // WorkflowScheduler are about — and the case its own tests could not reach.
                await _scheduler!.RescheduleAsync(W, _jobId, EverySecond, CancellationToken.None);
            }
            catch (Exception ex)
            {
                Failure = ex;
                _settled.TrySetResult();
                return;
            }

            if (count >= 2)
            {
                _settled.TrySetResult();
            }
        }
    }

    [Fact]
    public async Task AFireArmsItsOwnSuccessorSoTheWorkflowKeepsFiring()
    {
        // A unique instance name, as WorkflowSchedulerTests uses and for the same reason:
        // StdSchedulerFactory publishes into a process-wide repository keyed by that name.
        var factory = new StdSchedulerFactory(new NameValueCollection
        {
            ["quartz.scheduler.instanceName"] = "chain-" + Guid.NewGuid().ToString("N"),
            ["quartz.jobStore.type"] = "Quartz.Simpl.RAMJobStore, Quartz",
            ["quartz.threadPool.type"] = "Quartz.Simpl.DefaultThreadPool, Quartz",
            ["quartz.threadPool.maxConcurrency"] = "1",
        });

        var scheduler = await factory.GetScheduler(TestContext.Current.CancellationToken);
        var job = new ReschedulingJob();
        scheduler.JobFactory = new FixedJobFactory(job);

        // The real clock, not a fake one: the trigger this schedules is fired by Quartz's own timer
        // against real time, so cron arithmetic done on any other clock would arm fire times the
        // scheduler never reaches.
        var sut = new WorkflowScheduler<ReschedulingJob>(
            factory, TimeProvider.System, NullLogger<WorkflowScheduler<ReschedulingJob>>.Instance);

        var jobId = Guid.NewGuid();
        job.Arm(sut, jobId);

        await scheduler.Start(TestContext.Current.CancellationToken);

        try
        {
            await sut.ScheduleAsync(W, jobId, EverySecond, CancellationToken.None);

            // Two fires a second apart, so twenty seconds is a wide margin on a loaded machine and
            // still a bound — a chain that stops after one fire ends the wait rather than hanging the
            // run. WhenAny rather than WaitAsync so that a stopped chain is reported by the assertions
            // below, which say what happened, instead of by a timeout, which does not.
            await Task.WhenAny(
                job.Settled,
                Task.Delay(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken));
        }
        finally
        {
            await scheduler.Shutdown(
                waitForJobsToComplete: true, TestContext.Current.CancellationToken);
        }

        // Asserted before the count, because it names the cause. A throw out of RescheduleAsync from
        // inside a fire is the shape the failure would take if a completed trigger were already gone
        // from the store: the reschedule finds no trigger to replace, re-adds a job whose key is still
        // taken, and Quartz swallows the result into a job exception nothing else would report.
        Assert.Null(job.Failure);
        Assert.True(job.Fires >= 2, $"the chain stopped after {job.Fires} fire(s)");
    }
}
