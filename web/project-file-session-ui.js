(() => {
  const PERSISTENT_SAFETY_FAILURE_KINDS = new Set([
    "migration-write-failed",
    "staging-cleanup-failed",
    "staging-recovery-failed",
    "staging-inspection-failed",
    "blocked",
  ]);

  function describeSafetyCopyFailure(safetyCopy = {}) {
    if (safetyCopy?.lastFailure) {
      return Object.freeze({
        source: "runtime",
        code: String(safetyCopy.lastFailure.code ?? "BRKTRK_SAFETY_COPY_WRITE_FAILED"),
      });
    }
    const bootKind = String(safetyCopy?.boot?.kind ?? "");
    if (Number(safetyCopy?.writeCount ?? 0) === 0 && PERSISTENT_SAFETY_FAILURE_KINDS.has(bootKind)) {
      return Object.freeze({ source: "boot", code: bootKind });
    }
    return null;
  }

  function describeSaveState(view = {}, safetyCopy = {}) {
    const safetyFailure = describeSafetyCopyFailure(safetyCopy);
    if (view.externalConflict) {
      return Object.freeze({
        state: "conflict",
        label: safetyFailure ? "CONFLICT · COPY FAILED" : "CONFLICT",
        tone: "danger",
        safetyFailure,
      });
    }
    if (safetyFailure) {
      return Object.freeze({ state: "safety-copy-failed", label: "SAFETY COPY FAILED", tone: "danger", safetyFailure });
    }
    if (view.saveInFlight === true) {
      return Object.freeze({ state: "writing", label: "WRITE IN PROGRESS", tone: "amber", safetyFailure: null });
    }
    if (view.dirty === true) {
      return Object.freeze({ state: "dirty", label: "DIRTY", tone: "amber", safetyFailure: null });
    }
    const bindingMode = String(view.bindingMode ?? "none");
    // A recovery journal can remember the previous file name, but recovery
    // deliberately drops the direct handle/version authority. Even a clean
    // recovered checkpoint is therefore not known to equal durable storage.
    // Only a fresh successful Open/Save establishes a SAVED baseline again.
    const hasDurableBaseline = bindingMode !== "none" && bindingMode !== "recovery";
    if (hasDurableBaseline) {
      return Object.freeze({ state: "saved", label: "SAVED", tone: "green", safetyFailure: null });
    }
    return Object.freeze({ state: "not-saved", label: "NOT SAVED", tone: "muted", safetyFailure: null });
  }

  function install(root = globalThis) {
    if (root.BRKTRKProjectFileSessionUi?.installed) return root.BRKTRKProjectFileSessionUi;
    const session = root.BRKTRKProjectFileSession;
    if (!session?.installed || !root.document) throw new Error("Project file session UI requires the installed A2 session controller");

    function localBytes() {
      try {
        const key = root.BRKTRKProjectStorage?.STORAGE_KEY;
        if (!key || !root.localStorage) return 0;
        return new Blob([root.localStorage.getItem(key) ?? ""]).size;
      } catch {
        return 0;
      }
    }

    function safetyCopySnapshot() {
      return root.BRKTRKProjectPersistence?.snapshot?.() ?? {};
    }

    function ensureChromeStyle() {
      if (root.document.querySelector("#a5ProjectSaveTruthStyle")) return;
      const style = root.document.createElement("style");
      style.id = "a5ProjectSaveTruthStyle";
      style.textContent = `
        @media (min-width: 761px) {
          .command-bar { grid-template-columns: auto auto minmax(0, 1fr) auto auto; }
        }
        .project-save-state {
          min-width: 0;
          padding: 3px 6px;
          border: 1px solid var(--line);
          border-radius: 4px;
          background: var(--surface-2);
          color: var(--muted);
          font: 850 7px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
          letter-spacing: 0.04em;
          white-space: nowrap;
        }
        .project-save-state[data-save-state="saved"] { color: var(--green); border-color: rgba(69, 227, 148, 0.35); }
        .project-save-state[data-save-state="dirty"],
        .project-save-state[data-save-state="writing"] { color: var(--amber); border-color: rgba(255, 184, 47, 0.4); }
        .project-save-state[data-save-state="conflict"],
        .project-save-state[data-save-state="safety-copy-failed"] { color: var(--danger); border-color: rgba(255, 104, 119, 0.55); }
      `;
      root.document.head.append(style);
    }

    function ensureChromeState() {
      let element = root.document.querySelector("#projectSaveState");
      if (element) return element;
      const status = root.document.querySelector("#statusLine");
      if (!status) return null;
      element = root.document.createElement("div");
      element.id = "projectSaveState";
      element.className = "project-save-state";
      element.setAttribute("aria-live", "polite");
      status.insertAdjacentElement("afterend", element);
      return element;
    }

    function renderChrome(view = session.snapshot()) {
      ensureChromeStyle();
      const element = ensureChromeState();
      const safetyCopy = safetyCopySnapshot();
      const descriptor = describeSaveState(view, safetyCopy);
      if (element) {
        element.textContent = descriptor.label;
        element.dataset.saveState = descriptor.state;
        element.dataset.dirty = String(view.dirty === true);
        element.dataset.saveInFlight = String(view.saveInFlight === true);
        element.dataset.conflict = view.externalConflict?.kind ?? "";
        element.dataset.safetyCopy = String(safetyCopy?.state ?? "unknown");
        element.dataset.safetyCopyFailure = descriptor.safetyFailure?.code ?? "";
        const identity = view.fileName ?? "not bound to file";
        if (descriptor.safetyFailure) {
          element.title = `Browser safety copy failed · use Save / Save As to protect the Project · keep this tab open until a durable save succeeds · ${identity}`;
          element.setAttribute("aria-label", "Safety copy failed. Use Save or Save As to protect the Project and keep this tab open until a durable save succeeds.");
        } else {
          element.title = `Project ${descriptor.label} · ${identity}`;
          element.setAttribute("aria-label", `Project ${descriptor.label}`);
        }
      }
      if (root.document.body) root.document.body.dataset.projectSaveState = descriptor.state;
      return descriptor;
    }

    function syncCopy(view = session.snapshot()) {
      const descriptor = renderChrome(view);
      const autosave = root.document.querySelector("#autosaveSetting");
      const storageStatus = root.document.querySelector("#storageStatus");
      if (storageStatus) {
        if (descriptor.safetyFailure) {
          storageStatus.textContent = "LOCAL AUTOSAVE ERROR · SAFETY COPY FAILED · USE SAVE / SAVE AS";
        } else {
          const kb = Math.max(1, Math.round(localBytes() / 1024));
          storageStatus.textContent = autosave?.checked
            ? `LOCAL AUTOSAVE ON · BROWSER SAFETY COPY ${kb} KB`
            : "LOCAL AUTOSAVE OFF · PROJECT FILE SAVE AND RECOVERY REMAIN ACTIVE";
        }
      }

      const about = root.document.querySelector("#settingsDialog .settings-about");
      if (about) {
        let projectNote = about.querySelector("[data-a2-project-files]");
        if (!projectNote) {
          projectNote = root.document.createElement("p");
          projectNote.dataset.a2ProjectFiles = "true";
          about.append(projectNote);
        }
        projectNote.innerHTML = "Portable projects use the versioned <code>.brktrk</code> format. Local autosave is only a browser safety copy; crash recovery is separate and remains active when local autosave is off.";
        for (const paragraph of about.querySelectorAll("p")) {
          if (paragraph === projectNote) continue;
          if (paragraph.textContent?.includes("Project export currently uses a Web preview JSON envelope")) paragraph.remove();
        }
      }
    }

    function openSettings() {
      syncCopy();
      const dialog = root.document.querySelector("#settingsDialog");
      if (!dialog || dialog.open) return;
      try {
        dialog.showModal();
      } catch (error) {
        console.error("Could not open Settings dialog", error);
      }
    }

    function delegatedSettingsClick(event) {
      const target = event.target?.closest?.("#settingsButton");
      if (!target || !target.isConnected || target.disabled) return;
      openSettings();
    }

    root.document.addEventListener("click", delegatedSettingsClick);
    root.document.querySelector("#autosaveSetting")?.addEventListener("change", () => root.setTimeout?.(syncCopy, 0));
    const unsubscribe = session.subscribe?.(syncCopy) ?? (() => {});
    syncCopy();

    const api = Object.freeze({
      installed: true,
      sync: syncCopy,
      renderChrome,
      describeSaveState,
      describeSafetyCopyFailure,
      openSettings,
      dispose() {
        unsubscribe?.();
        root.document.removeEventListener("click", delegatedSettingsClick);
      },
    });
    root.BRKTRKProjectFileSessionUi = api;
    return api;
  }

  const api = Object.freeze({ install, describeSaveState, describeSafetyCopyFailure });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalThis.BRKTRKProjectFileSessionUiDomain = api;
  if (globalThis.document && globalThis.BRKTRKProjectFileSession?.installed) install(globalThis);
})();
