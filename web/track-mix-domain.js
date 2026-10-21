(() => {
  const storeTypes = globalThis.BRKTRKStoreTypes
    ?? (typeof require === "function" ? require("./stores.js") : null);
  if (!storeTypes) throw new Error("Track mix domain requires Store types");

  const DEFAULT_TRACK_MIX = Object.freeze({ gain: 1, mute: false, pan: 0 });
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function normalizeTrackMix(value = {}, fallback = DEFAULT_TRACK_MIX) {
    const source = value && typeof value === "object" ? value : {};
    const base = fallback && typeof fallback === "object" ? fallback : DEFAULT_TRACK_MIX;
    const gainCandidate = Number(source.gain);
    const panCandidate = Number(source.pan);
    const fallbackGain = Number(base.gain);
    const fallbackPan = Number(base.pan);
    return Object.freeze({
      gain: Number.isFinite(gainCandidate)
        ? clamp(gainCandidate, 0, 1)
        : Number.isFinite(fallbackGain)
          ? clamp(fallbackGain, 0, 1)
          : DEFAULT_TRACK_MIX.gain,
      mute: Object.hasOwn(source, "mute") ? source.mute === true : base.mute === true,
      pan: Number.isFinite(panCandidate)
        ? clamp(panCandidate, -1, 1)
        : Number.isFinite(fallbackPan)
          ? clamp(fallbackPan, -1, 1)
          : DEFAULT_TRACK_MIX.pan,
    });
  }

  function mixesEqual(left, right) {
    return left.gain === right.gain && left.mute === right.mute && left.pan === right.pan;
  }

  function normalizeProjectTracks(projectStore, trackCount = 8) {
    const project = projectStore.getState();
    if (!Array.isArray(project.tracks)) project.tracks = [];
    for (let track = 0; track < trackCount; track += 1) {
      const current = project.tracks[track] && typeof project.tracks[track] === "object"
        ? project.tracks[track]
        : { id: track };
      project.tracks[track] = {
        ...current,
        id: Number.isInteger(current.id) ? current.id : track,
        mix: normalizeTrackMix(current.mix),
      };
    }
    return project.tracks;
  }

  function continuousTransaction(metadata = {}) {
    if (metadata.transaction && typeof metadata.transaction === "object") return metadata.transaction;
    return globalThis.BRKTRKInputSafety?.currentContinuousTransaction?.("mixer") ?? null;
  }

  function install(projectStore, options = {}) {
    if (!projectStore?.getState || !projectStore?.publish) {
      throw new TypeError("Track mix domain requires a ProjectStore");
    }
    if (projectStore.trackMixDomain?.installed) return projectStore.trackMixDomain;

    const trackCount = Number.isInteger(options.trackCount) ? Math.max(1, options.trackCount) : 8;
    normalizeProjectTracks(projectStore, trackCount);

    function snapshot() {
      const tracks = normalizeProjectTracks(projectStore, trackCount);
      return Object.freeze(tracks.slice(0, trackCount).map((track) => normalizeTrackMix(track.mix)));
    }

    function get(track) {
      if (!Number.isInteger(track) || track < 0 || track >= trackCount) {
        throw new RangeError(`Track mix index out of range: ${track}`);
      }
      return snapshot()[track];
    }

    function set(track, patch, metadata = {}) {
      if (!Number.isInteger(track) || track < 0 || track >= trackCount) {
        throw new RangeError(`Track mix index out of range: ${track}`);
      }
      if (!patch || typeof patch !== "object") throw new TypeError("Track mix patch must be an object");

      const project = projectStore.getState();
      normalizeProjectTracks(projectStore, trackCount);
      const before = normalizeTrackMix(project.tracks[track].mix);
      const after = normalizeTrackMix({ ...before, ...patch }, before);
      const transaction = continuousTransaction(metadata);
      const changeSet = storeTypes.createProjectChangeSet({
        subtype: "track.mix",
        target: `project.tracks.${track}.mix`,
        path: ["tracks", track, "mix"],
        before,
        after,
        affectsPlayback: false,
        persistsProject: true,
        renderTargets: [`track.mix.${track}`],
        source: metadata.source,
        transaction: {
          ...(transaction && typeof transaction === "object" ? transaction : {}),
          track,
          field: typeof metadata.field === "string" ? metadata.field : null,
        },
      });

      if (mixesEqual(before, after)) {
        return { value: after, before, after, track, mutated: false, changeSet, metadata: clone(metadata) };
      }

      project.tracks[track] = {
        ...project.tracks[track],
        id: Number.isInteger(project.tracks[track].id) ? project.tracks[track].id : track,
        mix: after,
      };
      // Track Mix is a dedicated non-structural path. Broad `project`/`render`
      // channels are intentionally excluded so legacy compatibility subscribers
      // cannot rebuild playback or repaint the Mixer during a trusted drag.
      projectStore.publish(changeSet, ["persistence", "track-mix"]);
      return { value: after, before, after, track, mutated: true, changeSet, metadata: clone(metadata) };
    }

    const domain = Object.freeze({
      installed: true,
      trackCount,
      snapshot,
      get,
      set,
      normalize: normalizeTrackMix,
    });
    projectStore.trackMixDomain = domain;
    projectStore.getTrackMix = get;
    projectStore.setTrackMix = set;
    return domain;
  }

  const api = Object.freeze({
    DEFAULT_TRACK_MIX,
    normalizeTrackMix,
    normalizeProjectTracks,
    install,
  });

  globalThis.BRKTRKTrackMixDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (globalThis.BRKTRKStores?.project) {
    globalThis.BRKTRKTrackMix = install(globalThis.BRKTRKStores.project, {
      trackCount: typeof TRACKS !== "undefined" ? TRACKS : 8,
    });
  }
})();
