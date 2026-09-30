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


def _bulk(s):
    """A RESP bulk string, sized off its UTF-8 BYTE length, exactly like skp_names._command."""
    b = s.encode("utf-8")
    return b"$" + str(len(b)).encode() + b"\r\n" + b + b"\r\n"


def _array(*items):
    return b"*" + str(len(items)).encode() + b"\r\n" + b"".join(items)


def _err(message):
    return b"-" + message.encode() + b"\r\n"


class SkpNamesTests(unittest.TestCase):
    def test_base_name_strips_the_suffix(self):
        self.assertEqual("split-importer_1.0.0",
                         skp_names.base_name("split-importer_1.0.0-9aff-a7f22ee09224"))

    def test_base_name_leaves_a_fallback_alone(self):
        self.assertEqual("9aff-a7f22ee09224", skp_names.base_name("9aff-a7f22ee09224"))

    def test_is_fallback(self):
        self.assertTrue(skp_names.is_fallback("9aff-a7f22ee09224"))
        self.assertFalse(skp_names.is_fallback("split-importer_1.0.0-9aff-a7f22ee09224"))

    def test_scan_filters_to_entity_hashes_then_hgets_name(self):
        # One SCAN per kind (wf, step, proc), each returning cursor "0". The wf scan also returns a cache
        # key and the proc scan an instances set and a per-instance key; only bare-GUID keys are read.
        wf = "skp:wf:208cba76-d635-4721-9aff-a7f22ee09224"
        replies = (
            _array(_bulk("0"), _array(_bulk(wf), _bulk(wf + ":cache:sk-whitelist")))
            + _array(_bulk("0"), _array())
            + _array(_bulk("0"), _array(_bulk("skp:proc:11111111-1111-1111-1111-111111111111:instances"),
                                        _bulk("skp:proc:11111111-1111-1111-1111-111111111111:pod-0")))
            + _bulk("chain_1.0.0-9aff-a7f22ee09224")
        )
        sock = Fake(replies)

        names = skp_names.read_names_from(sock)

        self.assertEqual({"208cba76-d635-4721-9aff-a7f22ee09224": "chain_1.0.0-9aff-a7f22ee09224"}, names)
        self.assertIn(b"skp:wf:*", sock.sent)
        self.assertIn(b"skp:step:*", sock.sent)
        self.assertIn(b"skp:proc:*", sock.sent)
        self.assertEqual(1, sock.sent.count(b"HGET"))

    def test_read_name_from_found(self):
        value = "chain_1.0.0-9aff-a7f22ee09224"
        sock = Fake(_bulk(value))

        name = skp_names.read_name_from(sock, "208cba76-d635-4721-9aff-a7f22ee09224")

        self.assertEqual(value, name)
        self.assertIn(b"HGET", sock.sent)
        self.assertIn(b"skp:wf:208cba76-d635-4721-9aff-a7f22ee09224", sock.sent)
        self.assertIn(b"name", sock.sent)

    def test_read_name_from_missing(self):
        sock = Fake(b"$-1\r\n")

        self.assertIsNone(skp_names.read_name_from(sock, "11111111-1111-1111-1111-111111111111"))

    def test_scan_two_rounds(self):
        # The wf SCAN takes two rounds - cursor "5" (more to come), then "0" - while step and proc
        # each return cursor "0" immediately. A loop that stopped after the first wf round would
        # silently drop key2.
        key1 = "skp:wf:11111111-1111-1111-1111-111111111111"
        key2 = "skp:wf:22222222-2222-2222-2222-222222222222"
        replies = (
            _array(_bulk("5"), _array(_bulk(key1)))
            + _array(_bulk("0"), _array(_bulk(key2)))
            + _array(_bulk("0"), _array())
            + _array(_bulk("0"), _array())
            + _bulk("chain_1.0.0-1111-111111111111")
            + _bulk("chain_1.0.0-2222-222222222222")
        )
        sock = Fake(replies)

        names = skp_names.read_names_from(sock)

        self.assertEqual(
            {
                "11111111-1111-1111-1111-111111111111": "chain_1.0.0-1111-111111111111",
                "22222222-2222-2222-2222-222222222222": "chain_1.0.0-2222-222222222222",
            },
            names,
        )
        self.assertEqual(sock.sent.count(b"SCAN"), 4)
        self.assertIn(b"$1\r\n5\r\n", sock.sent)

    def test_multi_byte_utf8_value(self):
        # A value whose UTF-8 byte length differs from its character count. _reply sizes its read off
        # the declared BYTE length; sizing off len(str) instead would truncate or misalign the stream.
        key = "skp:wf:33333333-3333-3333-3333-333333333333"
        value = "café_1.0.0-3333-333333333333"   # "é" is 2 bytes in UTF-8, 1 character
        self.assertNotEqual(len(value), len(value.encode("utf-8")))
        replies = (
            _array(_bulk("0"), _array(_bulk(key)))
            + _array(_bulk("0"), _array())
            + _array(_bulk("0"), _array())
            + _bulk(value)
        )
        sock = Fake(replies)

        names = skp_names.read_names_from(sock)

        self.assertEqual({"33333333-3333-3333-3333-333333333333": value}, names)

    def test_error_reply_raises(self):
        sock = Fake(_err("ERR unknown command"))

        with self.assertRaises(RuntimeError):
            skp_names.read_name_from(sock, "11111111-1111-1111-1111-111111111111")

    def test_short_read_raises(self):
        # The server declares a 30-byte value but the connection drops after only a few bytes: a
        # truncated read must raise rather than silently return a wrong name.
        sock = Fake(b"$30\r\nshort")

        with self.assertRaises(RuntimeError):
            skp_names.read_name_from(sock, "11111111-1111-1111-1111-111111111111")


if __name__ == "__main__":
    unittest.main()
