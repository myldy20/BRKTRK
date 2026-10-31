#!/usr/bin/env python3
"""Produce a nonpublished immutable Modal package using only BRKTRK sources.

The outer SHA belongs to the ephemeral catalog entry, never to the package
manifest itself. This command cannot update web/engines or Pages.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import struct
import tarfile
from pathlib import Path

MODULE = "design.myldy.brk-modal"
ENGINE = "brk-modal"
VERSION = "1.1.1-brktrk1"
HOST = "brk-synth-host-v1"
PROFILE = "brksynth-integration-ready-v1"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def strings(raw: bytes, offset: int, record: bytes, at: int) -> str:
    start, length = struct.unpack_from("<II", record, at)
    if start < offset or start + length > len(raw):
        raise ValueError("invalid native ABI descriptor string offset")
    return raw[start:start + length].decode("utf-8")


def parameter_records(path: Path, ui: dict) -> list[dict]:
    data = path.read_bytes()
    magic, count, size, pool_offset = struct.unpack_from("<IIII", data)
    if (magic, count, size, pool_offset) != (0x444B5242, 89, 96, 16 + 89 * 96):
        raise ValueError("native parameter descriptor fixture not ABI-v1/89 parameters")
    labels = ui.get("enumLabels", {})
    result = []
    ids = set()
    keys = set()
    for i in range(count):
        row = data[16 + i * size:16 + (i + 1) * size]
        struct_size, numeric_id, kind, flags = struct.unpack_from("<IIII", row)
        if struct_size != 96 or numeric_id in ids:
            raise ValueError("invalid/duplicate ABI descriptor")
        ids.add(numeric_id)
        key = strings(data, pool_offset, row, 16)
        if not key or key in keys:
            raise ValueError("duplicate/empty stable parameter key")
        keys.add(key)
        label = strings(data, pool_offset, row, 24)
        unit = strings(data, pool_offset, row, 32)
        group = strings(data, pool_offset, row, 40)
        default, low, high, step = struct.unpack_from("<ffff", row, 48)
        enums = struct.unpack_from("<I", row, 64)[0]
        if kind not in (1, 2, 3, 4):
            raise ValueError("unknown native parameter type")
        if enums and (kind != 3 or len(labels.get(key, [])) != enums):
            raise ValueError(f"missing enum labels for {key}: {enums}")
        result.append({
            "id": key, "key": key, "numericId": numeric_id, "abiId": numeric_id,
            "type": ("continuous", "stepped", "enum", "boolean")[kind - 1],
            "flags": flags, "label": label, "displayName": label,
            "unit": unit, "group": group,
            "defaultNormalized": default, "plainMin": low, "plainMax": high,
            "plainStep": step, "values": labels.get(key, []),
        })
    if len(result) != 89:
        raise ValueError("missing native parameter descriptions")
    return result


def make_archive(stage: dict[str, bytes], root: str) -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for path, data in sorted(stage.items()):
            info = tarfile.TarInfo(f"{root}/{path}")
            info.size, info.mode, info.mtime, info.uid, info.gid = len(data), 0o644, 0, 0, 0
            info.uname = info.gname = ""
            tar.addfile(info, io.BytesIO(data))
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, filename="", mode="wb", compresslevel=9, mtime=0) as gz:
        gz.write(raw.getvalue())
    return output.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, default=Path("."))
    ap.add_argument("--wasm-dir", type=Path, required=True)
    ap.add_argument("--presets", type=Path, required=True)
    ap.add_argument("--descriptor-fixture", type=Path, required=True)
    ap.add_argument("--output-dir", type=Path, required=True)
    ap.add_argument("--head-sha", required=True)
    args = ap.parse_args()
    if len(args.head_sha) != 40 or any(c not in "0123456789abcdef" for c in args.head_sha):
        raise ValueError("candidate source must be an exact 40-byte Git SHA")
    if args.output_dir.resolve().is_relative_to((args.repo / "web").resolve()):
        raise ValueError("refusing to stage an unapproved package in the public web directory")
    ui = json.loads((args.repo / "engines/brk-modal/brk-ui.json").read_text("utf-8"))
    engine = json.loads((args.repo / "engines/brk-modal/brk-engine.json").read_text("utf-8"))
    if (engine["moduleId"], engine["engineId"], engine["version"]) != (MODULE, ENGINE, "1.1.0"):
        raise ValueError("locked source descriptor lineage changed")
    engine["version"] = VERSION
    engine["candidateBuiltFromHead"] = args.head_sha
    params = parameter_records(args.descriptor_fixture, ui)
    state_index = json.loads((args.presets / "index.json").read_text("utf-8"))
    if state_index.get("presetCount") != 34:
        raise ValueError("expected exactly 34 Modal presets")
    records = state_index["presets"]
    if len(records) != 34 or any(len(row.get("parameterSnapshot", {})) != 89 for row in records):
        raise ValueError("factory bank is not fully applicable to Sound")
    artifacts = {
        "descriptors/engine.json": json_bytes(engine),
        "descriptors/ui.json": json_bytes(ui),
        "descriptors/parameters.json": json_bytes({
            "schema": "brk-engine-parameters-v1", "engineId": ENGINE,
            "parameterSchemaVersion": 1, "parameters": params,
        }),
        "presets/index.json": json_bytes(state_index),
        "runtime/brk_modal_module.js": (args.wasm_dir / "brk_modal_module.js").read_bytes(),
        "runtime/brk_modal_module.wasm": (args.wasm_dir / "brk_modal_module.wasm").read_bytes(),
        "provenance/PROVENANCE.md": (args.repo / "engines/brk-modal/PROVENANCE.md").read_bytes(),
        "provenance/PROVENANCE.yml": (args.repo / "engines/brk-modal/PROVENANCE.yml").read_bytes(),
        "provenance/LICENSE.txt": (args.repo / "LICENSE").read_bytes(),
        "provenance/FACTORY-SOURCE.md": (args.repo / "engines/brk-modal/upstream-factory/README.md").read_bytes(),
    }
    for row in records:
        relative = row["stateFile"]
        if Path(relative).name != relative:
            raise ValueError("nonlocal factory state path")
        state = (args.presets / relative).read_bytes()
        if len(state) != 768:
            raise ValueError("invalid 768-byte native preset")
        artifacts["presets/" + relative] = state
    ordered = sorted(artifacts.items())
    digest_input = "".join(f"{name}\0{len(data)}\0{sha(data)}\n" for name, data in ordered).encode("utf-8")
    manifest = {
        "schema": "brk-engine-package-v1",
        "moduleId": MODULE, "engineId": ENGINE, "version": VERSION,
        "displayName": "BRK Modal",
        "hostContract": {"id": HOST, "minVersion": 1, "maxVersion": 1},
        "abiVersion": 65536, "stateSchemaVersion": 65536, "stateBytes": 768,
        "parameterSchemaVersion": 1, "builtFromHead": args.head_sha,
        "runtime": {
            "directJs": "runtime/brk_modal_module.js",
            "directWasm": "runtime/brk_modal_module.wasm",
            "maxModuleInstances": 8,
            "wasmInitialMemoryBytes": 33554432,
            "memoryGrowth": False,
        },
        "integration": {
            "profile": PROFILE,
            "audio": {
                "inputBusCount": 0, "outputBusCount": 1,
                "inputChannelCount": 0, "outputChannelCount": 2,
            },
            "presentation": {"mode": "generic-descriptor-ui"},
        },
        "descriptors": {
            "engine": "descriptors/engine.json",
            "ui": "descriptors/ui.json",
            "parameters": "descriptors/parameters.json",
            "presets": "presets/index.json",
        },
        "contentSha256": sha(digest_input),
        "artifacts": [{"path": p, "bytes": len(data), "sha256": sha(data)} for p, data in ordered],
        "candidateOnly": True,
        "source": {
            "repository": "myldy20/BRKTRK", "commit": args.head_sha,
            "license": "GPL-3.0-only", "modifiedFrom": "RipplerX 1.5.18",
        },
    }
    artifacts["brk-package.json"] = json_bytes(manifest)
    archive = make_archive(artifacts, f"{ENGINE}-{VERSION}")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    name = f"{ENGINE}-{VERSION}.tar.gz"
    (args.output_dir / name).write_bytes(archive)
    row = {
        "moduleId": MODULE, "engineId": ENGINE, "version": VERSION,
        "channel": "preview", "status": "active",
        "hostContract": {"id": HOST, "minVersion": 1, "maxVersion": 1},
        "hostCompatibility": {"profile": PROFILE, "source": "package-manifest"},
        "abiVersion": 65536, "stateSchemaVersion": 65536,
        "parameterSchemaVersion": 1,
        "packageUrl": "./" + name, "packageSha256": sha(archive),
    }
    (args.output_dir / "candidate-entry.json").write_bytes(json_bytes(row))
    print(f"BRK_MODAL_CANDIDATE_CREATED=PASS; artifacts={len(ordered)}; presets=34; parameters=89; archiveBytes={len(archive)}; sha256={sha(archive)}")


if __name__ == "__main__":
    main()
