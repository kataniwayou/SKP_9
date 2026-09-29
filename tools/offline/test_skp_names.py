import io
import unittest

import skp_names


class Fake:
    """A socket stand-in: records what was sent, replays canned RESP replies."""

    def __init__(self, replies):
        self._in = io.BytesIO(replies)
        self.sent = b""

    def sendall(self, data):
        self.sent += data

    def makefile(self, mode):
        return self._in

    def close(self):
        pass


class SkpNamesTests(unittest.TestCase):
    def test_base_name_strips_the_suffix(self):
        self.assertEqual("split-importer_1.0.0",
                         skp_names.base_name("split-importer_1.0.0-9aff-a7f22ee09224"))

    def test_base_name_leaves_a_fallback_alone(self):
        self.assertEqual("9aff-a7f22ee09224", skp_names.base_name("9aff-a7f22ee09224"))

    def test_is_fallback(self):
        self.assertTrue(skp_names.is_fallback("9aff-a7f22ee09224"))
        self.assertFalse(skp_names.is_fallback("split-importer_1.0.0-9aff-a7f22ee09224"))

    def test_scan_then_mget(self):
        # SCAN returns cursor "0" and two keys; MGET returns one value and one nil.
        replies = (b"*2\r\n$1\r\n0\r\n*2\r\n"
                   b"$45\r\nskp:name:208cba76-d635-4721-9aff-a7f22ee09224\r\n"
                   b"$45\r\nskp:name:11111111-1111-1111-1111-111111111111\r\n"
                   b"*2\r\n$29\r\nchain_1.0.0-9aff-a7f22ee09224\r\n$-1\r\n")
        sock = Fake(replies)

        names = skp_names.read_names_from(sock)

        self.assertEqual({"208cba76-d635-4721-9aff-a7f22ee09224": "chain_1.0.0-9aff-a7f22ee09224"}, names)
        self.assertIn(b"SCAN", sock.sent)
        self.assertIn(b"skp:name:*", sock.sent)
        self.assertIn(b"MGET", sock.sent)

    def test_read_name_from_found(self):
        value = "chain_1.0.0-9aff-a7f22ee09224"
        replies = f"${len(value)}\r\n{value}\r\n".encode()
        sock = Fake(replies)

        name = skp_names.read_name_from(sock, "208cba76-d635-4721-9aff-a7f22ee09224")

        self.assertEqual(value, name)
        self.assertIn(b"GET", sock.sent)
        self.assertIn(b"skp:name:208cba76-d635-4721-9aff-a7f22ee09224", sock.sent)

    def test_read_name_from_missing(self):
        sock = Fake(b"$-1\r\n")

        name = skp_names.read_name_from(sock, "11111111-1111-1111-1111-111111111111")

        self.assertIsNone(name)


if __name__ == "__main__":
    unittest.main()
