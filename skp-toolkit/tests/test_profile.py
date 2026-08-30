import json
import pathlib
import tempfile
import unittest

from skp.profile import Profile, ProfileMissing, not_initialised, redact
from skp.result import EXIT_NOT_INITIALISED


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.tmp.name) / ".skp"

    def tearDown(self):
        self.tmp.cleanup()

    def make(self) -> Profile:
        return Profile(
            home=self.home,
            source_root="/repo/src",
            cluster_url="https://api.dev.example:6443",
            project="skp",
            endpoints={"prometheus": "http://prometheus:9090"},
        )

    def test_token_is_not_written_into_profile_json(self):
        self.make().save(token="sha256~SECRETVALUE")
        text = (self.home / "profile.json").read_text(encoding="utf-8")
        self.assertNotIn("SECRETVALUE", text)
        self.assertEqual(json.loads(text)["project"], "skp")

    def test_token_round_trips_through_its_own_file(self):
        self.make().save(token="sha256~SECRETVALUE")
        self.assertEqual(Profile.load(self.home).token, "sha256~SECRETVALUE")

    def test_load_without_init_raises(self):
        with self.assertRaises(ProfileMissing):
            Profile.load(self.home)

    def test_not_initialised_routes_back_to_init(self):
        result = not_initialised()
        self.assertEqual(result.code, EXIT_NOT_INITIALISED)
        self.assertEqual(result.next_command, "skp init")

    def test_redact_masks_every_occurrence(self):
        masked = redact("Bearer S3CRET and again S3CRET", "S3CRET")
        self.assertEqual(masked, "Bearer <token from profile> and again <token from profile>")

    def test_redact_is_a_no_op_for_an_empty_token(self):
        self.assertEqual(redact("nothing to hide", ""), "nothing to hide")
