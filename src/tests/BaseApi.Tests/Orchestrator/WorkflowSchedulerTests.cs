using System.Collections.Specialized;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Orchestrator.Scheduling;
using Quartz;
using Quartz.Impl;
using Quartz.Impl.Matchers;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// What the scheduler puts into the job store, asserted against a real RAM-backed Quartz scheduler
/// that is never started — so the store can be read back exactly as the fire path will find it, with
/// nothing ever firing and no timing to be flaky about.
/// <para>
/// The job-data map is the reason this file exists. The fire job reads the ids, the entry index and the cron out of it, and its
/// supersession check is only as sound as the <c>jobId</c> entry written here (the activation id); a fake scheduler in the
/// fire job's own tests would assert against a map the fire job's test wrote, which proves nothing
/// about the map this class writes.
/// </para>
/// </summary>
public sealed class WorkflowSchedulerTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly DateTime Now = new(2026, 8, 20, 12, 30, 0, DateTimeKind.Utc);
    private const string EveryHour = "0 * * * *";

    /// <summary>
    /// Stands in for <c>WorkflowFireJob</c>, and is never executed — the scheduler under test is never
    /// started, so nothing here fires. What the job type is only matters to the job detail this class
    /// writes, which is what these tests read back.
    /// </summary>
    private sealed class NoopJob : IJob
    {
        public Task Execute(IJobExecutionContext context) => Task.CompletedTask;
    }

    private static async Task WithSchedulerAsync(
        Func<IScheduler, FakeTimeProvider, WorkflowScheduler<NoopJob>, Task> body)
    {
        // A unique instance name per test: StdSchedulerFactory publishes into a process-wide
        // repository keyed by that name, and a shared one would let one test read another's job
        // store — or silently hand two tests the same scheduler.
        var factory = new StdSchedulerFactory(new NameValueCollection
        {
            ["quartz.scheduler.instanceName"] = "test-" + Guid.NewGuid().ToString("N"),
            ["quartz.jobStore.type"] = "Quartz.Simpl.RAMJobStore, Quartz",
            ["quartz.threadPool.type"] = "Quartz.Simpl.DefaultThreadPool, Quartz",
            ["quartz.threadPool.maxConcurrency"] = "1",
        });

        // The subject takes the factory, not the scheduler — the body still gets the scheduler to
        // read the job store back, and it is the same instance, because GetScheduler returns what
        // this factory's instance name already resolves to in the repository.
        var scheduler = await factory.GetScheduler();

        var clock = new FakeTimeProvider(new DateTimeOffset(Now, TimeSpan.Zero));
        var sut = new WorkflowScheduler<NoopJob>(
            factory, clock, NullLogger<WorkflowScheduler<NoopJob>>.Instance);

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

    private static JobKey KeyOf(Guid workflowId, Guid activationId, int index) =>
        new($"{activationId:D}/{index}", workflowId.ToString("D"));

    private static async Task<IReadOnlyCollection<JobKey>> JobsOfAsync(IScheduler quartz, Guid workflowId) =>
        await quartz.GetJobKeys(GroupMatcher<JobKey>.GroupEquals(workflowId.ToString("D")));

    [Fact]
    public Task SchedulesAOneShotJobKeyedByActivationAndIndexCarryingAllFourValues() => WithSchedulerAsync(
        async (quartz, _, sut) =>
        {
            var activationId = Guid.NewGuid();

            await sut.ScheduleAsync(W, activationId, 0, EveryHour, CancellationToken.None);

            var key = KeyOf(W, activationId, 0);
            var detail = await quartz.GetJobDetail(key);
            Assert.NotNull(detail);
            Assert.Equal(W.ToString("D"), detail.JobDataMap.GetString("workflowId"));
            Assert.Equal(activationId.ToString("D"), detail.JobDataMap.GetString("jobId"));

            var trigger = Assert.Single(await quartz.GetTriggersOfJob(key));
            Assert.IsAssignableFrom<ISimpleTrigger>(trigger);
            Assert.Equal(new TriggerKey(key.Name, key.Group), trigger.Key);
            Assert.Equal(Utc(13, 0), trigger.StartTimeUtc);
        });

    [Fact]
    public Task JobsOfOneWorkflowShareItsQuartzGroup() => WithSchedulerAsync(
        async (quartz, _, sut) =>
        {
            var activationId = Guid.NewGuid();

            await sut.ScheduleAsync(W, activationId, 0, EveryHour, CancellationToken.None);
            await sut.ScheduleAsync(W, activationId, 1, "*/10 * * * * *", CancellationToken.None);

            var names = (await JobsOfAsync(quartz, W)).Select(k => k.Name).Order(StringComparer.Ordinal);
            Assert.Equal(
                new[] { $"{activationId:D}/0", $"{activationId:D}/1" }.Order(StringComparer.Ordinal),
                names);
        });

    [Fact]
    public Task UnscheduleWorkflowRemovesEveryJobOfThatWorkflowOnly() => WithSchedulerAsync(
        async (quartz, _, sut) =>
        {
            var other = Guid.Parse("22222222-2222-2222-2222-222222222222");
            var a1 = Guid.NewGuid();
            var a2 = Guid.NewGuid();
            await sut.ScheduleAsync(W, a1, 0, EveryHour, CancellationToken.None);
            await sut.ScheduleAsync(W, a1, 1, EveryHour, CancellationToken.None);
            await sut.ScheduleAsync(other, a2, 0, EveryHour, CancellationToken.None);
            await sut.ScheduleAsync(other, a2, 1, EveryHour, CancellationToken.None);

            await sut.UnscheduleWorkflowAsync(W, CancellationToken.None);

            Assert.Empty(await JobsOfAsync(quartz, W));
            Assert.Empty(await quartz.GetTriggersOfJob(KeyOf(W, a1, 0)));
            Assert.Empty(await quartz.GetTriggersOfJob(KeyOf(W, a1, 1)));
            Assert.Equal(2, (await JobsOfAsync(quartz, other)).Count);
        });

    [Fact]
    public Task TheJobDataMapCarriesIndexAndCron() => WithSchedulerAsync(
        async (quartz, _, sut) =>
        {
            var activationId = Guid.NewGuid();

            await sut.ScheduleAsync(W, activationId, 1, EveryHour, CancellationToken.None);

            var detail = await quartz.GetJobDetail(KeyOf(W, activationId, 1));
            Assert.NotNull(detail);
            Assert.Equal(W.ToString("D"), detail.JobDataMap.GetString(IWorkflowScheduler.WorkflowIdKey));
            Assert.Equal(activationId.ToString("D"), detail.JobDataMap.GetString(IWorkflowScheduler.JobIdKey));
            Assert.Equal("1", detail.JobDataMap.GetString(IWorkflowScheduler.IndexKey));
            Assert.Equal(EveryHour, detail.JobDataMap.GetString(IWorkflowScheduler.CronKey));
        });

    [Fact]
    public Task AGroupWithNoFutureFireDoesNotBlockItsSiblings() => WithSchedulerAsync(
        async (quartz, _, sut) =>
        {
            var activationId = Guid.NewGuid();

            await sut.ScheduleAsync(W, activationId, 0, "0 0 30 2 *", CancellationToken.None);
            await sut.ScheduleAsync(W, activationId, 1, "*/10 * * * * *", CancellationToken.None);

            var key = Assert.Single(await JobsOfAsync(quartz, W));
            Assert.Equal($"{activationId:D}/1", key.Name);
        });

    [Fact]
    public Task SchedulesNothingWhenTheExpressionHasNoFutureOccurrence() => WithSchedulerAsync(
        async (quartz, _, sut) =>
        {
            var activationId = Guid.NewGuid();

            await sut.ScheduleAsync(W, activationId, 0, "0 0 30 2 *", CancellationToken.None);

            Assert.Null(await quartz.GetJobDetail(KeyOf(W, activationId, 0)));
        });

    [Fact]
    public Task ReschedulingAddsATriggerToTheExistingJobRatherThanReAddingTheJob() => WithSchedulerAsync(
        async (quartz, clock, sut) =>
        {
            var activationId = Guid.NewGuid();
            await sut.ScheduleAsync(W, activationId, 0, EveryHour, CancellationToken.None);
            clock.Advance(TimeSpan.FromMinutes(45));   // 13:15 — past the trigger scheduled above

            await sut.RescheduleAsync(W, activationId, 0, EveryHour, CancellationToken.None);

            var key = KeyOf(W, activationId, 0);
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
            // schedule, not throw — and the re-created job must carry every value the purged one did.
            var activationId = Guid.NewGuid();

            await sut.RescheduleAsync(W, activationId, 1, EveryHour, CancellationToken.None);

            var key = KeyOf(W, activationId, 1);
            var detail = await quartz.GetJobDetail(key);
            Assert.NotNull(detail);
            Assert.Equal(W.ToString("D"), detail.JobDataMap.GetString("workflowId"));
            Assert.Equal(activationId.ToString("D"), detail.JobDataMap.GetString("jobId"));
            Assert.Equal("1", detail.JobDataMap.GetString("index"));
            Assert.Equal(EveryHour, detail.JobDataMap.GetString("cron"));
            Assert.Single(await quartz.GetTriggersOfJob(key));
        });
}
