"""Convert coopdx's shipped little-endian 64-bit audio layouts to wasm32.

Offsets remain stable, so ROM sample/sequence injection tables stay valid.
Only headers and pointer-bearing structures are compacted in place.
"""
import struct
import zlib
from pathlib import Path


def convert(blob, banks=False):
    source = bytes(blob)
    out = bytearray(source)

    def read(fmt, offset):
        return struct.unpack_from('<' + fmt, source, offset)

    def write(fmt, offset, *values):
        struct.pack_into('<' + fmt, out, offset, *values)

    revision, count = read('HH', 0)
    if revision not in (1, 2, 3) or not 0 < count < 256:
        raise ValueError('Unexpected upstream audio header')
    entries = [read('QQ', 8 + i * 16) for i in range(count)]
    for i, (offset, size) in enumerate(entries):
        if (banks and offset + size > len(source)) or offset + size > 0xffffffff:
            raise ValueError('Audio entry outside source data')
        write('II', 4 + i * 8, offset, size)
        if not banks:
            continue
        instruments, drums = read('II', offset)
        base = offset + 16
        visited_samples, visited_instruments, visited_drums = set(), set(), set()

        def sample(relative):
            if not relative or relative in visited_samples:
                return
            visited_samples.add(relative)
            pos = base + relative
            address, loop, book = read('QQQ', pos + 8)
            size, = read('I', pos + 32)
            write('IIII', pos + 4, address, loop, book, size)

        def sound(src_pos, dst_pos):
            relative, = read('Q', src_pos)
            # Copy float bits verbatim; do not round or reinterpret tuning.
            tuning, = read('I', src_pos + 8)
            write('II', dst_pos, relative, tuning)
            sample(relative)

        drum_table, = read('Q', base)
        instrument_offsets = [read('Q', base + 8 + j * 8)[0] for j in range(instruments)]
        write('I', base, drum_table)
        for j, relative in enumerate(instrument_offsets):
            write('I', base + 4 + j * 4, relative)
            if not relative or relative in visited_instruments:
                continue
            visited_instruments.add(relative)
            pos = base + relative
            envelope, = read('Q', pos + 8)
            write('I', pos + 4, envelope)
            for k in range(3):
                sound(pos + 16 + k * 16, pos + 8 + k * 8)
        if drums and drum_table:
            offsets = [read('Q', base + drum_table + j * 8)[0] for j in range(drums)]
            for j, relative in enumerate(offsets):
                write('I', base + drum_table + j * 4, relative)
                if not relative or relative in visited_drums:
                    continue
                visited_drums.add(relative)
                pos = base + relative
                sound(pos + 8, pos + 4)
                envelope, = read('Q', pos + 24)
                write('I', pos + 12, envelope)
    return bytes(out)


def prepare(source: Path):
    for name, banks in [('sound_data.ctl', True), ('sound_data.tbl', False), ('sequences.bin', False)]:
        compressed = source / 'sound' / {'sound_data.ctl': 'sound_data_compressed.ctl', 'sound_data.tbl': 'sound_data_compressed.tbl', 'sequences.bin': 'sequences_compressed.bin'}[name]
        data = convert(zlib.decompress(compressed.read_bytes()), banks)
        if not banks:
            # These banks contain ROM samples/sequences. Ship only their index;
            # rom_assets_load fills the payload from the player's local ROM.
            _, count = struct.unpack_from('<HH', data, 0)
            start = min(struct.unpack_from('<I', data, 4+i*8)[0] for i in range(count))
            if name == 'sequences.bin':
                # Entry zero is the sound-player program assembled from upstream
                # sound/sequences/00_sound_player.s, not a ROM music asset.
                code_size = struct.unpack_from('<I', data, 8)[0]
                start += code_size
            data = data[:start] + bytes(len(data)-start)
        destination = source / 'build/us_pc/sound' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists() or destination.read_bytes() != data:
            destination.write_bytes(data)
