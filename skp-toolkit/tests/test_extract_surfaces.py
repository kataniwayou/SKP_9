import unittest

from skp.compile.catalog import CatalogError
from skp.compile.extract import metrics, pg_tables, rest_endpoints

METRICS_A = 'internal const string DepthInstrument = "pipeline.queue.depth";'
METRICS_B = 'Meter.CreateCounter<long>(\n  "pipeline.messages.consumed", "{message}");'

WORKFLOW_CONTROLLER = '''
public sealed class WorkflowsController :
    BaseController<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto>
{
}
'''

PROCESSOR_CONTROLLER = '''
public sealed class ProcessorsController :
    BaseController<ProcessorEntity, ProcessorCreateDto, ProcessorUpdateDto, ProcessorReadDto>
{
    [HttpGet("by-source-hash/{sourceHash}")]
    public async Task<ActionResult<ProcessorReadDto>> GetBySourceHash(string sourceHash) => null;
}
'''

ORCHESTRATION_CONTROLLER = '''
public sealed class OrchestrationController : ControllerBase
{
    [HttpPost("start")]
    public async Task<IActionResult> Start() => null;

    [HttpPost("stop")]
    public async Task<IActionResult> Stop() => null;
}
'''

BARE_ATTR_NON_INHERITING_CONTROLLER = '''
public sealed class StatusController : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get() => null;
}
'''

DBCONTEXT = '''
    public DbSet<SchemaEntity> Schemas => Set<SchemaEntity>();
    public DbSet<StepNextSteps> StepNextSteps => Set<StepNextSteps>();
'''


class MetricTests(unittest.TestCase):
    def test_instruments_are_found_across_files_and_declaration_shapes(self):
        found = {s.id for s in metrics([METRICS_A, METRICS_B])}
        self.assertEqual(found, {"prometheus.pipeline_queue_depth",
                                 "prometheus.pipeline_messages_consumed"})

    def test_the_id_is_derived_from_the_instrument_name(self):
        surfaces = metrics([METRICS_A])
        self.assertEqual(surfaces[0].id, "prometheus.pipeline_queue_depth")

    def test_an_instrument_with_no_recognisable_call_site_still_reports_a_detail(self):
        # METRICS_A is just a const declaration -- no Meter.Create* call at all -- so
        # _file_dimensions finds nothing for it. That must read as "no labels", not
        # crash or silently omit the labels half of detail.
        surfaces = metrics([METRICS_A])
        self.assertIn("pipeline.queue.depth", surfaces[0].detail)
        self.assertIn("no labels", surfaces[0].detail)

    def test_non_pipeline_literals_are_ignored(self):
        self.assertEqual(metrics(['x("http.server.duration");']), [])


class RestTests(unittest.TestCase):
    def test_an_entity_controller_yields_the_five_inherited_verbs(self):
        surfaces = rest_endpoints({"WorkflowController.cs": WORKFLOW_CONTROLLER})
        self.assertEqual(
            sorted(s.operation for s in surfaces),
            ["DELETE /api/v1.0/workflows/{id}",
             "GET /api/v1.0/workflows",
             "GET /api/v1.0/workflows/{id}",
             "POST /api/v1.0/workflows",
             "PUT /api/v1.0/workflows/{id}"])

    def test_a_declared_route_is_added_to_the_inherited_five(self):
        operations = {s.operation for s in
                      rest_endpoints({"ProcessorController.cs": PROCESSOR_CONTROLLER})}
        self.assertIn("GET /api/v1.0/processors/by-source-hash/{sourceHash}", operations)
        self.assertEqual(len(operations), 6)

    def test_a_plain_controller_yields_only_its_declared_routes(self):
        operations = {s.operation for s in
                      rest_endpoints({"OrchestrationController.cs": ORCHESTRATION_CONTROLLER})}
        self.assertEqual(operations, {"POST /api/v1.0/orchestration/start",
                                      "POST /api/v1.0/orchestration/stop"})


    def test_zero_controller_classes_in_a_file_raises(self):
        # Merge-blocking minor: `finditer` (looping over every match) is the
        # wrong fix for "what if there's more than one" -- _INHERITS_BASE is
        # tested per file, so two classes would each get the five inherited
        # verbs and one would get five fabricated endpoints. Raising is the
        # fix; this covers the "found none" half of "exactly one".
        with self.assertRaises(CatalogError) as caught:
            rest_endpoints({"NotAController.cs": "public sealed class Plain { }"})
        self.assertIn("NotAController.cs", str(caught.exception))

    def test_two_controller_classes_in_one_file_raises_rather_than_fabricating(self):
        text = ("public sealed class FooController : BaseController<A, B, C, D> { } "
                "public sealed class BarController : BaseController<A, B, C, D> { }")
        with self.assertRaises(CatalogError) as caught:
            rest_endpoints({"TwoControllers.cs": text})
        self.assertIn("TwoControllers.cs", str(caught.exception))

    def test_a_bare_attribute_on_a_non_inheriting_controller_is_a_surface(self):
        # I8: `if not tail: continue` used to apply to every controller, but is
        # only correct for BaseController<...> subclasses (where the bare
        # attribute is the already-covered inherited route). A controller that
        # does NOT inherit -- OrchestrationController's real shape -- must not
        # silently drop a bare [HttpGet].
        surfaces = rest_endpoints(
            {"StatusController.cs": BARE_ATTR_NON_INHERITING_CONTROLLER})
        self.assertEqual([s.operation for s in surfaces], ["GET /api/v1.0/status"])


class PgTests(unittest.TestCase):
    def test_entity_and_junction_tables_are_both_surfaces(self):
        by_id = {s.id: s for s in pg_tables(DBCONTEXT)}
        self.assertEqual(sorted(by_id), ["postgres.Schemas", "postgres.StepNextSteps"])
        self.assertEqual(by_id["postgres.Schemas"].operation, 'SELECT ... FROM "Schemas"')
