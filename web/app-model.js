const EMPTY = -1;
const NOTE_OFF = -2;
const TRACKS = 8;
const SONG_ROWS = 64;
const CHAIN_ROWS = 16;
const PHRASE_ROWS = 16;
const STORAGE_KEY = "brktrk-web-v2-alpha-1";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const hex = (value) => Math.max(0, Number(value) || 0).toString(16).toUpperCase().padStart(2, "0");
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const emptyFxSlot = () => ({ command: 0, value: 0 });
const emptyPhraseStep = () => ({
  note: EMPTY,
  velocity: 100,
  instrument: EMPTY,
  fx: Array.from({ length: 3 }, emptyFxSlot),
  condition: { probability: 100, every: 1, offset: 0 },
  parameterEvents: [],
});
const emptyChainStep = () => ({ phrase: EMPTY, transpose: 0 });
const emptyTrack = (id) => ({ id, mix: { gain: 1, mute: false, pan: 0 } });

function fxCommandCode(slot) {
  if (typeof slot === "number") return clamp(Math.round(slot), 0, 255);
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) return 0;
  const raw = Object.hasOwn(slot, "command") ? slot.command : slot.commandCode;
  return clamp(Number.isFinite(Number(raw)) ? Math.round(Number(raw)) : 0, 0, 255);
}

function fxValueByte(slot) {
  if (typeof slot === "number" || !slot || typeof slot !== "object" || Array.isArray(slot)) return 0;
  const command = fxCommandCode(slot);
  if (command === 0) return 0;
  return clamp(Number.isFinite(Number(slot.value)) ? Math.round(Number(slot.value)) : 0, 0, 255);
}

function makeInitialModel() {
  const model = {
    schemaVersion: 5,
    sourceFormat: "brktrk",
    projectName: "UNTITLED 01",
    tempo: 120,
    tracks: Array.from({ length: TRACKS }, (_, id) => emptyTrack(id)),
    song: Array.from({ length: SONG_ROWS }, () => Array(TRACKS).fill(EMPTY)),
    chains: {},
    phrases: {},
    instrumentPool: {},
  };

  const previewPhrase = Array.from({ length: PHRASE_ROWS }, emptyPhraseStep);
  previewPhrase[0] = { ...emptyPhraseStep(), note: 48, velocity: 58 };
  previewPhrase[4] = { ...emptyPhraseStep(), note: NOTE_OFF, velocity: 58 };
  previewPhrase[8] = { ...emptyPhraseStep(), note: 55, velocity: 52 };
  previewPhrase[12] = { ...emptyPhraseStep(), note: NOTE_OFF, velocity: 52 };
  model.phrases[0] = previewPhrase;

  const previewChain = Array.from({ length: CHAIN_ROWS }, emptyChainStep);
  previewChain[0] = { phrase: 0, transpose: 0 };
  model.chains[0] = previewChain;
  model.song[0][0] = 0;
  return model;
}

function restoreModel() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || !Array.isArray(saved.song) || !saved.chains || !saved.phrases) return makeInitialModel();
    const base = makeInitialModel();
    return {
      ...base,
      ...saved,
      tracks: Array.from({ length: TRACKS }, (_, id) => ({ ...emptyTrack(id), ...(saved.tracks?.[id] ?? {}), id })),
      instrumentPool: saved.instrumentPool && typeof saved.instrumentPool === "object" && !Array.isArray(saved.instrumentPool)
        ? saved.instrumentPool
        : {},
    };
  } catch (error) {
    console.warn("Could not restore BRKTRK web state", error);
    return makeInitialModel();
  }
}

const model = restoreModel();
const state = {
  view: "phrase",
  dock: "none",
  scope: "phrase",
  live: false,
  playing: false,
  songRow: 0,
  track: 0,
  chain: Math.max(0, model.song[0][0]),
  chainRow: 0,
  phrase: 0,
  phraseRow: 0,
  instrument: 0,
  focus: { pane: "phrase", row: 0, col: 0 },
  lastChain: 0,
  lastPhrase: 0,
  lastEditTapAt: 0,
  lastEditCell: "",
  playhead: { step: -1, songRow: -1, chainRow: -1, phraseRow: -1 },
  currentSequence: null,
};

function chain(id, create = true) {
  if (!Object.hasOwn(model.chains, id) && create) {
    model.chains[id] = Array.from({ length: CHAIN_ROWS }, emptyChainStep);
  }
  return model.chains[id];
}

function phrase(id, create = true) {
  if (!Object.hasOwn(model.phrases, id) && create) {
    model.phrases[id] = Array.from({ length: PHRASE_ROWS }, emptyPhraseStep);
  }
  return model.phrases[id];
}

function firstUnused(collection, limit = 256) {
  for (let id = 0; id < limit; id += 1) {
    if (!Object.hasOwn(collection, id)) return id;
    const values = collection[id];
    const empty = values.every((entry) => {
      if (Object.hasOwn(entry, "phrase")) return entry.phrase < 0 && entry.transpose === 0;
      const condition = entry.condition ?? { probability: 100, every: 1, offset: 0 };
      const defaultCondition = Number(condition.probability ?? 100) === 100
        && Number(condition.every ?? 1) === 1
        && Number(condition.offset ?? 0) === 0;
      const noParameterEvents = !Array.isArray(entry.parameterEvents) || entry.parameterEvents.length === 0;
      return entry.note < 0
        && entry.instrument < 0
        && entry.fx.every((slot) => fxCommandCode(slot) === 0 && fxValueByte(slot) === 0)
        && defaultCondition
        && noParameterEvents;
    });
    if (empty) return id;
  }
  return 0;
}

let saveTimer = 0;
function persist() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    if (globalThis.BRKTRKBrowserWriterAuthority && !globalThis.BRKTRKBrowserWriterAuthority.canWrite()) return;
    const storage = globalThis.BRKTRKProjectStorage;
    if (storage?.writeCanonical) storage.writeCanonical(localStorage, model);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(model));
  }, 180);
}

function noteName(note) {
  if (note === NOTE_OFF) return "OFF";
  if (note < 0) return "---";
  const names = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];
  return `${names[note % 12]}${Math.floor(note / 12) - 1}`;
}

function fxName(slot) {
  const command = fxCommandCode(slot);
  const labels = { 0: "---", 1: "CUT", 4: "DLY", 5: "RET" };
  return labels[command] ?? `?${hex(command)}`;
}

function instrumentReferencePresentation(instrumentId, pool = model.instrumentPool) {
  const id = Number(instrumentId);
  if (!Number.isInteger(id) || id < 0) {
    return { state: "empty", text: "--", title: "Instrument unassigned" };
  }
  if (pool && typeof pool === "object" && Object.hasOwn(pool, id)) {
    return { state: "resolved", text: hex(id), title: `Instrument ${hex(id)}` };
  }
  return { state: "unresolved", text: `?${hex(id)}`, title: `Unresolved Instrument ${hex(id)} — preserved from Project` };
}

class BrowserAudio {
  constructor() {
    this.context = null;
    this.node = null;
    this.ready = false;
    this.onStep = () => {};
    this.onMeter = () => {};
    // Stop is a separate lifecycle signal: onStep may be reassigned by
    // transport/playhead owners and must not own unrelated output UI cleanup.
    this.onStop = () => {};
    this.onProcessorError = () => {};
  }

  async init() {
    if (this.ready) {
      if (this.context.state !== "running") await this.context.resume();
      return;
    }
    this.context = new AudioContext({ latencyHint: "interactive" });
    await this.context.audioWorklet.addModule("./audio-worklet.js");
    this.node = new AudioWorkletNode(this.context, "brktrk-audio", { outputChannelCount: [2] });
    // Bind before connect/resume: process() may throw during the first readiness proof.
    this.node.addEventListener?.("processorerror", (event) => this.onProcessorError(event));
    // The host must see a one-shot crash during the first resume/render-clock proof.
    globalThis.BRKTRKProductionEngineHost?.observeNodeFailures?.(this.node, this.context);
    this.node.connect(this.context.destination);
    this.node.port.onmessage = ({ data }) => {
      if (data.type === "step") this.onStep(data.index);
      if (data.type === "meter") this.onMeter(data.left, data.right);
      if (data.type === "stopped") {
        this.onStep(-1);
        this.onStop();
      }
    };
    await this.context.resume();
    this.ready = true;
  }

  play(sequence, tempo) {
    if (!this.ready) return;
    this.node.port.postMessage({ type: "play", sequence, tempo });
  }

  stop() {
    if (!this.ready) return;
    this.node.port.postMessage({ type: "stop" });
  }

  tempo(value) {
    if (!this.ready) return;
    this.node.port.postMessage({ type: "tempo", value });
  }
}

const audio = new BrowserAudio();

function stepEvent() {
  return {
    notes: Array(TRACKS).fill(null),
    velocities: Array(TRACKS).fill(100),
    instrumentIds: Array(TRACKS).fill(EMPTY),
    fx: Array.from({ length: TRACKS }, () => Array.from({ length: 3 }, emptyFxSlot)),
  };
}

function phraseEvents(phraseId, track, transpose = 0) {
  const result = [];
  const source = phrase(phraseId, false) ?? Array.from({ length: PHRASE_ROWS }, emptyPhraseStep);
  for (let row = 0; row < PHRASE_ROWS; row += 1) {
    const event = stepEvent();
    const current = source[row] ?? emptyPhraseStep();
    if (current.note === NOTE_OFF) event.notes[track] = NOTE_OFF;
    else if (current.note >= 0) event.notes[track] = clamp(current.note + transpose, 0, 127);
    const instrumentId = Number(current.instrument);
    event.velocities[track] = clamp(Number(current.velocity) || 100, 1, 127);
    event.instrumentIds[track] = Number.isInteger(instrumentId) && instrumentId >= 0 && instrumentId <= 255 ? instrumentId : EMPTY;
    event.fx[track] = Array.from({ length: 3 }, (_, slot) => ({ ...emptyFxSlot(), ...(current.fx?.[slot] ?? {}) }));
    result.push(event);
  }
  return result;
}

function mergeTrackEvent(target, source, track) {
  target.notes[track] = source.notes[track];
  target.velocities[track] = source.velocities[track];
  target.instrumentIds[track] = source.instrumentIds[track];
  target.fx[track] = source.fx[track];
}

function chainLength(chainId, fromRow = 0) {
  const source = chain(chainId, false);
  if (!source) return 0;
  let count = 0;
  for (let row = fromRow; row < CHAIN_ROWS; row += 1) {
    if ((source[row]?.phrase ?? EMPTY) < 0) break;
    count += 1;
  }
  return count;
}

function buildPhraseSequence() {
  const steps = phraseEvents(state.phrase, state.track);
  return {
    steps,
    scope: "phrase",
    segments: [{ start: 0, end: steps.length, songRow: state.songRow, chainRow: state.chainRow }],
  };
}

function buildChainSequence() {
  const source = chain(state.chain, false) ?? [];
  let startRow = state.chainRow;
  if ((source[startRow]?.phrase ?? EMPTY) < 0) startRow = source.findIndex((entry) => entry.phrase >= 0);
  if (startRow < 0) return buildPhraseSequence();
  const steps = [];
  const segments = [];
  for (let row = startRow; row < CHAIN_ROWS; row += 1) {
    const entry = source[row];
    if (!entry || entry.phrase < 0) break;
    const start = steps.length;
    steps.push(...phraseEvents(entry.phrase, state.track, entry.transpose));
    segments.push({ start, end: steps.length, songRow: state.songRow, chainRow: row, phrase: entry.phrase });
  }
  return { steps, scope: "chain", segments, startChainRow: startRow };
}

function buildSongSequence() {
  const steps = [];
  const segments = [];
  for (let songRow = state.songRow; songRow < SONG_ROWS; songRow += 1) {
    const row = model.song[songRow];
    if (row.every((chainId) => chainId < 0)) break;
    const lengths = row.map((chainId) => (chainId < 0 ? 0 : chainLength(chainId, 0)));
    const rowSteps = Math.max(1, ...lengths) * PHRASE_ROWS;
    const start = steps.length;
    for (let localStep = 0; localStep < rowSteps; localStep += 1) {
      const event = stepEvent();
      for (let track = 0; track < TRACKS; track += 1) {
        const chainId = row[track];
        if (chainId < 0) {
          if (localStep === 0) event.notes[track] = NOTE_OFF;
          continue;
        }
        const chainRow = Math.floor(localStep / PHRASE_ROWS);
        const phraseRow = localStep % PHRASE_ROWS;
        const chainEntry = chain(chainId, false)?.[chainRow];
        if (!chainEntry || chainEntry.phrase < 0) {
          if (phraseRow === 0) event.notes[track] = NOTE_OFF;
          continue;
        }
        const sourceEvent = phraseEvents(chainEntry.phrase, track, chainEntry.transpose)[phraseRow];
        mergeTrackEvent(event, sourceEvent, track);
      }
      steps.push(event);
    }
    segments.push({ start, end: steps.length, songRow });
  }
  if (steps.length === 0) return buildChainSequence();
  return { steps, scope: "song", segments };
}

function buildSequence(scope = state.scope) {
  if (scope === "phrase") return buildPhraseSequence();
  if (scope === "chain") return buildChainSequence();
  return buildSongSequence();
}

function locatePlayhead(index) {
  const sequence = state.currentSequence;
  if (!sequence || index < 0) return { step: -1, songRow: -1, chainRow: -1, phraseRow: -1 };
  const segment = sequence.segments.find((item) => index >= item.start && index < item.end) ?? sequence.segments.at(-1);
  const local = index - (segment?.start ?? 0);
  if (sequence.scope === "song") {
    return { step: index, songRow: segment.songRow, chainRow: Math.floor(local / PHRASE_ROWS), phraseRow: local % PHRASE_ROWS };
  }
  if (sequence.scope === "chain") {
    return { step: index, songRow: state.songRow, chainRow: segment.chainRow, phraseRow: local % PHRASE_ROWS };
  }
  return { step: index, songRow: state.songRow, chainRow: state.chainRow, phraseRow: local % PHRASE_ROWS };
}

function setStatus(message, tone = "green") {
  const status = $("#statusLine");
  status.textContent = message;
  status.style.color = `var(--${tone})`;
}

async function togglePlayback(forceSong = false) {
  await audio.init();
  if (state.playing) {
    stopPlayback();
    return;
  }
  const scope = forceSong ? "song" : state.scope;
  const sequence = buildSequence(scope);
  if (!sequence.steps.length) {
    setStatus("NOTHING TO PLAY", "amber");
    return;
  }
  state.currentSequence = sequence;
  state.playing = true;
  $("#playButton").setAttribute("aria-pressed", "true");
  audio.play(sequence.steps, model.tempo);
  setStatus(`PLAY ${scope.toUpperCase()} · PRODUCTION AUDIO`);
}
