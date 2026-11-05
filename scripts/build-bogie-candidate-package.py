#!/usr/bin/env python3
"""Build an unpublished Bogie candidate from the public BRKTRK source tree."""
import argparse
import gzip
import hashlib
import io
import json
import tarfile
from pathlib import Path

MODULE = 'design.myldy.brk-bogie'
ENGINE = 'brk-bogie'
CANDIDATE_VERSION = '0.1.0-brktrk1'
RELEASE_VERSION = '0.1.0-brktrk2'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return (json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + '\n').encode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--wasm-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--head-sha', required=True)
    parser.add_argument('--release', action='store_true')
    args = parser.parse_args()
    version = RELEASE_VERSION if args.release else CANDIDATE_VERSION
    if len(args.head_sha) != 40 or any(c not in '0123456789abcdef' for c in args.head_sha):
        raise ValueError('source revision must be an exact lowercase Git SHA')
    if args.output_dir.resolve().is_relative_to(Path('web').resolve()):
        raise ValueError('candidate cannot be staged in public web directory')
    root = Path('engines/brk-bogie')
    engine = json.loads((root / 'brk-engine.json').read_text())
    registry = json.loads((root / 'parameter-registry.json').read_text())
    ui = json.loads((root / 'brk-ui.json').read_text())
    if (engine['moduleId'], engine['engineId'], engine['license']) != (MODULE, ENGINE, 'GPL-3.0-only'):
        raise ValueError('unexpected engine identity or license')
    engine['version'] = version
    engine['status'] = 'alpha-release' if args.release else 'alpha-preview-candidate'
    engine['package']['version'] = version
    engine['package']['status'] = 'stable-release' if args.release else 'preview-candidate'
    rows = registry['parameters']
    if len(rows) != 8 or len({p['id'] for p in rows}) != 8 or len({p['key'] for p in rows}) != 8:
        raise ValueError('expected eight unique Bogie parameter identities')
    parameters = [{
        'id': p['key'], 'key': p['key'], 'abiId': p['id'], 'numericId': p['id'],
        'type': p['type'], 'label': p['name'], 'group': p['group'],
        'defaultNormalized': p['defaultNormalized'], 'values': p.get('values', []),
    } for p in rows]
    notices = {
        'provenance/LICENSE.txt': Path('LICENSE').read_bytes(),
        'provenance/UPSTREAM-MIT.txt': (root / 'third_party/choochoorack/LICENSE').read_bytes(),
        'provenance/LICENSE_INVENTORY.md': (root / 'LICENSE_INVENTORY.md').read_bytes(),
        'provenance/PROVENANCE.yml': (root / 'PROVENANCE.yml').read_bytes(),
        'provenance/BUILD-SOURCE.md': (
            '# Corresponding source\n\n'
            f'https://github.com/myldy20/BRKTRK/tree/{args.head_sha}\n\n'
            'Build with Emscripten 4.0.23 from engines/brk-bogie and abi/include. '
            'Package with scripts/build-bogie-candidate-package.py.\n'
        ).encode(),
    }
    artifacts = {
        **notices,
        'descriptors/engine.json': encode(engine),
        'descriptors/ui.json': encode(ui),
        'descriptors/parameters.json': encode({'schema': 'brk-engine-parameters-v1',
            'engineId': ENGINE, 'parameterSchemaVersion': 1, 'parameters': parameters}),
        'runtime/brk_bogie_module.js': (args.wasm_dir / 'brk_bogie_module.js').read_bytes(),
        'runtime/brk_bogie_module.wasm': (args.wasm_dir / 'brk_bogie_module.wasm').read_bytes(),
    }
    ordered = sorted(artifacts.items())
    content_hash = sha(''.join(f'{p}\0{len(b)}\0{sha(b)}\n' for p, b in ordered).encode())
    manifest = {
        'schema': 'brk-engine-package-v1', 'moduleId': MODULE, 'engineId': ENGINE,
        'version': version, 'displayName': 'BRK BOGIE',
        'hostContract': {'id': 'brk-synth-host-v1', 'minVersion': 1, 'maxVersion': 1},
        'abiVersion': 65536, 'stateSchemaVersion': 65536, 'stateBytes': 120,
        'parameterSchemaVersion': 1, 'builtFromHead': args.head_sha,
        'runtime': {'directJs': 'runtime/brk_bogie_module.js', 'directWasm': 'runtime/brk_bogie_module.wasm',
            'maxModuleInstances': 8, 'wasmInitialMemoryBytes': 4194304, 'memoryGrowth': False},
        'integration': {'profile': 'brksynth-integration-ready-v1',
            'audio': {'inputBusCount': 0, 'outputBusCount': 1, 'inputChannelCount': 0, 'outputChannelCount': 2},
            'presentation': {'mode': 'generic-descriptor-ui'}},
        'descriptors': {'engine': 'descriptors/engine.json', 'ui': 'descriptors/ui.json',
            'parameters': 'descriptors/parameters.json'},
        'artifacts': [{'path': p, 'bytes': len(b), 'sha256': sha(b)} for p, b in ordered],
        'contentSha256': content_hash, 'candidateOnly': not args.release,
        'source': {'repository': 'myldy20/BRKTRK', 'commit': args.head_sha, 'license': 'GPL-3.0-only'},
    }
    artifacts['brk-package.json'] = encode(manifest)
    uncompressed = io.BytesIO()
    with tarfile.open(fileobj=uncompressed, mode='w', format=tarfile.PAX_FORMAT) as tar:
        for path, data in sorted(artifacts.items()):
            info = tarfile.TarInfo(f'{ENGINE}-{version}/{path}')
            info.size, info.mode, info.mtime, info.uid, info.gid = len(data), 0o644, 0, 0, 0
            info.uname = info.gname = ''
            tar.addfile(info, io.BytesIO(data))
    compressed = io.BytesIO()
    with gzip.GzipFile(fileobj=compressed, filename='', mode='wb', compresslevel=9, mtime=0) as out:
        out.write(uncompressed.getvalue())
    archive = compressed.getvalue()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    name = f'{ENGINE}-{version}.tar.gz'
    (args.output_dir / name).write_bytes(archive)
    entry = {'moduleId': MODULE, 'engineId': ENGINE, 'version': version, 'channel': 'stable' if args.release else 'preview', 'status': 'active',
        'hostContract': manifest['hostContract'],
        'hostCompatibility': {'profile': 'brksynth-integration-ready-v1', 'source': 'package-manifest'},
        'abiVersion': 65536, 'stateSchemaVersion': 65536, 'parameterSchemaVersion': 1,
        'packageUrl': './' + name, 'packageSha256': sha(archive)}
    (args.output_dir / 'candidate-entry.json').write_bytes(encode(entry))
    print('BRK_BOGIE_CANDIDATE=PASS; sha256=' + sha(archive))


if __name__ == '__main__':
    main()
