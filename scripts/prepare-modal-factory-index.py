#!/usr/bin/env python3
"""Attach usable 89-parameter snapshots to BRK Modal's immutable P6 preset bank.

Do not invent parameters: each value is read from its canonical binary
brk-modal state-v1 record, after strict schema/engine/CRC validation.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import struct
import zlib
from pathlib import Path

PARAMETER_RE = re.compile(r'^\s*X\(\w+,\s*(0x[0-9a-fA-F]+)u,\s*"([^"]+)"\)', re.M)
HEADER_SIZE = 56
PARAMETERS = 89
STATE_SIZE = HEADER_SIZE + PARAMETERS * 8
MAGIC = 0x534B5242
SCHEMA = (1, 0)
ENGINE_ID = "brk-modal"


def fnv1a(text: str) -> int:
    value = 2166136261
    for byte in text.encode("utf-8"):
        value = ((value ^ byte) * 16777619) & 0xFFFFFFFF
    return value


def parameter_keys(header: Path) -> dict[int, str]:
    ids = {int(id_hex, 16): key for id_hex, key in PARAMETER_RE.findall(header.read_text("utf-8"))}
    if len(ids) != PARAMETERS or len(set(ids.values())) != PARAMETERS:
        raise ValueError(f"expected exactly {PARAMETERS} distinct stable parameter keys, got {len(ids)}")
    return ids


def parse_state(path: Path, identities: dict[int, str]) -> dict[str, float]:
    data = path.read_bytes()
    if len(data) != STATE_SIZE:
        raise ValueError(f"{path}: invalid state size {len(data)}")
    magic, major, minor, header_size, total_size, engine_hash, count, crc, reserved = struct.unpack_from("<IHHIIIIII", data)
    if (magic, major, minor, header_size, total_size, engine_hash, count, reserved) != (
        MAGIC, *SCHEMA, HEADER_SIZE, STATE_SIZE, fnv1a(ENGINE_ID), PARAMETERS, 0
    ):
        raise ValueError(f"{path}: invalid state magic/schema/engine/header")
    if any(data[32:HEADER_SIZE]):
        raise ValueError(f"{path}: noncanonical reserved header")
    if zlib.crc32(data[HEADER_SIZE:]) != crc:
        raise ValueError(f"{path}: state CRC32 mismatch")
    records = list(struct.iter_unpack("<If", data[HEADER_SIZE:]))
    if len(records) != PARAMETERS or [row[0] for row in records] != sorted(identities):
        raise ValueError(f"{path}: parameter ID/order mismatch")
    values = {}
    for parameter_id, normalized in records:
        if not math.isfinite(normalized) or normalized < 0 or normalized > 1:
            raise ValueError(f"{path}: invalid normalized parameter {parameter_id}")
        values[identities[parameter_id]] = normalized
    return values


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preset-dir", type=Path, required=True)
    parser.add_argument("--header", type=Path, default=Path("engines/brk-modal/include/brk_modal/parameter_ids.hpp"))
    args = parser.parse_args()
    identities = parameter_keys(args.header)
    index_path = args.preset_dir / "index.json"
    index = json.loads(index_path.read_text("utf-8"))
    if (index.get("schema"), index.get("moduleId"), index.get("engineId"),
        index.get("stateSchemaVersion"), index.get("stateBytes"), index.get("presetCount")) != (
        "brk-preset-index-v1", "design.myldy.brk-modal", "brk-modal", 65536, STATE_SIZE, 34
    ):
        raise ValueError("P6 preset index identity/schema/count mismatch")
    presets = index.get("presets")
    if not isinstance(presets, list) or len(presets) != 34:
        raise ValueError("expected 34 source presets")
    ids = set()
    counts = {"upstream": 0, "brk": 0}
    for row in presets:
        state_file = row.get("stateFile")
        if not isinstance(state_file, str) or Path(state_file).name != state_file or not state_file.endswith(".brkstate"):
            raise ValueError(f"unsafe stateFile {state_file!r}")
        if row.get("id") in ids or row.get("readOnly") is not True:
            raise ValueError("duplicate/mutable factory preset")
        ids.add(row["id"])
        origin = row.get("origin")
        if origin not in counts:
            raise ValueError(f"unknown preset origin {origin!r}")
        counts[origin] += 1
        row["parameterSnapshot"] = parse_state(args.preset_dir / state_file, identities)
    if counts != {"upstream": 28, "brk": 6}:
        raise ValueError(f"factory banks incorrect: {counts!r}")
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print("brk_modal_factory_bank=PASS; presets=34; reference=28; brk=6; normalizedParameters=89; stateBytes=768")


if __name__ == "__main__":
    main()
