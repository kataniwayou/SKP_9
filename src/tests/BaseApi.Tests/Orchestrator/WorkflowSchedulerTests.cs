using System.Collections.Specialized;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Orchestrator.Scheduling;
using Quartz;
using Quartz.Impl;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// What the scheduler puts into the job store, asserted against a real RAM-backed Quartz scheduler
/// that is never started — so the store can be read back exactly as the fire path will find it, with
/// nothing ever firing and no timing to be flaky about.
/// <para>
/// The job-data map is the reason this file exists. The fire job reads both ids out of it, and its
/// supersession check is only as sound as the <c>jobId</c> entry written here; a fake scheduler in the
/// fire job's own tests would assert against a map the fire job's test wrote, which proves nothing
/// about the map this class writes.
/// </para>
/// </summary>
public sealed class WorkflowSchedulerTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly DateTime Now = new(2026, 8, 20, 12, 30, 0, DateTimeKind.Utc);
    private const string EveryHour = "0 * * * *";

    /// <summary>Stands in for the fire job, which arrives with a later task. It is never executed.</summary>
    private sealed class NoopJob : IJob
    {
        public Task Execute(IJobExecutionContext context) => Task.CompletedTask;
    }

    private static async Task WithSchedulerAsync(
        Func<IScheduler, FakeTimeProvider, WorkflowScheduler<NoopJob>, Task> body)
    {
        // A unique instance name per test: StdSchedulerFactory publishes into a process-wide
        // repository, and a shared name would let one test read another's job store.
        var scheduler = await new StdSchedulerFactory(new NameValueCollection
        {
            ["quartz.scheduler.instanceName"] = "test-" + Guid.NewGuid().ToString("N"),
            ["quartz.jobStore.type"] = "Quartz.Simpl.RAMJobStore, Quartz",
            ["quartz.threadPool.type"] = "Quartz.Simpl.DefaultThreadPool, Quartz",
            ["quartz.threadPool.maxConcurrency"] = "1",
        }).GetScheduler();

        var clock = new FakeTimeProvider(new DateTimeOffset(Now, TimeSpan.Zero));
        var sut = new WorkflowScheduler<NoopJob>(
            scheduler, clock, NullLogger<WorkflowScheduler<NoopJob>>.Instance);

        try
        {
            await body(scheduler, clock, sut);
        }
        finally
        {
            await scheduler.Shutdown();
        }
    }

    private static DateTimeOffset Utc(int hour, int minute) =>
        new(new DateTime(2026, 8, 20, hour, minute, 0, DateTimeKind.Utc), TimeSpan.Zero);

    [Fact]
    public Task SchedulesAOneShotJobKeyedByJobIdCarryingBothIds() => WithSchedulerAsync(
        async (quartz, _, sut) =>
        {
            var jobId = Guid.NewGuid();

            await sut.ScheduleAsync(W, jobId, EveryHour, CancellationToken.None);

            var key = new JobKey(jobId.ToString("D"));
            var detail = await quartz.GetJobDetail(key);
            Assert.NotNull(detail);
            Assert.Equal(W.ToString("D"), detail.JobDataMap.GetString("workflowId"));
            Assert.Equal(jobId.ToString("D"), detail.JobDataMap.GetString("jobId"));

            var trigger = Assert.Single(await quartz.GetTriggersOfJob(key));
            Assert.IsAssignableFrom<ISimpleTrigger>(trigger);
            Assert.Equal(Utc(13, 0), trigger.StartTimeUtc);
        });

    [Fact]
    public Task SchedulesNothingWhenTheExpressionHasNoFutureOccurrence() => WithSchedulerAsync(
        async (quartz, _, sut) =>
        {
            var jobId = Guid.NewGuid();

            await sut.ScheduleAsync(W, jobId, "0 0 30 2 *", CancellationToken.None);

            Assert.Null(await quartz.GetJobDetail(new JobKey(jobId.ToString("D"))));
        });

    [Fact]
    public Task ReschedulingAddsATriggerToTheExistingJobRatherThanReAddingTheJob() => WithSchedulerAsync(
        async (quartz, clock, sut) =>
        {
            var jobId = Guid.NewGuid();
            await sut.ScheduleAsync(W, jobId, EveryHour, CancellationToken.None);
            clock.Advance(TimeSpan.FromMinutes(45));   // 13:15 — past the trigger scheduled above

            await sut.RescheduleAsync(W, jobId, EveryHour, CancellationToken.None);

            var key = new JobKey(jobId.ToString("D"));
            var detail = await quartz.GetJobDetail(key);
            Assert.NotNull(detail);
            Assert.Equal(W.ToString("D"), detail.JobDataMap.GetString("workflowId"));

            // One trigger, not two: re-adding the job on the same key would collide, and adding a
            // second trigger would double-fire the workflow every tick.
            var trigger = Assert.Single(await quartz.GetTriggersOfJob(key));
            Assert.Equal(Utc(14, 0), trigger.StartTimeUtc);
        });

    [Fact]
    public Task ReschedulingRecreatesTheJobQuartzHasAlreadyPurged() => WithSchedulerAsync(
        async (quartz, _, sut) =>
        {
            // A non-durable one-shot is auto-purged once it has no triggers, so the fire job's own
            // self-reschedule routinely finds nothing to attach to. That must re-establish the
            // schedule, not throw.
            var jobId = Guid.NewGuid();

            await sut.RescheduleAsync(W, jobId, EveryHour, CancellationToken.None);

            var key = new JobKey(jobId.ToString("D"));
            var detail = await quartz.GetJobDetail(key);
            Assert.NotNull(detail);
            Assert.Equal(W.ToString("D"), detail.JobDataMap.GetString("workflowId"));
            Assert.Equal(jobId.ToString("D"), detail.JobDataMap.GetString("jobId"));
            Assert.Single(await quartz.GetTriggersOfJob(key));
        });

    [Fact]
    public Task UnschedulingRemovesTheJobAndItsTriggers() => WithSchedulerAsync(
        async (quartz, _, sut) =>
        {
            var jobId = Guid.NewGuid();
            await sut.ScheduleAsync(W, jobId, EveryHour, CancellationToken.None);

            await sut.UnscheduleAsync(jobId, CancellationToken.None);

            var key = new JobKey(jobId.ToString("D"));
            Assert.Null(await quartz.GetJobDetail(key));
            Assert.Empty(await quartz.GetTriggersOfJob(key));
        });
}
