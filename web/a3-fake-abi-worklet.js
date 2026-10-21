(() => {
  "use strict";

  const buffer = new ArrayBuffer(4 * 1024 * 1024);
  const HEAPU8 = new Uint8Array(buffer);
  const HEAPF32 = new Float32Array(buffer);
  let cursor = 8192;
  let nextHandle = 100;
  const activeHandles = new Set();

  const module = {
    HEAPU8,
    HEAPF32,
    _malloc(size) { const ptr = cursor; cursor += Number(size); return ptr; },
    _free() {},
    _brk_abi_version() { return 0x00010000; },
    _brk_instance_create() { return ++nextHandle; },
    _brk_instance_prepare() { return 0; },
    _brk_instance_activate() { return 0; },
    _brk_instance_deactivate() { return 0; },
    _brk_instance_reset(handle) { activeHandles.delete(handle); return 0; },
    _brk_instance_destroy(handle) { activeHandles.delete(handle); return 0; },
    _brk_instance_state_read() { return 0; },
    _brk_instance_process(handle, processPtr) {
      const dv = new DataView(buffer);
      const frames = dv.getUint32(processPtr + 4, true);
      const span = dv.getUint32(processPtr + 8, true);
      const eventPtr = dv.getUint32(processPtr + 12, true);
      const eventCount = dv.getUint32(processPtr + 20, true);
      let eventOffset = eventPtr;
      for (let index = 0; index < eventCount; index += 1) {
        const size = dv.getUint16(eventOffset, true);
        const type = dv.getUint16(eventOffset + 2, true);
        if (type === 1 || type === 4) activeHandles.add(handle);
        if (type === 2 || type === 3 || type === 7 || type === 8) activeHandles.delete(handle);
        eventOffset += size;
      }
      const outputPtr = dv.getUint32(span + 4, true);
      const stride = dv.getUint32(span + 16, true);
      const base = outputPtr >>> 2;
      for (let frame = 0; frame < frames; frame += 1) {
        HEAPF32[base + frame] = activeHandles.has(handle) ? 0.18 : 0;
        HEAPF32[base + stride + frame] = activeHandles.has(handle) ? 0.09 : 0;
      }
      return 0;
    },
  };

  const hostContract = { id: "brktrk-synth-gateway-v1", minVersion: 1, maxVersion: 1 };
  const entry = {
    moduleId: "design.myldy.a3-browser-fixture",
    engineId: "a3-browser-fixture",
    version: "1.0.0",
    channel: "stable",
    hostContract,
    abiVersion: 65536,
    packageUrl: "https://fixture.invalid/packages/a3-browser-fixture.tar.gz",
    packageSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    stateSchemaVersion: 1,
    stateBytes: 224,
    parameterSchemaVersion: 1,
    status: "active",
  };
  const manifest = {
    schema: "brk-engine-package-v1",
    moduleId: entry.moduleId,
    engineId: entry.engineId,
    version: entry.version,
    hostContract,
    abiVersion: 65536,
    stateSchemaVersion: 1,
    stateBytes: 224,
    parameterSchemaVersion: 1,
    contentSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    files: [{ path: "runtime/fake.wasm", bytes: 1, sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }],
    runtime: { maxModuleInstances: 16, wasmInitialMemoryBytes: 4194304, memoryGrowth: false },
    parameters: [{ id: "cutoff", abiId: 513, defaultNormalized: 1 }],
  };

  globalThis.BRKTRKBrkSynthAbiV1Runtime.registerModuleRuntime({ entry, manifest, module });
})();
