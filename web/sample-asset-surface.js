(() => {
  "use strict";

  const domain = globalThis.BRKTRKSampleAssetDomain
    ?? (typeof require !== "undefined" ? require("./sample-asset-domain.js") : null);
  const storeApi = globalThis.BRKTRKSampleAssetStore
    ?? (typeof require !== "undefined" ? require("./sample-asset-store.js") : null);
  if (!domain || !storeApi) throw new Error("BRKTRK sample asset surface requires sample asset domain + store");

  let storeInstance = null;

  function supportsView(view) {
    return Number(view?.manifest?.runtime?.assetExtensionVersion ?? 0) > 0;
  }

  function defaultStore() {
    if (storeInstance) return storeInstance;
    if (!globalThis.indexedDB) throw new Error("Sample storage is unavailable in this browser");
    storeInstance = storeApi.createIndexedDbStore();
    return storeInstance;
  }

  function metadata(ref) {
    if (!ref) return Object.freeze({
      sourceName: null,
      sampleRateHz: null,
      channelCount: null,
      frameCount: null,
      byteSize: null,
      durationSeconds: null,
      sha256: null,
    });
    const sampleRateHz = Number(ref.sampleRateHz);
    const frameCount = Number(ref.frameCount);
    return Object.freeze({
      sourceName: ref.sourceName == null ? null : String(ref.sourceName),
      sampleRateHz,
      channelCount: Number(ref.channelCount),
      frameCount,
      byteSize: Number(ref.byteSize),
      durationSeconds: Number.isFinite(sampleRateHz) && sampleRateHz > 0 && Number.isFinite(frameCount)
        ? frameCount / sampleRateHz
        : null,
      sha256: String(ref.sha256 ?? ""),
    });
  }

  function metadataText(ref) {
    const info = metadata(ref);
    if (!info.sha256) return "NO SAMPLE LOADED";
    const channels = info.channelCount === 1 ? "MONO" : info.channelCount === 2 ? "STEREO" : `${info.channelCount}CH`;
    const seconds = Number.isFinite(info.durationSeconds)
      ? (info.durationSeconds < 1 ? `${Math.round(info.durationSeconds * 1000)} ms` : `${info.durationSeconds.toFixed(2)} s`)
      : "?";
    const rate = Number.isFinite(info.sampleRateHz) ? `${Math.round(info.sampleRateHz / 100) / 10} kHz` : "?";
    return `${channels} · ${rate} · ${seconds} · ${info.frameCount} frames`;
  }

  async function importFile(slot, file, options = {}) {
    if (!file || typeof file.arrayBuffer !== "function") throw new TypeError("A WAV file is required");
    const projectStore = options.projectStore ?? globalThis.BRKTRKStores?.project;
    if (!projectStore?.setProductionInstrumentAssetRef) {
      throw new Error("ProjectStore sample asset mutation is unavailable");
    }
    const store = options.store ?? defaultStore();
    const sourceName = String(file.name ?? "sample.wav");
    const bytes = await file.arrayBuffer();
    const imported = await domain.importWav(bytes, { sourceName });
    const stored = await store.put(imported.ref, imported.pcmBytes);
    try {
      const mutation = projectStore.setProductionInstrumentAssetRef(slot, imported.ref, {
        source: options.source ?? "sound.sample.import",
      });
      return Object.freeze({
        ref: imported.ref,
        inserted: stored.inserted === true,
        mutation,
      });
    } catch (error) {
      if (stored.inserted === true) {
        try { await store.delete(imported.ref.sha256); } catch {}
      }
      throw error;
    }
  }

  function clearAsset(slot, options = {}) {
    const projectStore = options.projectStore ?? globalThis.BRKTRKStores?.project;
    if (!projectStore?.setProductionInstrumentAssetRef) {
      throw new Error("ProjectStore sample asset mutation is unavailable");
    }
    return projectStore.setProductionInstrumentAssetRef(slot, null, {
      source: options.source ?? "sound.sample.clear",
    });
  }

  function ensureStyle() {
    if (typeof document === "undefined" || document.querySelector("#brktrk-sample-asset-surface-style")) return;
    const style = document.createElement("style");
    style.id = "brktrk-sample-asset-surface-style";
    style.textContent = `
      .brktrk-sample-asset-panel{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 12px;align-items:center;padding:10px;border:1px solid var(--line,#343944);border-radius:8px;background:rgba(255,255,255,.025)}
      .brktrk-sample-asset-copy{min-width:0;display:grid;gap:3px}
      .brktrk-sample-asset-title{font-size:9px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;opacity:.72}
      .brktrk-sample-asset-name{font-size:13px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .brktrk-sample-asset-meta,.brktrk-sample-asset-status{font-size:10px;opacity:.72;overflow-wrap:anywhere}
      .brktrk-sample-asset-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
      .brktrk-sample-asset-actions button{min-height:34px;font:inherit}
      .brktrk-sample-asset-status[data-error=true]{color:var(--danger,#ff6874);opacity:1}
      @media (max-width:640px){.brktrk-sample-asset-panel{grid-template-columns:1fr}.brktrk-sample-asset-actions{justify-content:flex-start}.brktrk-sample-asset-actions button{min-height:44px}}
    `;
    document.head.append(style);
  }

  function renderPanel({ slot, instrument, view, rerender } = {}) {
    if (typeof document === "undefined" || !supportsView(view)) return null;
    ensureStyle();
    const panel = document.createElement("section");
    panel.className = "brktrk-sample-asset-panel";
    panel.dataset.sampleAssetSurface = "v1";

    const copy = document.createElement("div");
    copy.className = "brktrk-sample-asset-copy";
    const title = document.createElement("div");
    title.className = "brktrk-sample-asset-title";
    title.textContent = "SAMPLE";
    const name = document.createElement("div");
    name.className = "brktrk-sample-asset-name";
    name.textContent = instrument?.assetRef?.sourceName || "No sample loaded";
    const meta = document.createElement("div");
    meta.className = "brktrk-sample-asset-meta";
    meta.textContent = metadataText(instrument?.assetRef ?? null);
    meta.title = instrument?.assetRef?.sha256 ? `SHA-256 ${instrument.assetRef.sha256}` : "";
    const status = document.createElement("div");
    status.className = "brktrk-sample-asset-status";
    status.setAttribute("role", "status");
    copy.append(title, name, meta, status);

    const actions = document.createElement("div");
    actions.className = "brktrk-sample-asset-actions";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".wav,audio/wav,audio/x-wav,audio/wave";
    input.hidden = true;
    input.setAttribute("aria-label", "Load WAV sample");

    const load = document.createElement("button");
    load.type = "button";
    load.textContent = instrument?.assetRef ? "REPLACE WAV" : "LOAD WAV";
    load.addEventListener("click", () => input.click());

    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "CLEAR";
    clear.disabled = !instrument?.assetRef;
    clear.addEventListener("click", () => {
      try {
        clearAsset(slot);
        status.textContent = "SAMPLE CLEARED";
        rerender?.();
      } catch (error) {
        status.dataset.error = "true";
        status.textContent = `CLEAR FAILED · ${String(error?.message ?? error)}`;
      }
    });

    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      load.disabled = true;
      clear.disabled = true;
      status.dataset.error = "false";
      status.textContent = "IMPORTING WAV…";
      try {
        const result = await importFile(slot, file);
        status.textContent = result.inserted ? "WAV IMPORTED" : "WAV REUSED";
        rerender?.();
      } catch (error) {
        status.dataset.error = "true";
        status.textContent = `IMPORT FAILED · ${String(error?.message ?? error)}`;
        load.disabled = false;
        clear.disabled = !instrument?.assetRef;
      } finally {
        input.value = "";
      }
    });

    actions.append(load, clear, input);
    panel.append(copy, actions);
    return panel;
  }

  const api = Object.freeze({
    supportsView,
    metadata,
    metadataText,
    importFile,
    clearAsset,
    renderPanel,
  });

  globalThis.BRKTRKSampleAssetSurface = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
