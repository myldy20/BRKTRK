(() => {
  "use strict";
  if (!globalThis.BRKTRKProductionEngineHost?.registerDiagnostics?.()) {
    throw new Error("production engine diagnostics section could not register");
  }
  const diagnostics = globalThis.BRKTRKDiagnostics;
  const startup = globalThis.BRKTRKDynamicRuntimeStartup;
  if (startup?.snapshot && diagnostics?.registerSection) {
    diagnostics.registerSection("dynamicRuntimeStartup", startup.snapshot);
  }
  // Physical Sound input accounting is owned by the renderer that receives the
  // input. The retired rAF range coalescer used to own this section while also
  // queueing writes; the section name is kept so DEBUG snapshots stay
  // comparable across physical sessions.
  const soundEdit = globalThis.BRKTRKSoundEditRenderer;
  if (soundEdit?.soundInputSnapshot && diagnostics?.registerSection) {
    diagnostics.registerSection("productionSoundInput", soundEdit.soundInputSnapshot);
  }
})();
