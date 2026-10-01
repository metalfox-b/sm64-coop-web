"""ABI conversion tests using synthetic audio, with no ROM assets."""
import struct
import sys
import unittest
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from audio32 import convert


class Audio32Tests(unittest.TestCase):
    def test_pointer_layout_and_shared_objects(self):
        blob = bytearray(512)
        def put(fmt, offset, *values):
            struct.pack_into('<' + fmt, blob, offset, *values)
        put('HHQQ', 0, 1, 1, 0, 32)  # pad + entry offset
        put('QQ', 8, 32, 480)
        put('II', 32, 2, 2)
        base = 48
        put('QQQ', base, 32, 64, 64)
        put('QQ', base + 32, 128, 128)
        blob[base + 64:base + 68] = bytes([0, 1, 127, 8])
        put('Q', base + 72, 300)
        for k, sample in enumerate([0, 192, 192]):
            put('QI', base + 80 + k * 16, sample, 0x3f800000 + k)
        blob[base + 128:base + 131] = bytes([5, 64, 0])
        put('QI', base + 136, 192, 0x40000000)
        put('Q', base + 152, 300)
        blob[base + 192:base + 194] = bytes([0, 0])
        put('QQQI', base + 200, 123456, 256, 288, 999)
        put('I', base + 288, 0x12345678)
        original = bytes(blob)
        out = convert(blob, banks=True)
        def get(fmt, offset):
            return struct.unpack_from('<' + fmt, out, offset)
        self.assertEqual(get('II', 4), (32, 480))
        self.assertEqual(get('III', base), (32, 64, 64))
        self.assertEqual(get('II', base + 32), (128, 128))
        self.assertEqual(out[base + 64:base + 68], bytes([0, 1, 127, 8]))
        self.assertEqual(get('I', base + 68), (300,))
        for k, sample in enumerate([0, 192, 192]):
            self.assertEqual(get('II', base + 72 + k * 8), (sample, 0x3f800000 + k))
        self.assertEqual(get('III', base + 132), (192, 0x40000000, 300))
        self.assertEqual(get('IIII', base + 196), (123456, 256, 288, 999))
        self.assertEqual(get('I', base + 288), (0x12345678,))
        self.assertEqual(len(out), len(blob))
        self.assertEqual(bytes(blob), original)

    def test_rom_injected_sequence_offsets_stay_stable(self):
        blob = bytearray(32)
        struct.pack_into('<HH', blob, 0, 3, 1)
        struct.pack_into('<QQ', blob, 8, 100000, 512)
        out = convert(blob)
        self.assertEqual(struct.unpack_from('<II', out, 4), (100000, 512))

    def test_invalid_header_and_bank_bounds_fail(self):
        with self.assertRaises(ValueError):
            convert(bytes(32))
        blob = bytearray(32)
        struct.pack_into('<HH', blob, 0, 1, 1)
        struct.pack_into('<QQ', blob, 8, 32, 512)
        with self.assertRaises(ValueError):
            convert(blob, banks=True)


if __name__ == '__main__':
    unittest.main()
