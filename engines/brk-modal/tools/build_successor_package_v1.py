#!/usr/bin/env python3
"""Build a deterministic immutable brk-engine-package-v1 Modal successor.

This tool is packaging-only. It consumes already-built runtime assets and exact source
metadata, produces a new immutable package identity, and deliberately refuses the locked
1.1.0 version. It never edits source descriptors, the production lock, candidate custody,
or publication state.
"""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import io
import json
import re
import shutil
import subprocess
import tarfile
from pathlib import Path, PurePosixPath

MODULE_ID = "design.myldy.brk-modal"
ENGINE_ID = "brk-modal"
LOCKED_BASELINE_VERSION = "1.1.0"
HOST_CONTRACT = "brk-synth-host-v1"
PACKAGE_SCHEMA = "brk-engine-package-v1"
INTEGRATION_PROFILE = "brksynth-integration-ready-v1"
ABI_VERSION = 65536
STATE_SCHEMA_VERSION = 65536
STATE_BYTES = 768
PARAMETER_SCHEMA_VERSION = 1
PARAMETER_COUNT = 89
FACTORY_PRESET_COUNT = 34
MAX_POLYPHONY = 16
MAX_MODULE_INSTANCES = 8
OUTPUT_CHANNELS = 2
WASM_MEMORY_BYTES = 33554432
PROCESSOR_ID = "brk-modal-v1"
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$")


def die(message: str) -> None:
    raise SystemExit(message)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_file(path: Path, label: str) -> Path:
    if not path.is_file() or path.is_symlink():
        die(f"missing/unsafe {label}: {path}")
    return path


def validate_package_version(value: str) -> str:
    if not isinstance(value, str) or not VERSION_RE.fullmatch(value):
        die("successor package version must be a safe immutable version token")
    if value == LOCKED_BASELINE_VERSION:
        die("locked Modal 1.1.0 cannot be rebuilt or reused as a successor package version")
    return value


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def copy_file(source: Path, destination: Path) -> None:
    require_file(source, "package input")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def deterministic_tar_gz(root: Path, output: Path) -> None:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            data = path.read_bytes()
            relative = path.relative_to(root.parent).as_posix()
            info = tarfile.TarInfo(relative)
            info.size = len(data)
            info.mode = 0o644
            info.mtime = 0
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            archive.addfile(info, io.BytesIO(data))
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        with gzip.GzipFile(filename="", mode="wb", fileobj=handle, compresslevel=9, mtime=0) as compressed:
            compressed.write(raw.getvalue())


def validate_source_descriptor(engine: dict) -> None:
    expected = {
        "moduleId": MODULE_ID,
        "engineId": ENGINE_ID,
        "version": LOCKED_BASELINE_VERSION,
        "license": "GPL-3.0-only",
    }
    for key, value in expected.items():
        if engine.get(key) != value:
            die(f"source descriptor baseline mismatch: {key}={engine.get(key)!r}, expected {value!r}")
    if engine.get("abi", {}).get("version") != ABI_VERSION:
        die("source ABI identity changed")
    if engine.get("output", {}).get("channelCount") != OUTPUT_CHANNELS:
        die("source output topology changed")
    if engine.get("parameters", {}).get("count") != PARAMETER_COUNT:
        die("source parameter count changed")
    state = engine.get("state", {})
    if state.get("schemaVersion") != STATE_SCHEMA_VERSION or state.get("byteSize") != STATE_BYTES:
        die("source state contract changed")
    runtime = engine.get("runtime", {})
    if runtime.get("maxPolyphony") != MAX_POLYPHONY or runtime.get("maxModuleInstances") != MAX_MODULE_INSTANCES:
        die("source runtime capacity changed")
    wasm = engine.get("wasm", {})
    if wasm.get("memoryBytes") != WASM_MEMORY_BYTES or wasm.get("memoryGrowth") is not False:
        die("source WASM memory contract changed")
    if wasm.get("audioWorkletProcessor") != PROCESSOR_ID:
        die("source AudioWorklet processor identity changed")
    presets = engine.get("presets", {})
    if presets.get("count") != FACTORY_PRESET_COUNT or presets.get("factoryStatesReadOnly") is not True:
        die("source factory preset contract changed")


def package_descriptor_for_successor(source: dict, version: str, head_sha: str) -> dict:
    validate_package_version(version)
    result = copy.deepcopy(source)
    result["version"] = version
    result["packageLineage"] = {
        "schema": "brk-modal-successor-lineage-v1",
        "sourceDescriptorVersion": LOCKED_BASELINE_VERSION,
        "builtFromHead": head_sha,
        "lockedBaselineMutation": False,
    }
    return result


def find_catalog_engine(catalog: dict) -> dict:
    module = catalog.get("module")
    engines = catalog.get("engines")
    if not isinstance(module, dict) or module.get("moduleId") != MODULE_ID:
        die("runtime-derived module catalog has wrong module identity")
    if catalog.get("abiVersion") != ABI_VERSION:
        die("runtime-derived module catalog has wrong ABI identity")
    if not isinstance(engines, list):
        die("runtime-derived module catalog has no engines")
    engine = next((row for row in engines if isinstance(row, dict) and row.get("engineId") == ENGINE_ID), None)
    if engine is None:
        die("runtime-derived module catalog has no BRK Modal engine")
    expected = {
        "outputChannelCount": OUTPUT_CHANNELS,
        "parameterCount": PARAMETER_COUNT,
        "stateSchemaVersion": STATE_SCHEMA_VERSION,
        "maxPolyphony": MAX_POLYPHONY,
    }
    for key, value in expected.items():
        if engine.get(key) != value:
            die(f"runtime catalog mismatch: {key}={engine.get(key)!r}, expected {value!r}")
    parameters = engine.get("parameters")
    if not isinstance(parameters, list) or len(parameters) != PARAMETER_COUNT:
        die("runtime parameter descriptor count mismatch")
    ids = [row.get("parameterId") for row in parameters if isinstance(row, dict)]
    keys = [row.get("key") for row in parameters if isinstance(row, dict)]
    if len(ids) != PARAMETER_COUNT or len(set(ids)) != PARAMETER_COUNT or len(set(keys)) != PARAMETER_COUNT:
        die("runtime parameter identities are not unique")
    return engine


def make_parameter_registry(catalog: dict, engine: dict) -> dict:
    parameters = []
    for row in engine["parameters"]:
        parameters.append({
            "id": row["parameterId"],
            "key": row["key"],
            "displayName": row["displayName"],
            "unit": row["unit"],
            "groupKey": row["groupKey"],
            "type": row["parameterType"],
            "flags": row["flags"],
            "normalizedDefault": row["normalizedDefault"],
            "plainMin": row["plainMin"],
            "plainMax": row["plainMax"],
            "plainStep": row["plainStep"],
            "enumValueCount": row["enumValueCount"],
        })
    return {
        "schema": "brk-parameter-registry-v1",
        "schemaVersion": PARAMETER_SCHEMA_VERSION,
        "abiVersion": catalog["abiVersion"],
        "moduleId": MODULE_ID,
        "engineId": ENGINE_ID,
        "parameterCount": PARAMETER_COUNT,
        "identity": "numeric-stable-id",
        "parameters": parameters,
    }


def safe_root_filename(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        die(f"{label}: expected a non-empty filename")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or len(path.parts) != 1:
        die(f"{label}: unsafe filename {value!r}")
    return value


def stage_presets(source: Path, destination: Path) -> list[dict]:
    index_path = require_file(source / "index.json", "preset index")
    index = json.loads(index_path.read_text(encoding="utf-8"))
    expected = {
        "schema": "brk-preset-index-v1",
        "moduleId": MODULE_ID,
        "engineId": ENGINE_ID,
        "stateSchemaVersion": STATE_SCHEMA_VERSION,
        "stateBytes": STATE_BYTES,
        "presetCount": FACTORY_PRESET_COUNT,
    }
    for key, value in expected.items():
        if index.get(key) != value:
            die(f"preset index mismatch: {key}={index.get(key)!r}, expected {value!r}")
    presets = index.get("presets")
    if not isinstance(presets, list) or len(presets) != FACTORY_PRESET_COUNT:
        die("preset index row count mismatch")
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(index_path, destination / "index.json")
    hashes = []
    seen: set[str] = set()
    for row in presets:
        if not isinstance(row, dict) or row.get("readOnly") is not True:
            die("factory preset is not marked immutable/read-only")
        state_file = safe_root_filename(row.get("stateFile"), "preset stateFile")
        if state_file in seen:
            die(f"duplicate preset stateFile: {state_file}")
        seen.add(state_file)
        data = require_file(source / state_file, "factory preset state").read_bytes()
        if len(data) != STATE_BYTES:
            die(f"factory state {state_file} has {len(data)} bytes, expected {STATE_BYTES}")
        (destination / state_file).write_bytes(data)
        hashes.append({
            "id": row.get("id"),
            "stateFile": state_file,
            "bytes": len(data),
            "sha256": sha256_bytes(data),
        })
    return hashes


def content_records(stage: Path) -> tuple[list[dict], str]:
    records = []
    digest = hashlib.sha256()
    for path in sorted(stage.rglob("*")):
        if not path.is_file() or path.name == "brk-package.json":
            continue
        relative = path.relative_to(stage).as_posix()
        data = path.read_bytes()
        sha = sha256_bytes(data)
        records.append({"path": relative, "bytes": len(data), "sha256": sha})
        digest.update(
            relative.encode("utf-8")
            + b"\0"
            + str(len(data)).encode("ascii")
            + b"\0"
            + sha.encode("ascii")
            + b"\n"
        )
    return records, digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--wasm-dir", type=Path, required=True)
    parser.add_argument("--preset-dir", type=Path, required=True)
    parser.add_argument("--module-catalog", type=Path, required=True)
    parser.add_argument("--license-file", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--package-version", required=True)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--contract-evidence-run-id", type=int, required=True)
    parser.add_argument("--contract-evidence-job-id", type=int, required=True)
    parser.add_argument("--contract-evidence-artifact-id", type=int, required=True)
    parser.add_argument("--contract-evidence-artifact-zip-sha256", required=True)
    args = parser.parse_args()

    version = validate_package_version(args.package_version)
    repo = args.repo_root.resolve()
    actual_head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    if actual_head != args.head_sha or not GIT_SHA_RE.fullmatch(actual_head):
        die(f"package source head mismatch: requested={args.head_sha}, actual={actual_head}")
    evidence_digest = args.contract_evidence_artifact_zip_sha256.removeprefix("sha256:")
    if not SHA256_RE.fullmatch(evidence_digest):
        die("contract evidence artifact digest must be lowercase SHA-256")
    for label, value in (
        ("contract evidence run", args.contract_evidence_run_id),
        ("contract evidence job", args.contract_evidence_job_id),
        ("contract evidence artifact", args.contract_evidence_artifact_id),
    ):
        if value < 1:
            die(f"{label} id must be positive")

    engine_dir = repo / "engines/brk-modal"
    source_descriptor = json.loads(
        require_file(engine_dir / "brk-engine.json", "source engine descriptor").read_text(encoding="utf-8")
    )
    validate_source_descriptor(source_descriptor)
    catalog = json.loads(require_file(args.module_catalog.resolve(), "module catalog").read_text(encoding="utf-8"))
    catalog_engine = find_catalog_engine(catalog)

    output = args.output_dir.resolve()
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    root_name = f"brk-modal-{version}"
    stage = output / root_name
    stage.mkdir()

    write_json(
        stage / "descriptors/brk-engine.json",
        package_descriptor_for_successor(source_descriptor, version, actual_head),
    )
    copy_file(engine_dir / "brk-ui.json", stage / "descriptors/brk-ui.json")
    write_json(stage / "descriptors/parameter-registry.json", make_parameter_registry(catalog, catalog_engine))
    write_json(stage / "descriptors/module-catalog.json", catalog)

    preset_hashes = stage_presets(args.preset_dir.resolve(), stage / "presets")
    write_json(stage / "presets/accepted-state-hashes.json", {
        "schema": "brk-modal-accepted-factory-state-hashes-v1",
        "moduleId": MODULE_ID,
        "engineId": ENGINE_ID,
        "engineVersion": version,
        "stateSchemaVersion": STATE_SCHEMA_VERSION,
        "stateBytes": STATE_BYTES,
        "presetCount": FACTORY_PRESET_COUNT,
        "states": preset_hashes,
    })

    wasm_dir = args.wasm_dir.resolve()
    for source, relative in (
        ("brk_modal_module.js", "runtime/brk_modal_module.js"),
        ("brk_modal_module.wasm", "runtime/brk_modal_module.wasm"),
        ("brk_modal_worklet_module.mjs", "runtime/brk_modal_worklet_module.mjs"),
        ("brk_modal_worklet_module_simd.mjs", "runtime/brk_modal_worklet_module_simd.mjs"),
    ):
        copy_file(wasm_dir / source, stage / relative)

    copy_file(engine_dir / "PROVENANCE.md", stage / "provenance/PROVENANCE.md")
    copy_file(engine_dir / "PROVENANCE.yml", stage / "provenance/PROVENANCE.yml")
    copy_file(args.license_file.resolve(), stage / "provenance/LICENSE-GPL-3.0.txt")
    (stage / "provenance/LICENSE_INVENTORY.md").write_text(
        "# BRK Modal package license inventory\n\n"
        "BRK Modal remains GPL-3.0-only and a modified RipplerX derivative. "
        "See PROVENANCE.md / PROVENANCE.yml and the bundled GPLv3 text.\n",
        encoding="utf-8",
    )

    files, content_sha = content_records(stage)
    manifest = {
        "schema": PACKAGE_SCHEMA,
        "moduleId": MODULE_ID,
        "engineId": ENGINE_ID,
        "version": version,
        "builtFromHead": actual_head,
        "hostContract": HOST_CONTRACT,
        "abiVersion": ABI_VERSION,
        "stateSchemaVersion": STATE_SCHEMA_VERSION,
        "stateBytes": STATE_BYTES,
        "parameterSchemaVersion": PARAMETER_SCHEMA_VERSION,
        "parameterCount": PARAMETER_COUNT,
        "factoryPresetCount": FACTORY_PRESET_COUNT,
        "runtime": {
            "directJs": "runtime/brk_modal_module.js",
            "directWasm": "runtime/brk_modal_module.wasm",
            "audioWorklet": "runtime/brk_modal_worklet_module.mjs",
            "audioWorkletProcessor": PROCESSOR_ID,
            "audioWorkletVariants": {
                "scalar": "runtime/brk_modal_worklet_module.mjs",
                "simd128": "runtime/brk_modal_worklet_module_simd.mjs",
                "preferred": "simd128",
                "fallback": "scalar",
            },
            "wasmInitialMemoryBytes": WASM_MEMORY_BYTES,
            "wasmMaximumMemoryBytes": WASM_MEMORY_BYTES,
            "memoryGrowth": False,
            "maxPolyphony": MAX_POLYPHONY,
            "maxModuleInstances": MAX_MODULE_INSTANCES,
        },
        "descriptors": {
            "engine": "descriptors/brk-engine.json",
            "ui": "descriptors/brk-ui.json",
            "parameters": "descriptors/parameter-registry.json",
            "presets": "presets/index.json",
            "moduleCatalog": "descriptors/module-catalog.json",
        },
        "integration": {
            "profile": INTEGRATION_PROFILE,
            "audio": {
                "inputBusCount": 0,
                "outputBusCount": 1,
                "inputChannelCount": 0,
                "outputChannelCount": OUTPUT_CHANNELS,
            },
            "presentation": {"mode": "generic-descriptor-ui"},
            "acceptance": {
                "sourceHead": actual_head,
                "runner": "myldyserver-brksnth",
                "runId": args.contract_evidence_run_id,
                "jobId": args.contract_evidence_job_id,
                "artifactId": args.contract_evidence_artifact_id,
                "artifactZipSha256": evidence_digest,
                "evidence": [
                    "exact-head-native-abi-and-engine-regression",
                    "deterministic-factory-state-generation",
                    "direct-wasm-contract",
                    "scalar-and-simd128-audioworklet-build",
                    "real-chrome-package-host-contract",
                ],
            },
            "licenses": {
                "classification": "GPL-3.0-only-modified-ripplerx-derivative",
                "notices": [
                    "provenance/LICENSE_INVENTORY.md",
                    "provenance/PROVENANCE.md",
                    "provenance/LICENSE-GPL-3.0.txt",
                ],
            },
        },
        "quality": source_descriptor.get("quality"),
        "factoryStateIdentity": "presets/accepted-state-hashes.json",
        "contentSha256": content_sha,
        "archiveSha256Ownership": "external-candidate-custody-and-promotion-contract",
        "files": files,
    }
    write_json(stage / "brk-package.json", manifest)

    archive = output / f"{root_name}.tar.gz"
    deterministic_tar_gz(stage, archive)
    print(f"package_archive={archive}")
    print(f"package_filename={archive.name}")
    print(f"package_bytes={archive.stat().st_size}")
    print(f"package_sha256={sha256_file(archive)}")
    print(f"content_sha256={content_sha}")
    print(f"built_from_head={actual_head}")
    print(f"successor_version={version}")
    print("locked_baseline_mutation=false")
    print("brk_modal_successor_package_v1=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
