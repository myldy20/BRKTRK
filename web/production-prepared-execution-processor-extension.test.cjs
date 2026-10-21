const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
require("./timing-domain.js");
require("./phrase-fx-domain.js");
require("./phrase-fx-runtime-domain.js");
const eventTraceDomain = require("./event-trace-domain.js");
require("./production-timeline-domain.js");
const executionDomain = require("./production-execution-template.js");
const queueDomain = require("./realtime-execution-queue.js");
const source = readFileSync(require.resolve("./production-prepared-execution-processor-extension.js"), "utf8");

const tempo120 = Object.freeze({ numerator: 120n, denominator: 1n });
const tempo90 = Object.freeze({ numerator: 90n, denominator: 1n });
const timelineTemplate = (tempo = tempo120) => Object.freeze({ timelineVersion: 1, mode: "sequence", sampleRate: 48000, tempo });
const executionTemplate = (rows = 2, tempo = tempo120) => Object.freeze({
  executionVersion: 1,
  timelineVersion: 1,
  mode: "sequence",
  sampleRate: 48000,
  tempo,
  recordCount: 0,
  sequenceRows: Object.freeze(Array.from({ length: rows }, () => Object.freeze([]))),
  tracks: Object.freeze([]),
});

class BaseProcessor {
  constructor() {
    this.playing = false;
    this.mode = "sequence";
    this.tempo = 120;
    this.timelineRebuildPending = false;
    this.transportIdentity = null;
    this.sequence = [];
    this.voices = Array.from({ length: 8 }, () => ({}));
    this.preparedTimelineTemplate = timelineTemplate();
    this.realtimeWindow = { budgetSnapshot: () => Object.freeze({ eventCapacity: 64 }) };
    const messages = [];
    this.port = {
      messages,
      postMessage(message) { messages.push(message); },
      onmessage: ({ data }) => {
        if (data.type === "play") this.startSequence(data.sequence, data.tempo, data.transport);
        else if (data.type === "update-sequence") this.updateSequence(data.sequence, data.transport);
        else if (data.type === "tempo") this.setTempo(data.value);
        else if (data.type === "stop") this.stop(data.transport);
      },
    };
  }
  timelineProgramSnapshot() { return { mode: "sequence", steps: this.sequence }; }
  startSequence(sequence, tempo, transport) {
    this.sequence = sequence;
    this.tempo = Number(tempo);
    this.transportIdentity = transport;
    this.playing = sequence.length > 0;
  }
  updateSequence(sequence, transport) {
    this.sequence = sequence;
    this.transportIdentity = transport;
    this.timelineRebuildPending = this.playing;
  }
  setTempo(value) {
    const next = Number(value);
    if (next === this.tempo) return;
    this.tempo = next;
    this.timelineRebuildPending = this.playing;
  }
  stop() {
    this.playing = false;
    this.transportIdentity = null;
    this.timelineRebuildPending = false;
  }
}

const sandbox = {
  BRKTRKProductionAudioProcessorExtension: Object.freeze({ extendProcessor: (Candidate) => Candidate }),
  BRKTRKProductionExecutionTemplate: executionDomain,
  BRKTRKRealtimeExecutionQueue: queueDomain,
  BRKTRKEventTraceDomain: eventTraceDomain,
  console,
  Object,
  Array,
  Number,
  Set,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox, { filename: "production-prepared-execution-processor-extension.js" });
const Processor = sandbox.BRKTRKProductionAudioProcessorExtension.extendProcessor(BaseProcessor);
const processor = new Processor();

const steps = [{ notes: [60] }, { notes: [null] }];
const id1 = { id: "r2-1", version: 1, mode: "sequence", scope: "phrase" };
processor.port.onmessage({ data: {
  type: "play",
  sequence: steps,
  tempo: 120,
  transport: id1,
  timelineTemplate: timelineTemplate(),
  executionTemplate: executionTemplate(),
} });
assert.equal(processor.playing, true);
assert.equal(processor.transportIdentity, id1);
assert.equal(processor.preparedExecutionTemplate.executionVersion, 1);

const beforeSequence = processor.sequence;
const beforeIdentity = processor.transportIdentity;
const rejectionCount = processor.port.messages.length;
processor.port.onmessage({ data: {
  type: "update-sequence",
  sequence: [{ notes: [72] }, { notes: [null] }],
  transport: { id: "bad-version", version: 2, mode: "sequence", scope: "phrase" },
  timelineTemplate: timelineTemplate(),
  executionTemplate: { executionVersion: 999 },
} });
assert.equal(processor.sequence, beforeSequence);
assert.equal(processor.transportIdentity, beforeIdentity);
assert.equal(processor.playing, true);
assert.equal(processor.port.messages.length, rejectionCount + 1);
assert.equal(processor.port.messages.at(-1).code, "invalid-prepared-execution");

processor.port.onmessage({ data: {
  type: "update-sequence",
  sequence: [{ notes: [72] }, { notes: [null] }, { notes: [74] }],
  transport: { id: "bad-topology", version: 3, mode: "sequence", scope: "phrase" },
  timelineTemplate: timelineTemplate(),
  executionTemplate: executionTemplate(2),
} });
assert.equal(processor.sequence, beforeSequence, "row-topology mismatch must reject before program mutation");
assert.equal(processor.transportIdentity, beforeIdentity);
assert.match(processor.port.messages.at(-1).message, /row count/);

processor.port.onmessage({ data: {
  type: "tempo",
  value: 90,
  timelineTemplate: timelineTemplate(tempo90),
  executionTemplate: executionTemplate(2, tempo90),
} });
assert.equal(processor.tempo, 90);
assert.equal(processor.timelineRebuildPending, true);
assert.equal(processor.preparedExecutionTemplate.tempo.numerator, 90n);

const beforeTempo = processor.tempo;
processor.port.onmessage({ data: {
  type: "tempo",
  value: 60,
  timelineTemplate: timelineTemplate(Object.freeze({ numerator: 60n, denominator: 1n })),
  executionTemplate: executionTemplate(2, tempo90),
} });
assert.equal(processor.tempo, beforeTempo, "execution/timeline tempo mismatch must reject before Tempo mutation");
assert.equal(processor.transportIdentity, beforeIdentity);
assert.equal(processor.playing, true);
assert.match(processor.port.messages.at(-1).message, /tempo/);

console.log("K3 R2 prepared execution pre-mutation validation tests passed");
