(() => {
  "use strict";

  function exactStateEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (left == null || right == null) return false;
    if (typeof left !== "object" || typeof right !== "object") return false;
    const leftArray = Array.isArray(left);
    const rightArray = Array.isArray(right);
    if (leftArray !== rightArray) return false;
    if (leftArray) {
      if (left.length !== right.length) return false;
      for (let index = 0; index < left.length; index += 1) {
        if (!exactStateEqual(left[index], right[index])) return false;
      }
      return true;
    }
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    for (let index = 0; index < leftKeys.length; index += 1) {
      const key = leftKeys[index];
      if (key !== rightKeys[index] || !exactStateEqual(left[key], right[key])) return false;
    }
    return true;
  }

  function factoryPresetExact({ instrument, preset, selectedPresetId = null } = {}) {
    if (!preset?.applicable || String(selectedPresetId ?? "") !== String(preset.id ?? "")) return false;
    return exactStateEqual(instrument?.patchState, preset.patchState)
      && exactStateEqual(instrument?.parameterSnapshot, preset.parameterSnapshot);
  }

  function availability({ slot, instrument, preset, view } = {}) {
    const bridge = globalThis.BRKTRKProductionEngineStoreSync;
    if (!bridge?.preparedPresetAvailability) {
      return Object.freeze({ eligible: false, code: "prepared-support-unavailable", reason: "Prepared Instrument runtime is not ready" });
    }
    return bridge.preparedPresetAvailability({ instrumentId: Number(slot), instrument, preset, packageView: view });
  }

  function applicationStatus(slot) {
    return globalThis.BRKTRKStores?.transport?.preparedInstrumentState?.get?.(Number(slot)) ?? null;
  }

  function presentation({ playing, instrument, preset, selectedPresetId = null, availability: liveAvailability = null, application = null } = {}) {
    if (!preset?.applicable) {
      const reason = preset?.unavailableReason === "parameter-snapshot-incomplete"
        ? `PACKAGE PRESET METADATA INCOMPLETE · ${preset.missingParameters?.length ?? 0} PARAMS MISSING`
        : preset?.unavailableReason === "engine-version-mismatch"
          ? "USER PRESET REQUIRES ITS SAVED ENGINE PACKAGE"
          : "PACKAGE PRESET METADATA DOES NOT INCLUDE HOST PARAMETER SNAPSHOT";
      return Object.freeze({ disabled: true, text: reason, error: false, live: false });
    }

    const selectedCurrent = String(selectedPresetId ?? "") === String(preset.id ?? "");
    const exactCurrent = selectedCurrent && factoryPresetExact({ instrument, preset, selectedPresetId });
    const currentLabel = preset.readOnly === true ? "CURRENT FACTORY PRESET" : "CURRENT USER PRESET";
    const currentTruth = exactCurrent ? currentLabel : "MODIFIED";

    if (playing) {
      if (!liveAvailability?.eligible) {
        const blockedCode = liveAvailability?.code ?? null;
        const blockedReason = liveAvailability?.reason ?? null;
        if (selectedCurrent && !exactCurrent) {
          return Object.freeze({ disabled: true, text: "MODIFIED · STOP PLAYBACK TO APPLY PRESET", error: false, live: false, blockedCode, blockedReason });
        }
        return Object.freeze({ disabled: true, text: "STOP PLAYBACK TO APPLY PRESET", error: false, live: false, blockedCode, blockedReason });
      }
      const matchesApplication = application
        && String(application.desiredPresetId ?? "") === String(preset.id ?? "");
      if (matchesApplication) {
        if (application.state === "requested" || application.state === "queued") {
          return Object.freeze({ disabled: true, text: "PRESET QUEUED · SAFE BLOCK PENDING", error: false, live: true });
        }
        if (application.state === "applying") {
          return Object.freeze({ disabled: true, text: "APPLYING PRESET AT SAFE BLOCK…", error: false, live: true });
        }
        if (application.state === "failed") {
          const detail = application.code || application.reason || "prepared-state-failed";
          return Object.freeze({ disabled: true, text: `STOP PLAYBACK TO RECOVER PRESET · ${detail}`, error: true, live: true });
        }
        if (application.state === "applied") {
          if (selectedCurrent && !exactCurrent) {
            return Object.freeze({ disabled: false, text: "MODIFIED", error: false, live: true });
          }
          return Object.freeze({ disabled: false, text: "PRESET APPLIED LIVE", error: false, live: true });
        }
      }
      if (selectedCurrent) {
        return Object.freeze({ disabled: false, text: currentTruth, error: false, live: true });
      }
      return Object.freeze({ disabled: false, text: "LIVE PRESET READY · SAFE BLOCK", error: false, live: true });
    }

    if (selectedCurrent) {
      return Object.freeze({ disabled: false, text: currentTruth, error: false, live: false });
    }
    return Object.freeze({ disabled: false, text: preset.readOnly ? "READ-ONLY FACTORY PRESET" : "PRESET READY", error: false, live: false });
  }

  function context({ slot, instrument, preset, view, selectedPresetId = null, playing = null } = {}) {
    const isPlaying = playing == null
      ? globalThis.BRKTRKStores?.transport?.runtime?.snapshot?.()?.playing === true
      : playing === true;
    const liveAvailability = isPlaying ? availability({ slot, instrument, preset, view }) : null;
    const application = isPlaying ? applicationStatus(slot) : null;
    return Object.freeze({
      playing: isPlaying,
      availability: liveAvailability,
      application,
      presentation: presentation({ playing: isPlaying, instrument, preset, selectedPresetId, availability: liveAvailability, application }),
    });
  }

  const api = Object.freeze({ exactStateEqual, factoryPresetExact, availability, applicationStatus, presentation, context });
  globalThis.BRKTRKSoundPresetLivePreparedPolicy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
