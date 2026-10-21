(() => {
  "use strict";

  const SLOT_COUNT = 2;
  const VALUE_COUNT = 8;
  const SWITCH_FADE_SECONDS = 0.005;
  const DELAY_SIZE = 4096;
  const TWO_PI = 6.283185307179586;

  const MAPPING = Object.freeze({
    LINEAR: "linear",
    EXPONENTIAL: "exponential",
    BIPOLAR: "bipolar",
    DISCRETE: "discrete",
  });

  const parameter = (id, label, unit, minimum, maximum, initial, mapping, labels = null) => Object.freeze({
    id, label, unit, minimum, maximum, initial, mapping,
    ...(labels ? { labels: Object.freeze([...labels]) } : {}),
  });
  const moduleDef = (id, label, parameters) => Object.freeze({
    id, label,
    parameters: Object.freeze(parameters),
  });

  // ChooChooTracker donor descriptors, Wave A only.
  // Source: paiheulevrai/Choochootracker
  // chipnomad_lib/insert_fx.cpp @ 859c69ac30ad8e97d2d097c2de18d194ce1ecb85
  const MODULES = Object.freeze([
    moduleDef("off", "OFF", []),
    moduleDef("chorus", "Chorus", [
      parameter("rate", "Rate", "Hz", 0.05, 20, 82, MAPPING.EXPONENTIAL),
      parameter("depth", "Depth", "ms", 0.2, 35, 115, MAPPING.EXPONENTIAL),
      parameter("tone", "Tone", "Hz", 800, 18000, 210, MAPPING.EXPONENTIAL),
      parameter("mix", "Mix", "%", 0, 1, 96, MAPPING.LINEAR),
      parameter("feedback", "Feedback", "%", -0.95, 0.95, 128, MAPPING.BIPOLAR),
    ]),
    moduleDef("phaser", "Phaser", [
      parameter("rate", "Rate", "Hz", 0.02, 15, 60, MAPPING.EXPONENTIAL),
      parameter("depth", "Depth", "%", 0, 1.5, 160, MAPPING.LINEAR),
      parameter("feedback", "Feedback", "%", -0.98, 0.98, 144, MAPPING.BIPOLAR),
      parameter("mix", "Mix", "%", 0, 1, 128, MAPPING.LINEAR),
      parameter("stages", "Stages", "", 0, 4, 0, MAPPING.DISCRETE, ["4", "5", "6", "7", "8"]),
    ]),
    moduleDef("saturation", "Saturation", [
      parameter("drive", "Drive", "dB", 0, 18, 80, MAPPING.LINEAR),
      parameter("tone", "Tone", "Hz", 500, 18000, 220, MAPPING.EXPONENTIAL),
      parameter("level", "Level", "dB", -12, 12, 128, MAPPING.BIPOLAR),
      parameter("mix", "Mix", "%", 0, 1, 255, MAPPING.LINEAR),
    ]),
    moduleDef("bitcrusher", "Bitcrusher", [
      parameter("bits", "Bit depth", "bit", 0, 12, 8, MAPPING.DISCRETE,
        Array.from({ length: 13 }, (_, index) => String(index + 4))),
      parameter("rate", "Rate reduction", "x", 0, 31, 3, MAPPING.DISCRETE,
        Array.from({ length: 32 }, (_, index) => String(index + 1))),
      parameter("tone", "Tone", "Hz", 600, 18000, 220, MAPPING.EXPONENTIAL),
      parameter("mix", "Mix", "%", 0, 1, 192, MAPPING.LINEAR),
    ]),
  ]);
  const MODULE_BY_ID = new Map(MODULES.map((entry) => [entry.id, entry]));

  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  const byte = (value, fallback = 0) => clamp(Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback, 0, 255);

  function descriptor(moduleId) {
    return MODULE_BY_ID.get(String(moduleId ?? "off").toLowerCase()) ?? MODULE_BY_ID.get("off");
  }

  function clampValue(moduleId, parameterIndex, value) {
    const spec = descriptor(moduleId).parameters[Number(parameterIndex)];
    if (!spec) return 0;
    const maximum = spec.mapping === MAPPING.DISCRETE ? spec.maximum : 255;
    return clamp(byte(value, spec.initial), 0, maximum);
  }

  function mapValue(moduleId, parameterIndex, value) {
    const spec = descriptor(moduleId).parameters[Number(parameterIndex)];
    if (!spec) return 0;
    const normalizedByte = clampValue(moduleId, parameterIndex, value);
    if (spec.mapping === MAPPING.DISCRETE) return normalizedByte;
    const x = normalizedByte / 255;
    if (spec.mapping === MAPPING.EXPONENTIAL) return spec.minimum * Math.pow(spec.maximum / spec.minimum, x);
    if (spec.mapping === MAPPING.BIPOLAR) {
      return normalizedByte >= 128
        ? spec.maximum * (normalizedByte - 128) / 127
        : -spec.minimum * (normalizedByte - 128) / 128;
    }
    return spec.minimum + (spec.maximum - spec.minimum) * x;
  }

  function defaultValues(moduleId) {
    const spec = descriptor(moduleId);
    const values = Array(VALUE_COUNT).fill(0);
    spec.parameters.forEach((entry, index) => { values[index] = entry.initial; });
    return Object.freeze(values);
  }

  function normalizeValues(moduleId, values) {
    const spec = descriptor(moduleId);
    const source = Array.isArray(values) ? values : [];
    const output = Array(VALUE_COUNT).fill(0);
    for (let index = 0; index < spec.parameters.length; index += 1) {
      output[index] = clampValue(spec.id, index, source[index] ?? spec.parameters[index].initial);
    }
    return Object.freeze(output);
  }

  function normalizeSlot(value = {}) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const moduleId = descriptor(source.module ?? source.moduleId ?? "off").id;
    return Object.freeze({
      module: moduleId,
      bypass: Boolean(source.bypass),
      values: normalizeValues(moduleId, source.values),
    });
  }

  function normalizeChain(value = []) {
    const source = Array.isArray(value) ? value : [];
    return Object.freeze(Array.from({ length: SLOT_COUNT }, (_, slot) => normalizeSlot(source[slot])));
  }

  function normalizeTracks(value, trackCount = 8) {
    const source = Array.isArray(value) ? value : [];
    return Object.freeze(Array.from({ length: trackCount }, (_, track) => normalizeChain(source[track])));
  }

  function describeValue(moduleId, parameterIndex, rawValue) {
    const spec = descriptor(moduleId).parameters[Number(parameterIndex)];
    if (!spec) return "Inactive";
    const mapped = mapValue(moduleId, parameterIndex, rawValue);
    if (moduleId === "bitcrusher" && parameterIndex === 0) return `${Math.round(mapped) + 4} bit`;
    if (moduleId === "bitcrusher" && parameterIndex === 1) return `${Math.round(mapped) + 1}x`;
    if (moduleId === "phaser" && parameterIndex === 4) return `${Math.round(mapped) + 4} stages`;
    if (spec.labels) return spec.labels[Math.round(mapped)] ?? String(Math.round(mapped));
    if (spec.unit === "%") return `${(mapped * 100).toFixed(1)}%`;
    if (spec.unit === "Hz") return `${mapped < 10 ? mapped.toFixed(2) : mapped.toFixed(1)} Hz`;
    if (spec.unit === "ms") return `${mapped.toFixed(2)} ms`;
    if (spec.unit === "dB") return `${mapped.toFixed(2)} dB`;
    return Number.isInteger(mapped) ? String(mapped) : mapped.toFixed(2);
  }

  class SlotProcessor {
    constructor(sampleRate) {
      this.sampleRate = sampleRate;
      this.config = normalizeSlot();
      this.module = "off";
      this.pending = "off";
      this.wet = 0;
      this.switching = false;
      this.previousValues = Array(VALUE_COUNT).fill(0);
      this.delay = [new Float32Array(DELAY_SIZE), new Float32Array(DELAY_SIZE)];
      this.filter = new Float64Array(2);
      this.allpassX = [new Float64Array(8), new Float64Array(8)];
      this.allpassY = [new Float64Array(8), new Float64Array(8)];
      this.phaserFeedback = new Float64Array(2);
      this.feedback = new Float64Array(2);
      this.held = new Float64Array(2);
      this.phase = 0;
      this.delayWrite = 0;
      this.holdCounter = 0;
      this.toneCoefficient = 1;
      this.dirty = true;
      this.scratchLeft = new Float32Array(128);
      this.scratchRight = new Float32Array(128);
      this.mapped = new Float64Array(VALUE_COUNT);
    }

    resetDsp(moduleId) {
      this.module = descriptor(moduleId).id;
      this.pending = this.module;
      this.delay[0].fill(0);
      this.delay[1].fill(0);
      this.filter.fill(0);
      this.allpassX[0].fill(0);
      this.allpassX[1].fill(0);
      this.allpassY[0].fill(0);
      this.allpassY[1].fill(0);
      this.phaserFeedback.fill(0);
      this.feedback.fill(0);
      this.held.fill(0);
      this.phase = 0;
      this.delayWrite = 0;
      this.holdCounter = 0;
      this.dirty = true;
    }

    sync(value) {
      const next = normalizeSlot(value);
      if (next.module !== this.config.module) {
        this.pending = next.module;
        this.switching = true;
      }
      this.config = next;
      return next;
    }

    coefficient(cutoff) {
      return 1 - Math.exp(-TWO_PI * cutoff / this.sampleRate);
    }

    updateParameters(values) {
      let changed = this.dirty;
      for (let index = 0; index < VALUE_COUNT; index += 1) {
        if (this.previousValues[index] !== values[index]) { changed = true; break; }
      }
      if (!changed) return;
      if (this.module === "chorus") this.toneCoefficient = this.coefficient(mapValue(this.module, 2, values[2]));
      else if (this.module === "saturation") this.toneCoefficient = this.coefficient(mapValue(this.module, 1, values[1]));
      else if (this.module === "bitcrusher") this.toneCoefficient = this.coefficient(mapValue(this.module, 2, values[2]));
      for (let index = 0; index < VALUE_COUNT; index += 1) this.previousValues[index] = values[index];
      this.dirty = false;
    }

    lowpass(channel, input) {
      this.filter[channel] += this.toneCoefficient * (input - this.filter[channel]);
      return this.filter[channel];
    }

    readDelay(channel, samples) {
      const bounded = clamp(samples, 1, DELAY_SIZE - 2);
      const whole = Math.trunc(bounded);
      const fraction = bounded - whole;
      let index = this.delayWrite - whole;
      if (index < 0) index += DELAY_SIZE;
      const previous = index ? index - 1 : DELAY_SIZE - 1;
      return this.delay[channel][index] * (1 - fraction) + this.delay[channel][previous] * fraction;
    }

    processEffect(left, right, frames, values) {
      this.updateParameters(values);
      const p = this.mapped;
      for (let index = 0; index < VALUE_COUNT; index += 1) p[index] = mapValue(this.module, index, values[index]);

      if (this.module === "saturation") {
        const drive = Math.pow(10, p[0] / 20);
        const level = Math.pow(10, p[2] / 20);
        for (let frame = 0; frame < frames; frame += 1) {
          const dryL = left[frame], dryR = right[frame];
          const wetL = this.lowpass(0, Math.tanh(dryL * drive) / drive) * level;
          const wetR = this.lowpass(1, Math.tanh(dryR * drive) / drive) * level;
          left[frame] = dryL + p[3] * (wetL - dryL);
          right[frame] = dryR + p[3] * (wetR - dryR);
        }
        return;
      }

      if (this.module === "bitcrusher") {
        const hold = Math.trunc(p[1]) + 1;
        const levels = (1 << (Math.trunc(p[0]) + 4)) - 1;
        for (let frame = 0; frame < frames; frame += 1) {
          const dryL = left[frame], dryR = right[frame];
          if (this.holdCounter === 0) {
            this.held[0] = Math.round(clamp(dryL, -1, 1) * levels) / levels;
            this.held[1] = Math.round(clamp(dryR, -1, 1) * levels) / levels;
            this.holdCounter = hold;
          }
          const wetL = this.lowpass(0, this.held[0]);
          const wetR = this.lowpass(1, this.held[1]);
          left[frame] = dryL + p[3] * (wetL - dryL);
          right[frame] = dryR + p[3] * (wetR - dryR);
          this.holdCounter -= 1;
        }
        return;
      }

      if (this.module === "chorus") {
        const rateHz = p[0], depthMs = p[1], feedback = p[4];
        for (let frame = 0; frame < frames; frame += 1) {
          const dryL = left[frame], dryR = right[frame];
          const modL = Math.sin(this.phase), modR = Math.sin(this.phase + Math.PI);
          const base = Math.max(15, depthMs + 1);
          const delayL = (base + modL * depthMs) * this.sampleRate / 1000;
          const delayR = (base + modR * depthMs) * this.sampleRate / 1000;
          this.delay[0][this.delayWrite] = dryL + this.feedback[0] * feedback;
          this.delay[1][this.delayWrite] = dryR + this.feedback[1] * feedback;
          let wetL = this.readDelay(0, delayL);
          let wetR = this.readDelay(1, delayR);
          this.feedback[0] = wetL;
          this.feedback[1] = wetR;
          wetL = this.lowpass(0, wetL);
          wetR = this.lowpass(1, wetR);
          left[frame] = dryL + p[3] * (wetL - dryL);
          right[frame] = dryR + p[3] * (wetR - dryR);
          this.phase += TWO_PI * rateHz / this.sampleRate;
          if (this.phase >= TWO_PI) this.phase -= TWO_PI;
          if (++this.delayWrite === DELAY_SIZE) this.delayWrite = 0;
        }
        return;
      }

      if (this.module === "phaser") {
        const stageScale = [0.45, 0.65, 0.85, 1.05, 1.3, 1.6, 1.95, 2.35];
        const stages = 4 + Math.trunc(p[4]);
        for (let frame = 0; frame < frames; frame += 1) {
          const dryL = left[frame], dryR = right[frame];
          for (let channel = 0; channel < 2; channel += 1) {
            let x = (channel ? right[frame] : left[frame]) + this.phaserFeedback[channel] * p[2];
            const sidePhase = this.phase + (channel ? Math.PI : 0);
            for (let stage = 0; stage < stages; stage += 1) {
              const sweep = 0.5 + 0.5 * Math.sin(sidePhase + stage * 0.7);
              const cutoff = 120 + sweep * p[1] * 4200 * stageScale[stage];
              const normalized = Math.min(0.95, cutoff / this.sampleRate);
              const a = (1 - normalized) / (1 + normalized);
              const y = a * x + this.allpassX[channel][stage] - a * this.allpassY[channel][stage];
              this.allpassX[channel][stage] = x;
              this.allpassY[channel][stage] = y;
              x = y;
            }
            this.phaserFeedback[channel] = x;
            if (channel) right[frame] = x;
            else left[frame] = x;
          }
          this.phase += TWO_PI * p[0] / this.sampleRate;
          if (this.phase >= TWO_PI) this.phase -= TWO_PI;
          left[frame] = dryL + p[3] * (left[frame] - dryL);
          right[frame] = dryR + p[3] * (right[frame] - dryR);
        }
      }
    }

    process(left, right, frames) {
      const increment = 1 / Math.max(1, this.sampleRate * SWITCH_FADE_SECONDS);
      let offset = 0;
      while (offset < frames) {
        if (this.switching && this.wet <= 0) {
          this.resetDsp(this.pending);
          this.switching = false;
        }
        const target = this.switching || this.config.bypass || this.module === "off" ? 0 : 1;
        if (this.module === "off" || (target === 0 && this.wet === 0)) {
          offset = frames;
          continue;
        }
        let count = Math.min(128, frames - offset);
        if (this.switching) count = Math.min(count, Math.max(1, Math.ceil(this.wet / increment)));

        const localLeft = this.scratchLeft;
        const localRight = this.scratchRight;
        for (let index = 0; index < count; index += 1) {
          const sourceIndex = offset + index;
          let l = left[sourceIndex], r = right[sourceIndex];
          if (!Number.isFinite(l)) l = left[sourceIndex] = 0;
          if (!Number.isFinite(r)) r = right[sourceIndex] = 0;
          localLeft[index] = clamp(l, -32, 32);
          localRight[index] = clamp(r, -32, 32);
        }

        const values = this.switching ? this.previousValues : this.config.values;
        this.processEffect(localLeft, localRight, count, values);

        for (let index = 0; index < count; index += 1) {
          this.wet = target > this.wet ? Math.min(target, this.wet + increment) : Math.max(target, this.wet - increment);
          const sourceIndex = offset + index;
          for (let channel = 0; channel < 2; channel += 1) {
            let processed = channel ? localRight[index] : localLeft[index];
            if (!Number.isFinite(processed)) processed = 0;
            processed = clamp(processed, -32, 32);
            const buffer = channel ? right : left;
            const dry = buffer[sourceIndex];
            buffer[sourceIndex] = dry + this.wet * (processed - dry);
          }
        }
        offset += count;
      }
    }

    diagnostics() {
      return Object.freeze({
        configuredModule: this.config.module,
        module: this.module,
        bypass: this.config.bypass,
        switching: this.switching,
        wet: this.wet,
      });
    }
  }

  class TrackInsertChain {
    constructor(sampleRate) {
      const rate = Number(sampleRate);
      if (!Number.isFinite(rate) || rate <= 0) throw new RangeError("Track Insert FX sample rate must be positive");
      this.sampleRate = rate;
      this.slots = Array.from({ length: SLOT_COUNT }, () => new SlotProcessor(rate));
      this.config = normalizeChain();
    }
    sync(value) {
      const next = normalizeChain(value);
      this.config = next;
      next.forEach((slot, index) => this.slots[index].sync(slot));
      return next;
    }
    process(left, right, frames) {
      const count = Math.min(Number(frames) || 0, left?.length ?? 0, right?.length ?? 0);
      if (count <= 0) return false;
      for (const slot of this.slots) slot.process(left, right, count);
      return true;
    }
    diagnostics() {
      return Object.freeze({
        slotCount: SLOT_COUNT,
        slots: Object.freeze(this.slots.map((slot) => slot.diagnostics())),
      });
    }
  }

  const api = Object.freeze({
    SLOT_COUNT,
    VALUE_COUNT,
    SWITCH_FADE_SECONDS,
    DELAY_SIZE,
    MAPPING,
    MODULES,
    descriptor,
    clampValue,
    mapValue,
    defaultValues,
    normalizeValues,
    normalizeSlot,
    normalizeChain,
    normalizeTracks,
    describeValue,
    TrackInsertChain,
    createChain: (sampleRate) => new TrackInsertChain(sampleRate),
  });

  globalThis.BRKTRKTrackInsertFxDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
