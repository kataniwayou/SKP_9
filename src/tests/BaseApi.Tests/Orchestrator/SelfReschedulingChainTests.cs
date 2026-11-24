using System.Collections.Concurrent;
using System.Collections.Specialized;
using System.Globalization;
using Microsoft.Extensions.Logging.Abstractions;
using Orchestrator.Scheduling;
using Quartz;
using Quartz.Impl;
using Quartz.Spi;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// The one test in this branch that proves a workflow fires more than once — and, since each
/// workflow's jobs live in a Quartz group of their own, that two such groups chain side by side
/// without either one's keys colliding with the other's.
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
    private static readonly Guid W1 = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid W2 = Guid.Parse("22222222-2222-2222-2222-222222222222");

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
    /// <para>
    /// One instance serves every job in the store, so it identifies the fire from the job-data map
    /// rather than from fields — which is also what the real job does, and what proves the map the
    /// scheduler wrote carries enough to re-arm the very job it came from.
    /// </para>
    /// </summary>
    private sealed class ReschedulingJob(IReadOnlyCollection<Guid> workflows) : IJob
    {
        private readonly TaskCompletionSource _settled =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        private readonly ConcurrentDictionary<Guid, List<DateTimeOffset>> _fires = new();

        private IWorkflowScheduler? _scheduler;

        /// <summary>Completes once every workflow has fired twice, or on the first fire that throws.</summary>
        public Task Settled => _settled.Task;

        /// <summary>When each workflow's fires were scheduled for, in the order they ran.</summary>
        public IReadOnlyDictionary<Guid, List<DateTimeOffset>> Fires => _fires;

        /// <summary>What a fire threw, if one did. Null is what a working chain leaves behind.</summary>
        public Exception? Failure { get; private set; }

        public void Arm(IWorkflowScheduler scheduler) => _scheduler = scheduler;

        public async Task Execute(IJobExecutionContext context)
        {
            var map = context.MergedJobDataMap;
            var workflowId = Guid.Parse(map.GetString(IWorkflowScheduler.WorkflowIdKey)!);
            var activationId = Guid.Parse(map.GetString(IWorkflowScheduler.JobIdKey)!);
            var index = int.Parse(map.GetString(IWorkflowScheduler.IndexKey)!, CultureInfo.InvariantCulture);
            var cron = map.GetString(IWorkflowScheduler.CronKey)!;

            var fires = _fires.GetOrAdd(workflowId, _ => []);
            lock (fires)
            {
                fires.Add(context.ScheduledFireTimeUtc ?? context.FireTimeUtc);
            }

            try
            {
                // Inside the fire, before anything else, which is the case the type remarks on
                // WorkflowScheduler are about — and the case its own tests could not reach.
                await _scheduler!.RescheduleAsync(workflowId, activationId, index, cron, CancellationToken.None);
            }
            catch (Exception ex)
            {
                Failure = ex;
                _settled.TrySetResult();
                return;
            }

            if (workflows.All(w => _fires.TryGetValue(w, out var f) && Count(f) >= 2))
            {
                _settled.TrySetResult();
            }
        }

        private static int Count(List<DateTimeOffset> fires)
        {
            lock (fires)
            {
                return fires.Count;
            }
        }
    }

    [Fact]
    public async Task EachWorkflowGroupFiresAndArmsItsOwnSuccessor()
    {
        // A unique instance name, as WorkflowSchedulerTests uses and for the same reason:
        // StdSchedulerFactory publishes into a process-wide repository keyed by that name.
        var factory = new StdSchedulerFactory(new NameValueCollection
        {
            ["quartz.scheduler.instanceName"] = "chain-" + Guid.NewGuid().ToString("N"),
            ["quartz.jobStore.type"] = "Quartz.Simpl.RAMJobStore, Quartz",
            ["quartz.threadPool.type"] = "Quartz.Simpl.DefaultThreadPool, Quartz",
            ["quartz.threadPool.maxConcurrency"] = "2",
        });

        var scheduler = await factory.GetScheduler(TestContext.Current.CancellationToken);
        var job = new ReschedulingJob([W1, W2]);
        scheduler.JobFactory = new FixedJobFactory(job);

        // The real clock, not a fake one: the trigger this schedules is fired by Quartz's own timer
        // against real time, so cron arithmetic done on any other clock would arm fire times the
        // scheduler never reaches.
        var sut = new WorkflowScheduler<ReschedulingJob>(
            factory, TimeProvider.System, NullLogger<WorkflowScheduler<ReschedulingJob>>.Instance);

        job.Arm(sut);

        await scheduler.Start(TestContext.Current.CancellationToken);

        try
        {
            // Two groups, one job each, and the same index in both, so a key that dropped its group
            // would collide on the second schedule.
            await sut.ScheduleAsync(W1, Guid.NewGuid(), 0, EverySecond, CancellationToken.None);
            await sut.ScheduleAsync(W2, Guid.NewGuid(), 0, EverySecond, CancellationToken.None);

            // Two fires a second apart per workflow, so twenty seconds is a wide margin on a loaded
            // machine and still a bound — a chain that stops after one fire ends the wait rather than
            // hanging the run. WhenAny rather than WaitAsync so that a stopped chain is reported by
            // the assertions below, which say what happened, instead of by a timeout, which does not.
            await Task.WhenAny(
                job.Settled,
                Task.Delay(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken));
        }
        finally
        {
            await scheduler.Shutdown(
                waitForJobsToComplete: true, TestContext.Current.CancellationToken);
        }

        // Asserted before the counts, because it names the cause. A throw out of RescheduleAsync from
        // inside a fire is the shape the failure would take if a completed trigger were already gone
        // from the store: the reschedule finds no trigger to replace, re-adds a job whose key is still
        // taken, and Quartz swallows the result into a job exception nothing else would report.
        Assert.Null(job.Failure);

        foreach (var w in new[] { W1, W2 })
        {
            Assert.True(job.Fires.TryGetValue(w, out var fires), $"workflow {w} never fired");
            DateTimeOffset[] times;
            lock (fires)
            {
                times = [.. fires];
            }

            Assert.True(times.Length >= 2, $"workflow {w} stopped after {times.Length} fire(s)");
            Assert.Equal(TimeSpan.FromSeconds(1), times[1] - times[0]);
        }
    }
}
