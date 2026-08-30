import unittest

from skp.compile.extract import queues, redis_keys, templates

KEYS = '''
public static class L2ProjectionKeys
{
    public const string Prefix = "skp:";
    public static string Root(Guid workflowId) => $"{Prefix}{workflowId:D}";
    public static string Step(Guid workflowId, Guid stepId) => $"{Prefix}{workflowId:D}:{stepId:D}";
    public static string ExecutionData(Guid id) => $"{Prefix}data:{id:D}";
}
'''

PROCESSOR_QUEUES = '''
public static class ProcessorQueues
{
    public const string IdentityQuery = "processor-identity-query";
    public static string Work(Guid processorId) => $"processor-{processorId:D}";
    public const string DeadLetterExchange = "processor-dlx";
}
'''

ORCHESTRATOR_QUEUES = '''
public static class OrchestratorQueues
{
    public const string Control = "orchestrator-control";
    public const string Result = "orchestrator-result";
}
'''

TEMPLATES = '''
internal static class Templates
{
    public const string RunningTheStep = "running the step";
    public const string StepReturned = "the step returned after {ElapsedMs}ms";
}
'''


class RedisKeyTests(unittest.TestCase):
    def test_the_prefix_is_substituted_not_left_as_a_placeholder(self):
        by_id = {s.id: s for s in redis_keys(KEYS)}
        self.assertEqual(by_id["redis.Root"].detail, "skp:{workflowId}")
        self.assertEqual(by_id["redis.ExecutionData"].detail, "skp:data:{id}")

    def test_every_key_family_is_a_surface_on_the_redis_component(self):
        surfaces = redis_keys(KEYS)
        self.assertEqual(sorted(s.id for s in surfaces),
                         ["redis.ExecutionData", "redis.Root", "redis.Step"])
        self.assertTrue(all(s.component == "redis" for s in surfaces))


class QueueTests(unittest.TestCase):
    def test_constant_and_templated_queues_are_both_surfaces(self):
        by_id = {s.id: s for s in queues(PROCESSOR_QUEUES, ORCHESTRATOR_QUEUES)}
        self.assertEqual(by_id["rabbitmq.processor.IdentityQuery"].detail, "processor-identity-query")
        self.assertEqual(by_id["rabbitmq.processor.Work"].detail, "processor-{processorId}")
        self.assertEqual(by_id["rabbitmq.orchestrator.Control"].detail, "orchestrator-control")

    def test_both_source_files_contribute(self):
        ids = {s.id for s in queues(PROCESSOR_QUEUES, ORCHESTRATOR_QUEUES)}
        self.assertIn("rabbitmq.processor.DeadLetterExchange", ids)
        self.assertIn("rabbitmq.orchestrator.Result", ids)

    def test_a_member_name_declared_in_both_files_yields_two_surfaces(self):
        processor = 'public static class ProcessorQueues { public const string DeadLetterExchange = "processor-dlx"; }'
        orchestrator = 'public static class OrchestratorQueues { public const string DeadLetterExchange = "orchestrator-dlx"; }'
        by_id = {s.id: s.detail for s in queues(processor, orchestrator)}
        self.assertEqual(by_id["rabbitmq.processor.DeadLetterExchange"], "processor-dlx")
        self.assertEqual(by_id["rabbitmq.orchestrator.DeadLetterExchange"], "orchestrator-dlx")


class TemplateTests(unittest.TestCase):
    def test_each_template_is_a_surface_carrying_its_text(self):
        by_id = {s.id: s for s in templates(TEMPLATES)}
        self.assertEqual(by_id["elasticsearch.StepReturned"].detail,
                         "the step returned after {ElapsedMs}ms")
        self.assertEqual(by_id["elasticsearch.StepReturned"].operation,
                         "search by attributes.{OriginalFormat}")
