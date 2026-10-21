// BRK DEV POLY — development-channel engine for the BRK Synth ABI v1 host.
// SPDX-License-Identifier: GPL-3.0-only
// Copyright © 2026 Ilya Tolstoukhov / Myldy design
//
// This engine exists so the Sound workspace, Instrument lifecycle, preset and
// realtime-parameter paths can be exercised on a developer machine and in CI.
// The production engine store lives outside this repository, so without a
// local package the Sound surface can only render "ENGINE CATALOG UNAVAILABLE"
// and no sound path is reachable at all.
//
// It is published on the `dev` channel under its own module/engine id. It is
// never a substitute for a production package: nothing resolves to it unless a
// Project explicitly references `design.myldy.dev/brk-dev-poly`, and the host's
// exact package pinning applies to it exactly as it does to any other engine.
//
// The host composes a Worklet module from `runtime.directJs` + `runtime.directWasm`
// and awaits a global `Module({ wasmBinary })` factory, so this file provides
// that factory. The DSP is plain JavaScript over the same heap layout an
// Emscripten module would expose, which keeps the host path identical.
(() => {
  "use strict";

  const ABI_VERSION = 0x00010000;
  // Must match the package manifest; the engine is the authority and the test
  // asserts the two agree.
  const STATE_SCHEMA_VERSION = 1;
  // One voice per instance. The name is aspirational - the host reaches
  // polyphony by creating several instances, not by this engine stacking
  // voices - and reporting 1 is the honest answer to what it can play.
  const MAX_POLYPHONY = 1;
  const BRK_OK = 0;
  const BRK_ERROR = 1;

  const EVENT = Object.freeze({
    NOTE_ON: 1,
    NOTE_OFF: 2,
    NOTE_CHOKE: 3,
    RETRIGGER: 4,
    PARAM_VALUE: 5,
    PARAM_RAMP: 6,
    ALL_NOTES_OFF: 7,
    RESET: 8,
  });

  // Stable ABI ids. These must match the parameter descriptor shipped in the
  // package manifest, because the host addresses parameters by abiId only.
  const PARAM = Object.freeze({
    SHAPE: 0x0201,
    CUTOFF: 0x0202,
    RESONANCE: 0x0203,
    ATTACK: 0x0204,
    DECAY: 0x0205,
    SUSTAIN: 0x0206,
    RELEASE: 0x0207,
    LEVEL: 0x0208,
    PAN: 0x0209,
  });

  // What this engine says about its own parameters, over the ABI.
  //
  // BRK ABI v1 exposes brk_module_descriptor / brk_engine_descriptor /
  // brk_parameter_descriptor so a host can ask the engine binary directly what
  // its parameters are, rather than trusting a JSON file that can drift from
  // the DSP. BRKSNTH's own host treats this as the authoritative source
  // (host/browser/brk_sound_ui_model.mjs) and uses the package's UI profile
  // only as a presentation overlay. See BRKTRK#455.
  //
  // The development engine implements it so that path is reachable from a
  // clone at all: without it there is no engine in the repository that answers
  // these calls, and the host side cannot be tested.
  //
  // plainMin/plainMax of 0..1 with an empty unit means "genuinely normalized" -
  // not "unknown". CUTOFF is deliberately normalized here: its audible ceiling
  // is sampleRate * NYQUIST_GUARD, and a static descriptor cannot honestly
  // encode a value that depends on the AudioContext the host happens to open.
  const PARAMETER_TYPE = Object.freeze({ CONTINUOUS: 0, ENUM: 1 });
  const PARAMETER_DESCRIPTORS = Object.freeze([
    { key: "shape", abiId: PARAM.SHAPE, displayName: "SHAPE", unit: "", groupKey: "OSC", type: PARAMETER_TYPE.ENUM, plainMin: 0, plainMax: 3, plainStep: 1, enumValueCount: 4 },
    { key: "cutoff", abiId: PARAM.CUTOFF, displayName: "CUTOFF", unit: "", groupKey: "FILTER", type: PARAMETER_TYPE.CONTINUOUS, plainMin: 0, plainMax: 1, plainStep: 0, enumValueCount: 0 },
    { key: "resonance", abiId: PARAM.RESONANCE, displayName: "RES", unit: "", groupKey: "FILTER", type: PARAMETER_TYPE.CONTINUOUS, plainMin: 0, plainMax: 1, plainStep: 0, enumValueCount: 0 },
    { key: "attack", abiId: PARAM.ATTACK, displayName: "ATTACK", unit: "ms", groupKey: "ENV", type: PARAMETER_TYPE.CONTINUOUS, plainMin: 1, plainMax: 4000, plainStep: 0, enumValueCount: 0 },
    { key: "decay", abiId: PARAM.DECAY, displayName: "DECAY", unit: "ms", groupKey: "ENV", type: PARAMETER_TYPE.CONTINUOUS, plainMin: 1, plainMax: 4000, plainStep: 0, enumValueCount: 0 },
    { key: "sustain", abiId: PARAM.SUSTAIN, displayName: "SUSTAIN", unit: "", groupKey: "ENV", type: PARAMETER_TYPE.CONTINUOUS, plainMin: 0, plainMax: 1, plainStep: 0, enumValueCount: 0 },
    { key: "release", abiId: PARAM.RELEASE, displayName: "RELEASE", unit: "ms", groupKey: "ENV", type: PARAMETER_TYPE.CONTINUOUS, plainMin: 1, plainMax: 4000, plainStep: 0, enumValueCount: 0 },
    { key: "level", abiId: PARAM.LEVEL, displayName: "LEVEL", unit: "", groupKey: "AMP", type: PARAMETER_TYPE.CONTINUOUS, plainMin: 0, plainMax: 1, plainStep: 0, enumValueCount: 0 },
    { key: "pan", abiId: PARAM.PAN, displayName: "PAN", unit: "", groupKey: "AMP", type: PARAMETER_TYPE.CONTINUOUS, plainMin: -100, plainMax: 100, plainStep: 0, enumValueCount: 0 },
  ]);
  globalThis.__BRK_DEV_POLY_DESCRIPTORS = PARAMETER_DESCRIPTORS;

  const MODULE_ID = "design.myldy.dev";
  const ENGINE_ID = "brk-dev-poly";
  const DISPLAY_NAME = "BRK DEV POLY";
  const VENDOR_NAME = "Myldy design";
  const LICENSE_ID = "GPL-3.0-only";

  // brk_module_descriptor_v1 / brk_engine_descriptor_v1 /
  // brk_parameter_descriptor_v1 from the BRK ABI header. brk_string_ref is
  // {offset u32, byte_size u32}. The parameter struct's 96-byte size is fixed
  // by the ABI (ParameterDescriptorSize), so the trailing reserved words are
  // part of the contract, not padding this engine chose.
  const MODULE_DESCRIPTOR_BYTES = 84;
  const ENGINE_DESCRIPTOR_BYTES = 76;
  const PARAMETER_DESCRIPTOR_BYTES = 96;

  const DEFAULTS = Object.freeze({
    [PARAM.SHAPE]: 0.0,
    [PARAM.CUTOFF]: 0.72,
    [PARAM.RESONANCE]: 0.18,
    [PARAM.ATTACK]: 0.02,
    [PARAM.DECAY]: 0.35,
    [PARAM.SUSTAIN]: 0.65,
    [PARAM.RELEASE]: 0.30,
    [PARAM.LEVEL]: 0.80,
    [PARAM.PAN]: 0.50,
  });

  const HEAP_BYTES = 4 * 1024 * 1024;
  const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
  const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);

  // Normalized 0..1 cutoff mapped over a musical range rather than linear Hz.
  const cutoffHz = (normalized) => 30 * Math.pow(2, clamp(normalized, 0, 1) * 9.5);
  const midiToHz = (pitch) => 440 * Math.pow(2, (pitch - 69) / 12);
  // 1ms..4s, exponential, so short values stay usable on a normalized control.
  const timeSeconds = (normalized) => 0.001 * Math.pow(4000, clamp(normalized, 0, 1));

  const STAGE = Object.freeze({ IDLE: 0, ATTACK: 1, DECAY: 2, SUSTAIN: 3, RELEASE: 4 });

  // Published so the package descriptor and the DSP cannot drift apart: the
  // build declares these as the control's enum values and the package test
  // asserts the two lists are identical.
  const SHAPE_LABELS = Object.freeze(["SAW", "SQUARE", "SINE", "NOISE"]);
  const shapeIndex = (value) => Math.max(
    0,
    Math.min(SHAPE_LABELS.length - 1, Math.round(clamp(value, 0, 1) * (SHAPE_LABELS.length - 1))),
  );
  globalThis.__BRK_DEV_POLY_SHAPES = SHAPE_LABELS;

  class Voice {
    constructor(sampleRate) {
      this.sampleRate = sampleRate;
      this.reset();
    }

    reset() {
      this.stage = STAGE.IDLE;
      this.envelope = 0;
      this.phase = 0;
      this.increment = 0;
      this.noteId = 0;
      this.velocity = 0;
      // Two-pole state-variable filter state.
      this.low = 0;
      this.band = 0;
      this.noiseSeed = 22222;
      this.params = new Float32Array(0x0300);
      for (const [id, value] of Object.entries(DEFAULTS)) this.params[Number(id)] = value;
      this.ramps = new Map();
      // 4 ms one-pole dezipper for controls that otherwise step audio abruptly.
      // A 128-frame block at 48 kHz is only 2.7 ms. Use sample-rate-aware
      // smoothing per frame so fast UI events never bypass the transition.
      this.smoothedParams = new Float32Array(this.params);
      this.smoothingAlpha = 1 - Math.exp(-1 / (Math.max(1, this.sampleRate) * 0.004));
    }

    param(id) {
      return id === PARAM.CUTOFF || id === PARAM.RESONANCE || id === PARAM.LEVEL || id === PARAM.PAN
        ? this.smoothedParams[id] : this.params[id];
    }

    smoothAudioParameters() {
      const alpha = this.smoothingAlpha;
      for (const id of [PARAM.CUTOFF, PARAM.RESONANCE, PARAM.LEVEL, PARAM.PAN]) {
        const current = this.smoothedParams[id];
        const target = this.params[id];
        this.smoothedParams[id] = Math.abs(target - current) < 1e-6 ? target
          : current + (target - current) * alpha;
      }
    }

    setParam(id, value) {
      if (id < 0 || id >= this.params.length) return;
      this.params[id] = clamp(finite(value, 0), 0, 1);
      // Initialization and stopped playback should begin with exact preset
      // values. Only edits while an active voice is sounding need a fade.
      if (this.stage === STAGE.IDLE && this.smoothedParams) this.smoothedParams[id] = this.params[id];
      this.ramps.delete(id);
    }

    startRamp(id, start, end, frames) {
      if (id < 0 || id >= this.params.length) return;
      this.params[id] = clamp(finite(start, 0), 0, 1);
      if (this.stage === STAGE.IDLE && this.smoothedParams) this.smoothedParams[id] = this.params[id];
      this.ramps.set(id, { value: this.params[id], end: clamp(finite(end, 0), 0, 1), remaining: Math.max(1, frames | 0) });
    }

    advanceRamps() {
      if (this.ramps.size === 0) return;
      for (const [id, ramp] of this.ramps) {
        const step = (ramp.end - ramp.value) / ramp.remaining;
        ramp.value += step;
        ramp.remaining -= 1;
        this.params[id] = clamp(ramp.value, 0, 1);
        if (ramp.remaining <= 0) {
          this.params[id] = ramp.end;
          this.ramps.delete(id);
        }
      }
    }

    noteOn(noteId, pitch, velocity, retrigger) {
      this.noteId = noteId;
      this.velocity = clamp(finite(velocity, 0), 0, 1);
      this.increment = midiToHz(clamp(finite(pitch, 60), 0, 127)) / this.sampleRate;
      // A retrigger keeps the envelope level and restarts the attack segment so
      // repeated rows do not click; a fresh note starts from silence.
      if (!retrigger) {
        this.phase = 0;
        this.envelope = 0;
        this.low = 0;
        this.band = 0;
      }
      this.stage = STAGE.ATTACK;
    }

    noteOff() {
      if (this.stage === STAGE.IDLE) return;
      this.stage = STAGE.RELEASE;
    }

    choke() {
      this.stage = STAGE.IDLE;
      this.envelope = 0;
      this.noteId = 0;
      this.low = 0;
      this.band = 0;
    }

    oscillator() {
      const phase = this.phase;
      // Quantized exactly the way sound-edit-renderer picks an enum label
      // (round(value * (count - 1))), so the name shown on the control is
      // always the waveform that is heard. Thresholds that merely looked
      // reasonable would drift from the label at the segment edges.
      const index = shapeIndex(this.param(PARAM.SHAPE));
      if (index === 0) return 2 * phase - 1;                         // SAW
      if (index === 1) return phase < 0.5 ? 1 : -1;                   // SQUARE
      if (index === 2) return Math.sin(phase * Math.PI * 2);          // SINE
      // xorshift noise, deterministic per voice so renders are reproducible
      this.noiseSeed ^= this.noiseSeed << 13;
      this.noiseSeed ^= this.noiseSeed >>> 17;
      this.noiseSeed ^= this.noiseSeed << 5;
      return (this.noiseSeed / 0x80000000) % 1;
    }

    envelopeStep() {
      const rate = (seconds) => 1 / Math.max(1, seconds * this.sampleRate);
      if (this.stage === STAGE.ATTACK) {
        this.envelope += rate(timeSeconds(this.param(PARAM.ATTACK)));
        if (this.envelope >= 1) { this.envelope = 1; this.stage = STAGE.DECAY; }
      } else if (this.stage === STAGE.DECAY) {
        const sustain = this.param(PARAM.SUSTAIN);
        this.envelope -= rate(timeSeconds(this.param(PARAM.DECAY))) * (1 - sustain);
        if (this.envelope <= sustain) { this.envelope = sustain; this.stage = STAGE.SUSTAIN; }
      } else if (this.stage === STAGE.RELEASE) {
        this.envelope -= rate(timeSeconds(this.param(PARAM.RELEASE)));
        if (this.envelope <= 0) { this.envelope = 0; this.stage = STAGE.IDLE; this.noteId = 0; }
      }
      return this.envelope;
    }

    filter(input) {
      const f = 2 * Math.sin(Math.PI * Math.min(cutoffHz(this.param(PARAM.CUTOFF)), this.sampleRate * 0.45) / this.sampleRate);
      const q = 1 - clamp(this.param(PARAM.RESONANCE), 0, 0.97) * 0.97;
      const high = input - this.low - q * this.band;
      this.band += f * high;
      this.low += f * this.band;
      if (!Number.isFinite(this.low) || !Number.isFinite(this.band)) { this.low = 0; this.band = 0; }
      return this.low;
    }

    render(frames, left, right, leftStart, rightStart) {
      for (let frame = 0; frame < frames; frame += 1) {
        this.advanceRamps();
        this.smoothAudioParameters();
        if (this.stage === STAGE.IDLE) {
          left[leftStart + frame] = 0;
          right[rightStart + frame] = 0;
          continue;
        }
        const raw = this.oscillator();
        this.phase += this.increment;
        if (this.phase >= 1) this.phase -= 1;
        const shaped = this.filter(raw);
        const amplitude = this.envelopeStep() * this.velocity * this.param(PARAM.LEVEL);
        const sample = clamp(shaped * amplitude, -1, 1);
        // Equal-power pan keeps the summed level steady across the image.
        const pan = clamp(this.param(PARAM.PAN), 0, 1) * (Math.PI / 2);
        left[leftStart + frame] = sample * Math.cos(pan);
        right[rightStart + frame] = sample * Math.sin(pan);
      }
    }
  }

  // The host evaluates this file inside AudioWorkletGlobalScope, which has no
  // TextEncoder (nor TextDecoder, atob or setTimeout). A `new TextEncoder()`
  // here passed every Node test and threw in every browser, so this engine -
  // the only one a fresh clone has - never registered in a real Worklet and
  // the Sound path it exists to exercise was unreachable where it mattered.
  // Encode by hand: lone surrogates become U+FFFD, exactly as TextEncoder does.
  function utf8Bytes(text) {
    const bytes = [];
    for (const character of text) {
      let codePoint = character.codePointAt(0);
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) codePoint = 0xfffd;
      if (codePoint < 0x80) bytes.push(codePoint);
      else if (codePoint < 0x800) bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
      else if (codePoint < 0x10000) {
        bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
      } else {
        bytes.push(
          0xf0 | (codePoint >> 18),
          0x80 | ((codePoint >> 12) & 0x3f),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        );
      }
    }
    return Uint8Array.from(bytes);
  }

  function createModule() {
    const buffer = new ArrayBuffer(HEAP_BYTES);
    const HEAPU8 = new Uint8Array(buffer);
    const HEAPF32 = new Float32Array(buffer);
    const view = new DataView(buffer);
    let cursor = 16384;
    let nextHandle = 0;
    const instances = new Map();

    // Descriptor strings are brk_string_ref {offset, byte_size} into this
    // heap. They are interned once and never freed: the set is fixed at build
    // time and a host may hold a ref for as long as the module lives.
    const internedStrings = new Map();
    function internString(text) {
      const value = String(text ?? "");
      const existing = internedStrings.get(value);
      if (existing) return existing;
      const bytes = utf8Bytes(value);
      const ptr = cursor;
      cursor += (bytes.byteLength + 15) & ~15;
      if (cursor > HEAP_BYTES) throw new RangeError("brk-dev-poly heap exhausted");
      HEAPU8.set(bytes, ptr);
      const ref = Object.freeze({ offset: ptr, byteSize: bytes.byteLength });
      internedStrings.set(value, ref);
      return ref;
    }
    function writeStringRef(structOffset, text) {
      const ref = internString(text);
      view.setUint32(structOffset, ref.offset, true);
      view.setUint32(structOffset + 4, ref.byteSize, true);
    }

    const module = {
      HEAPU8,
      HEAPF32,
      HEAP32: new Int32Array(buffer),
      _malloc(size) {
        const bytes = Math.max(0, Number(size) | 0);
        const ptr = cursor;
        cursor += (bytes + 15) & ~15;
        if (cursor > HEAP_BYTES) throw new RangeError("brk-dev-poly heap exhausted");
        return ptr;
      },
      _free() {},
      _brk_abi_version() { return ABI_VERSION; },

      // --- ABI descriptor surface -----------------------------------------
      // Each call writes its struct at dstOffset and returns the byte count it
      // needs. A host may pass capacity 0 to size the buffer first, which is
      // why the required size is returned even when nothing is written.
      _brk_module_descriptor(dstOffset, dstCapacity) {
        if (Number(dstCapacity) < MODULE_DESCRIPTOR_BYTES) return MODULE_DESCRIPTOR_BYTES;
        const base = Number(dstOffset);
        HEAPU8.fill(0, base, base + MODULE_DESCRIPTOR_BYTES);
        view.setUint32(base + 0, MODULE_DESCRIPTOR_BYTES, true);
        view.setUint32(base + 4, ABI_VERSION, true);
        view.setUint32(base + 8, ABI_VERSION, true);
        view.setUint32(base + 12, 1, true);
        writeStringRef(base + 16, MODULE_ID);
        writeStringRef(base + 24, DISPLAY_NAME);
        writeStringRef(base + 32, VENDOR_NAME);
        writeStringRef(base + 40, LICENSE_ID);
        view.setUint32(base + 48, 0, true);
        return MODULE_DESCRIPTOR_BYTES;
      },

      _brk_engine_descriptor(engineIndex, dstOffset, dstCapacity) {
        if (Number(engineIndex) !== 0) return 0;
        if (Number(dstCapacity) < ENGINE_DESCRIPTOR_BYTES) return ENGINE_DESCRIPTOR_BYTES;
        const base = Number(dstOffset);
        HEAPU8.fill(0, base, base + ENGINE_DESCRIPTOR_BYTES);
        view.setUint32(base + 0, ENGINE_DESCRIPTOR_BYTES, true);
        view.setUint32(base + 4, 0, true);
        writeStringRef(base + 8, ENGINE_ID);
        writeStringRef(base + 16, DISPLAY_NAME);
        view.setUint32(base + 24, 2, true);
        view.setUint32(base + 28, PARAMETER_DESCRIPTORS.length, true);
        view.setUint32(base + 32, STATE_SCHEMA_VERSION, true);
        view.setUint32(base + 36, MAX_POLYPHONY, true);
        view.setUint32(base + 40, 0, true);
        return ENGINE_DESCRIPTOR_BYTES;
      },

      _brk_parameter_descriptor(engineIndex, parameterIndex, dstOffset, dstCapacity) {
        if (Number(engineIndex) !== 0) return 0;
        const descriptor = PARAMETER_DESCRIPTORS[Number(parameterIndex)];
        if (!descriptor) return 0;
        if (Number(dstCapacity) < PARAMETER_DESCRIPTOR_BYTES) return PARAMETER_DESCRIPTOR_BYTES;
        const base = Number(dstOffset);
        HEAPU8.fill(0, base, base + PARAMETER_DESCRIPTOR_BYTES);
        view.setUint32(base + 0, PARAMETER_DESCRIPTOR_BYTES, true);
        view.setUint32(base + 4, descriptor.abiId, true);
        view.setUint32(base + 8, descriptor.type, true);
        view.setUint32(base + 12, 0, true);
        writeStringRef(base + 16, descriptor.key);
        writeStringRef(base + 24, descriptor.displayName);
        writeStringRef(base + 32, descriptor.unit);
        writeStringRef(base + 40, descriptor.groupKey);
        view.setFloat32(base + 48, DEFAULTS[descriptor.abiId] ?? 0, true);
        view.setFloat32(base + 52, descriptor.plainMin, true);
        view.setFloat32(base + 56, descriptor.plainMax, true);
        view.setFloat32(base + 60, descriptor.plainStep, true);
        view.setUint32(base + 64, descriptor.enumValueCount, true);
        return PARAMETER_DESCRIPTOR_BYTES;
      },

      _brk_instance_create() {
        const handle = (nextHandle += 1);
        instances.set(handle, { voice: null, sampleRate: 48000, maxBlockFrames: 0 });
        return handle;
      },

      _brk_instance_prepare(handle, preparePtr) {
        const instance = instances.get(Number(handle));
        if (!instance) return BRK_ERROR;
        const sampleRate = view.getFloat64(preparePtr + 8, true);
        instance.sampleRate = sampleRate > 0 ? sampleRate : 48000;
        instance.maxBlockFrames = view.getUint32(preparePtr + 16, true);
        instance.voice = new Voice(instance.sampleRate);
        return BRK_OK;
      },

      _brk_instance_activate(handle) { return instances.has(Number(handle)) ? BRK_OK : BRK_ERROR; },
      _brk_instance_deactivate(handle) { return instances.has(Number(handle)) ? BRK_OK : BRK_ERROR; },

      _brk_instance_reset(handle) {
        const instance = instances.get(Number(handle));
        if (!instance?.voice) return BRK_ERROR;
        instance.voice.reset();
        return BRK_OK;
      },

      _brk_instance_destroy(handle) {
        instances.delete(Number(handle));
        return BRK_OK;
      },

      // Patch state is a flat little-endian [abiId u16][value f32] table so a
      // preset round-trips through the host's opaque state path unchanged.
      _brk_instance_state_read(handle, statePtr, byteLength, _schemaVersion) {
        const instance = instances.get(Number(handle));
        if (!instance?.voice) return BRK_ERROR;
        // `[abiId u16][value f32]` little-endian pairs. State is a fixed
        // stateBytes block, so a preset that sets fewer parameters than the
        // block holds is padded with zeros; abiId 0 is not a parameter, so it
        // terminates rather than being written back as one.
        const count = Math.floor(Number(byteLength) / 6);
        for (let index = 0; index < count; index += 1) {
          const offset = statePtr + index * 6;
          const abiId = view.getUint16(offset, true);
          if (abiId === 0) break;
          instance.voice.setParam(abiId, view.getFloat32(offset + 2, true));
        }
        return BRK_OK;
      },

      _brk_instance_process(handle, processPtr) {
        const instance = instances.get(Number(handle));
        if (!instance?.voice) return BRK_ERROR;
        const frames = view.getUint32(processPtr + 4, true);
        const audioSpanPtr = view.getUint32(processPtr + 8, true);
        const eventPtr = view.getUint32(processPtr + 12, true);
        const eventCount = view.getUint32(processPtr + 20, true);
        const outputPtr = view.getUint32(audioSpanPtr + 4, true);
        const maxBlockFrames = view.getUint32(audioSpanPtr + 12, true);
        if (!frames || !outputPtr) return BRK_OK;

        const voice = instance.voice;
        const leftStart = outputPtr >>> 2;
        const rightStart = leftStart + maxBlockFrames;

        // Events carry a frame offset inside the block, so render in segments
        // between them rather than applying everything at the block boundary.
        let cursorFrame = 0;
        let offset = eventPtr;
        for (let index = 0; index < eventCount; index += 1) {
          const size = view.getUint16(offset, true);
          const type = view.getUint16(offset + 2, true);
          const frameOffset = Math.min(view.getUint32(offset + 4, true), frames);
          if (frameOffset > cursorFrame) {
            voice.render(frameOffset - cursorFrame, HEAPF32, HEAPF32, leftStart + cursorFrame, rightStart + cursorFrame);
            cursorFrame = frameOffset;
          }
          if (type === EVENT.NOTE_ON || type === EVENT.RETRIGGER) {
            voice.noteOn(
              view.getUint32(offset + 12, true),
              view.getInt16(offset + 16, true),
              view.getFloat32(offset + 20, true),
              type === EVENT.RETRIGGER,
            );
          } else if (type === EVENT.NOTE_OFF) {
            voice.noteOff();
          } else if (type === EVENT.NOTE_CHOKE || type === EVENT.ALL_NOTES_OFF) {
            voice.choke();
          } else if (type === EVENT.RESET) {
            voice.reset();
          } else if (type === EVENT.PARAM_VALUE) {
            voice.setParam(view.getUint32(offset + 12, true), view.getFloat32(offset + 16, true));
          } else if (type === EVENT.PARAM_RAMP) {
            voice.startRamp(
              view.getUint32(offset + 12, true),
              view.getFloat32(offset + 16, true),
              view.getFloat32(offset + 20, true),
              view.getUint32(offset + 24, true),
            );
          }
          offset += size > 0 ? size : 12;
        }
        if (cursorFrame < frames) {
          voice.render(frames - cursorFrame, HEAPF32, HEAPF32, leftStart + cursorFrame, rightStart + cursorFrame);
        }
        return BRK_OK;
      },
    };

    return module;
  }

  // The host awaits `Module({ wasmBinary })`. This engine's DSP is JavaScript,
  // so the binary is accepted and ignored; the returned object exposes exactly
  // the heap + `_brk_*` surface the ABI-v1 runtime drives.
  globalThis.Module = async function Module() {
    return createModule();
  };
})();
