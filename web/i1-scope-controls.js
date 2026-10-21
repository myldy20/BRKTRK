(() => {
  if (globalThis.BRKTRKI1ScopeControls?.installed) return;
  document.body.dataset.scopeCommandOwner = "initializing";

  function install() {
    const commands = globalThis.BRKTRKCommands;
    const p35 = globalThis.BRKTRKPlaybackContext;
    const transport = globalThis.BRKTRKTransport;
    if (!commands?.subscribe || !commands?.dispatch || !p35?.setScopeLocked || !transport?.requestScopeTransition) {
      window.setTimeout(install, 0);
      return false;
    }

    function origin() {
      return Object.freeze({
        songRow: state.songRow,
        track: state.track,
        chainId: state.chain,
        chainRow: state.chainRow,
        phraseId: state.phrase,
      });
    }

    function closePhonePolicy() {
      transport.closeMobilePolicy?.();
    }

    function applyNamedScope(scope, source) {
      if (!["song", "chain", "phrase"].includes(scope)) return false;
      p35.setScopeLocked(true, scope);
      transport.syncTransportToModel?.();
      transport.requestScopeTransition(scope, {
        source,
        explicit: true,
        origin: origin(),
      });
      globalThis.BRKTRKMixerTransportSafety?.renderScopeStatus?.();
      return true;
    }

    function applyAutoScope(source) {
      // Reselecting AUTO must not alter a queued Continue-to-Song request.
      if (!state.p35.scopeLocked) return false;
      p35.setScopeLocked(false, state.scope);
      transport.syncTransportToModel?.();
      transport.requestScopeTransition(state.scope, {
        source,
        explicit: false,
        origin: origin(),
      });
      globalThis.BRKTRKMixerTransportSafety?.renderScopeStatus?.();
      return true;
    }

    commands.subscribe((record) => {
      if (!record?.ok || record.command?.type !== "scope.set") return;
      applyNamedScope(record.command.scope, record.command.source ?? "scope-command");
    });

    document.addEventListener("click", (event) => {
      const phoneScope = event.target.closest?.("#p36MobilePolicyPanel [data-lock-scope]");
      const phoneAuto = event.target.closest?.("#p36MobileAuto");
      const desktopMode = event.target.closest?.("#p35ScopeModeButton");
      if (!phoneScope && !phoneAuto && !desktopMode) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      if (phoneScope) {
        void commands.dispatch({
          type: "scope.set",
          scope: phoneScope.dataset.lockScope,
          source: "phone-scope-command",
        }).finally(closePhonePolicy);
        return;
      }

      if (phoneAuto) {
        applyAutoScope("phone-scope-auto");
        closePhonePolicy();
        return;
      }

      applyAutoScope("desktop-scope-auto");
    }, true);

    globalThis.BRKTRKI1ScopeControls = Object.freeze({
      installed: true,
      applyNamedScope,
      applyAutoScope,
    });
    document.body.dataset.scopeCommandOwner = "command-dispatcher-to-transport-store";
    return true;
  }

  install();
})();
