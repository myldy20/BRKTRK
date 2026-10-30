// Test-only AudioWorklet that uses the same Emscripten JS/WASM pair and
// fixed ABI structures as BRKTRK. It never ships in GitHub Pages.
// __brkModule and __brkState are provided by qualify-modal-audioworklet.mjs.
class BRKModalQualificationProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.m = __brkModule;
    this.base = this.m._malloc(2 * 1024 * 1024);
    if (!this.base || this.m._brk_abi_version() !== 0x00010000) {
      throw new Error("Modal Worklet ABI/memory initialization failed");
    }
    this.ptr = {
      create: this.base + 0x1000, prepare: this.base + 0x1100,
      process: this.base + 0x1200, span: this.base + 0x1300,
      events: this.base + 0x2000, audio: this.base + 0x4000,
      state: this.base + 0x10000,
    };
    const v = new DataView(this.m.HEAPU8.buffer);
    const u32 = (p, x) => v.setUint32(p, x >>> 0, true);
    this.m.HEAPU8.fill(0, this.ptr.create, this.ptr.create + 48);
    u32(this.ptr.create, 48);
    this.handle = this.m._brk_instance_create(0, this.ptr.create);
    if (this.handle <= 0) throw new Error("Modal Worklet create failed " + this.handle);
    this.m.HEAPU8.fill(0, this.ptr.prepare, this.ptr.prepare + 72);
    u32(this.ptr.prepare, 72);
    v.setFloat64(this.ptr.prepare + 8, sampleRate, true);
    u32(this.ptr.prepare + 16, 128);
    u32(this.ptr.prepare + 20, 32);
    u32(this.ptr.prepare + 24, 2);
    u32(this.ptr.prepare + 28, 768 * 1024);
    if (this.m._brk_instance_prepare(this.handle, this.ptr.prepare) !== 0) {
      throw new Error("Modal Worklet prepare failed");
    }
    this.m.HEAPU8.set(__brkState, this.ptr.state);
    if (this.m._brk_instance_state_read(this.handle, this.ptr.state, __brkState.length, 65536) !== 0) {
      throw new Error("Modal Worklet 768-byte preset state rejected");
    }
    if (this.m._brk_instance_activate(this.handle) !== 0) {
      throw new Error("Modal Worklet activate failed");
    }
    this.blocks = 0;
    this.sumSquares = 0;
    this.peak = 0;
    this.memoryBefore = this.m.HEAPU8.buffer.byteLength;
    this.port.postMessage({ status: "ready", memoryBytes: this.memoryBefore });
  }

  process(inputs, outputs) {
    try {
      const out = outputs[0];
      if (!out || out.length < 2) throw new Error("AudioWorklet stereo output missing");
      const frames = out[0].length;
      const v = new DataView(this.m.HEAPU8.buffer);
      const u32 = (p, x) => v.setUint32(p, x >>> 0, true);
      const noteOn = this.blocks === 0;
      const ptr = this.ptr;
      this.m.HEAPU8.fill(0, ptr.span, ptr.span + 24);
      u32(ptr.span, 24);
      u32(ptr.span + 4, ptr.audio);
      u32(ptr.span + 8, 2);
      u32(ptr.span + 12, frames);
      u32(ptr.span + 16, frames);
      if (noteOn) {
        this.m.HEAPU8.fill(0, ptr.events, ptr.events + 28);
        v.setUint16(ptr.events, 28, true);
        v.setUint16(ptr.events + 2, 1, true); // NOTE_ON
        u32(ptr.events + 12, 1); // note ID
        v.setInt16(ptr.events + 16, 52, true);
        v.setInt16(ptr.events + 18, -1, true);
        v.setFloat32(ptr.events + 20, 0.72, true);
      }
      this.m.HEAPU8.fill(0, ptr.process, ptr.process + 64);
      u32(ptr.process, 64);
      u32(ptr.process + 4, frames);
      u32(ptr.process + 8, ptr.span);
      u32(ptr.process + 12, ptr.events);
      u32(ptr.process + 16, noteOn ? 28 : 0);
      u32(ptr.process + 20, noteOn ? 1 : 0);
      u32(ptr.process + 28, 1); // BRK_PROCESS_REALTIME
      const code = this.m._brk_instance_process(this.handle, ptr.process);
      if (code !== 0) throw new Error("Modal Worklet process ABI error " + code);
      const audio = new Float32Array(this.m.HEAPF32.buffer, ptr.audio, frames * 2);
      for (let channel = 0; channel < 2; channel += 1) {
        for (let frame = 0; frame < frames; frame += 1) {
          const sample = audio[channel * frames + frame];
          if (!Number.isFinite(sample)) throw new Error("non-finite Modal audio output");
          out[channel][frame] = sample;
          this.sumSquares += sample * sample;
          this.peak = Math.max(this.peak, Math.abs(sample));
        }
      }
      this.blocks++;
      if (this.blocks >= 32) {
        this.port.postMessage({
          status: "complete",
          blocks: this.blocks,
          sampleCount: this.blocks * frames * 2,
          peak: this.peak,
          rms: Math.sqrt(this.sumSquares / (this.blocks * frames * 2)),
          wasmMemoryBytes: this.m.HEAPU8.buffer.byteLength,
          memoryGrowth: this.m.HEAPU8.buffer.byteLength !== this.memoryBefore,
        });
        return false;
      }
      return true;
    } catch (error) {
      this.port.postMessage({ status: "error", message: String(error && error.message || error) });
      return false;
    }
  }
}
registerProcessor("brk-modal-qualification", BRKModalQualificationProcessor);
