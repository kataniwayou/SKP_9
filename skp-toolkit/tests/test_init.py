import pathlib
import subprocess
import tempfile
import unittest
import unittest.mock

from skp.clients.cluster import ClusterClient
from skp.clients.http import Unreachable
from skp.clients.pg import Postgres
from skp.profile import Profile
from skp.verbs.init import ClusterProbe, build_clients, probe, render_table
from skp.verbs.init import run as init_run


class Probeable:
    def __init__(self, ok):
        self._ok = ok

    def ping(self):
        return self._ok

    ready = ping


class ProbeTests(unittest.TestCase):
    def clients(self, **overrides):
        base = {name: Probeable(True) for name in
                ("cluster", "postgres", "redis", "rabbitmq", "elasticsearch",
                 "prometheus", "baseapi")}
        base.update(overrides)
        return base

    def test_probe_reports_all_seven_targets_in_a_fixed_order(self):
        rows = probe(self.clients())
        self.assertEqual(
            [name for name, _, _ in rows],
            ["cluster", "postgres", "redis", "rabbitmq", "elasticsearch",
             "prometheus", "baseapi"],
        )
        self.assertTrue(all(ok for _, ok, _ in rows))

    def test_one_dead_target_is_a_named_red_row_not_a_crash(self):
        rows = probe(self.clients(elasticsearch=Probeable(False)))
        failed = [name for name, ok, _ in rows if not ok]
        self.assertEqual(failed, ["elasticsearch"])

    def test_the_table_marks_each_row_and_names_the_dead_one(self):
        table = render_table(probe(self.clients(redis=Probeable(False))))
        self.assertIn("redis", table)
        self.assertIn("UNREACHABLE", table)
        self.assertIn("ok", table)

    def test_probe_survives_a_client_missing_both_methods(self):
        class Neither:
            pass

        rows = probe(self.clients(baseapi=Neither()))
        self.assertEqual(len(rows), 7)
        failed = [(name, detail) for name, ok, detail in rows if not ok]
        self.assertEqual(len(failed), 1)
        self.assertIn("neither ping() nor ready()", failed[0][1])

    def test_probe_survives_a_client_whose_check_raises(self):
        class Boom:
            def ping(self):
                raise RuntimeError("connection reset")

        rows = probe(self.clients(redis=Boom()))
        detail = [d for name, ok, d in rows if name == "redis"][0]
        self.assertIn("connection reset", detail)


class MissingBinaryTests(unittest.TestCase):
    def test_no_cluster_cli_still_yields_seven_clients(self):
        profile = Profile(home=pathlib.Path("."), source_root="/src",
                          cluster_url="https://c", project="skp", endpoints={})
        with unittest.mock.patch("skp.verbs.init.detect_binary",
                                 side_effect=Unreachable("cluster", "no oc or kubectl")):
            clients = build_clients(profile)
        self.assertEqual(len(clients), 7)
        self.assertFalse(clients["postgres"].ping())
        self.assertFalse(clients["cluster"].ping())


class ScriptedRunner:
    """Returns `config_result` for the `config view` call ClusterClient uses
    to verify the active kube context, and `result` for everything else."""

    def __init__(self, server, stdout="ok", returncode=0, stderr=""):
        self.calls: list[list[str]] = []
        self.result = subprocess.CompletedProcess([], returncode, stdout, stderr)
        self.config_result = subprocess.CompletedProcess([], 0, server, "")

    def __call__(self, argv, capture_output=True, text=True, timeout=None):
        self.calls.append(argv)
        if "config" in argv and "view" in argv:
            return self.config_result
        return self.result


class ClusterMismatchDetailTests(unittest.TestCase):
    """Important 1: ClusterClient raises Unreachable("cluster", "profile
    names <X>; the active context is <Y>") on a server mismatch, but every
    cluster-backed ping() caught that and returned a bare False -- so
    `probe` recorded detail="" and the operator never saw the sentence the
    cluster_url work exists to produce."""

    def clients(self, **overrides):
        base = {name: Probeable(True) for name in
                ("cluster", "postgres", "redis", "rabbitmq", "elasticsearch",
                 "prometheus", "baseapi")}
        base.update(overrides)
        return base

    def test_a_mismatch_names_both_servers_on_the_cluster_row(self):
        runner = ScriptedRunner(server="https://other.example:6443")
        cluster = ClusterClient("skp", binary="oc", runner=runner,
                                expected_server="https://cluster.example:6443")
        rows = {name: (ok, detail) for name, ok, detail in
                probe(self.clients(cluster=ClusterProbe(cluster)))}
        ok, detail = rows["cluster"]
        self.assertFalse(ok)
        self.assertIn("cluster.example", detail)
        self.assertIn("other.example", detail)

    def test_the_same_mismatch_makes_the_postgres_row_non_blank(self):
        runner = ScriptedRunner(server="https://other.example:6443")
        cluster = ClusterClient("skp", binary="oc", runner=runner,
                                expected_server="https://cluster.example:6443")
        rows = {name: (ok, detail) for name, ok, detail in
                probe(self.clients(cluster=ClusterProbe(cluster),
                                   postgres=Postgres(cluster)))}
        ok, detail = rows["postgres"]
        self.assertFalse(ok)
        self.assertNotEqual(detail, "")


class _AlwaysOk:
    """Stands in for every reachability probe so refresh tests never touch
    the network or a real cluster."""

    def ping(self):
        return True

    ready = ping


def _fake_build_clients(profile):
    return {name: _AlwaysOk() for name in
            ("cluster", "postgres", "redis", "rabbitmq",
             "elasticsearch", "prometheus", "baseapi")}


class RefreshTests(unittest.TestCase):
    """C1: `skp init --refresh` must not destroy the token or endpoint
    overrides it did not receive on the command line."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.tmp.name) / ".skp"
        self.src = pathlib.Path(self.tmp.name) / "src"
        self.src.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def _run(self, argv):
        with unittest.mock.patch("skp.verbs.init.build_clients",
                                 side_effect=_fake_build_clients):
            return init_run(argv)

    def _first_init(self, **extra):
        argv = ["--home", str(self.home), "--source-root", str(self.src),
                "--cluster-url", "https://c", "--project", "skp"]
        for flag, value in extra.items():
            argv += [f"--{flag.replace('_', '-')}", value]
        self._run(argv)

    def test_a_refresh_with_no_token_preserves_the_stored_token(self):
        self._first_init(token="sha256~ORIGINAL")
        self._run(["--home", str(self.home), "--refresh"])
        self.assertEqual(Profile.load(self.home).token, "sha256~ORIGINAL")

    def test_a_refresh_preserves_a_stored_endpoint_override(self):
        self._run(["--home", str(self.home), "--source-root", str(self.src),
                    "--cluster-url", "https://c", "--project", "skp",
                    "--endpoint", "prometheus=http://custom-prom:9090"])
        self._run(["--home", str(self.home), "--refresh"])
        self.assertEqual(Profile.load(self.home).endpoints["prometheus"],
                         "http://custom-prom:9090")

    def test_a_refresh_with_an_explicit_token_replaces_it(self):
        self._first_init(token="sha256~ORIGINAL")
        self._run(["--home", str(self.home), "--refresh", "--token", "sha256~NEW"])
        self.assertEqual(Profile.load(self.home).token, "sha256~NEW")

    def test_refresh_with_no_memory_folder_routes_to_skp_init(self):
        result = self._run(["--home", str(self.home), "--refresh"])
        self.assertEqual(result.next_command, "skp init")

    def test_refresh_preserves_source_root_and_project_when_omitted(self):
        self._first_init()
        self._run(["--home", str(self.home), "--refresh"])
        profile = Profile.load(self.home)
        self.assertEqual(profile.source_root, str(self.src))
        self.assertEqual(profile.project, "skp")

    def test_an_unknown_endpoint_name_is_rejected_not_silently_persisted(self):
        result = self._run(["--home", str(self.home), "--source-root", str(self.src),
                            "--cluster-url", "https://c", "--project", "skp",
                            "--endpoint", "elastic=http://typo:9200"])
        self.assertNotEqual(result.code, 0)
        self.assertIsNotNone(result.next_command)
        self.assertFalse((self.home / "profile.json").exists())

    def test_postgres_is_not_a_configurable_endpoint(self):
        result = self._run(["--home", str(self.home), "--source-root", str(self.src),
                            "--cluster-url", "https://c", "--project", "skp",
                            "--endpoint", "postgres=http://postgres:5432"])
        self.assertNotEqual(result.code, 0)

    def test_a_valid_endpoint_name_is_accepted(self):
        self._run(["--home", str(self.home), "--source-root", str(self.src),
                   "--cluster-url", "https://c", "--project", "skp",
                   "--endpoint", "prometheus=http://custom-prom:9090"])
        self.assertEqual(Profile.load(self.home).endpoints["prometheus"],
                         "http://custom-prom:9090")

    def test_cluster_url_is_derived_when_absent(self):
        with unittest.mock.patch("skp.verbs.init.detect_binary", return_value="oc"),              unittest.mock.patch("skp.verbs.init.active_server",
                                 return_value="https://derived.example:6443"):
            self._run(["--home", str(self.home), "--source-root", str(self.src),
                       "--project", "skp"])
        self.assertEqual(Profile.load(self.home).cluster_url, "https://derived.example:6443")

    def test_a_supplied_cluster_url_is_kept_as_an_assertion_not_overwritten(self):
        self._first_init()
        self.assertEqual(Profile.load(self.home).cluster_url, "https://c")

    def test_a_failed_derivation_is_EXIT_UNREACHABLE_with_NEXT(self):
        from skp.clients.http import Unreachable as _Unreachable
        with unittest.mock.patch("skp.verbs.init.detect_binary",
                                 side_effect=_Unreachable("cluster", "no oc or kubectl")):
            result = self._run(["--home", str(self.home), "--source-root", str(self.src),
                                "--project", "skp"])
        self.assertNotEqual(result.code, 0)
        self.assertIsNotNone(result.next_command)

    def test_a_fresh_init_missing_a_required_flag_fails_with_NEXT(self):
        result = self._run(["--home", str(self.home), "--source-root", str(self.src)])
        self.assertNotEqual(result.code, 0)
        self.assertIsNotNone(result.next_command)
