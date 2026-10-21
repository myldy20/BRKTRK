(() => {
  "use strict";

  const productionDomain = globalThis.BRKTRKProductionAudioRuntime;
  const traceDomain = globalThis.BRKTRKEventTraceDomain;
  if (!productionDomain || !traceDomain) throw new Error("production processor extension requires ProductionAudioRuntime + K4 EventTrace");

  const isProductionInstrument = (instrument) => Boolean(instrument?.engineRef?.moduleId && instrument?.engineRef?.engineId);
  const packageKey = (record) => [record?.moduleId, record?.engineId, record?.version, record?.packageSha256]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .join("\u0000");

  function activeRegistryMatchesRegisteredRuntime(snapshot) {
    const registered = Array.isArray(snapshot?.registeredPackages) ? snapshot.registeredPackages : [];
    const active = Array.isArray(snapshot?.activeRegistryPackages) ? snapshot.activeRegistryPackages : [];
    if (registered.length !== active.length) return false;
    const activeKeys = new Set(active.map(packageKey));
    return registered.every((record) => activeKeys.has(packageKey(record)));
  }

  function snapshotInstrumentIds(snapshot) {
    const ids = [];
    for (const [idText, instrument] of Object.entries(snapshot && typeof snapshot === "object" ? snapshot : {})) {
      const id = Number(idText);
      if (!Number.isInteger(id) || id < 0 || id > 255 || !isProductionInstrument(instrument)) continue;
      ids.push(id);
    }
    return ids;
  }

  function extendProcessor(BaseProcessor) {
    if (typeof BaseProcessor !== "function") throw new TypeError("production processor extension requires the authoritative processor class");

    return class BrktrkProductionAudioProcessor extends BaseProcessor {
      constructor(...args) {
        super(...args);
        this.productionAudio = productionDomain.createProductionAudioRuntime({
          sampleRate,
          trackCount: this.voices.length,
          postMessage: (message) => this.port.postMessage(message),
        });
        this.productionMixLeft = new Float32Array(productionDomain.MAX_BLOCK_FRAMES);
        this.productionMixRight = new Float32Array(productionDomain.MAX_BLOCK_FRAMES);
        const baseMessageHandler = this.port.onmessage;
        this.port.onmessage = (event) => {
          const message = event.data;
          // What an engine says about its own parameters lives in the module
          // instance, which exists only here in the Worklet. The Sound surface
          // renders on the main thread, so the answer has to cross. This is a
          // request/response on the existing port, off the render path -
          // instantiating a second copy of the module on the main thread just
          // to read it would duplicate the engine's fixed WASM memory, which is
          // 32 MiB for BRK Modal. See #455.
          if (message?.type === "production-engine-descriptors-request") {
            const requestId = String(message.requestId ?? "").trim();
            if (requestId) {
              const abiRuntime = globalThis.BRKTRKBrkSynthAbiV1Runtime;
              const records = typeof abiRuntime?.runtimeRecords === "function" ? abiRuntime.runtimeRecords() : [];
              this.port.postMessage({
                type: "production-engine-descriptors",
                requestId,
                // Engines that predate the descriptor calls report nothing and
                // are simply absent here; the main thread keeps using package
                // JSON for them rather than losing the engine.
                engines: records.flatMap((record) => {
                  const described = record?.abiDescriptors;
                  if (!described?.parameters?.length) return [];
                  return [{
                    moduleId: record.entry?.moduleId ?? null,
                    engineId: record.entry?.engineId ?? null,
                    version: record.entry?.version ?? null,
                    // Full package identity, so the main thread keys these the
                    // same way it keys every other package fact and cannot
                    // attach one engine's ranges to another's controls.
                    packageSha256: record.entry?.packageSha256 ?? "",
                    engine: described.engine ?? null,
                    parameters: described.parameters,
                  }];
                }),
              });
            }
            return;
          }

          if (message?.type === "production-package-registry-request") {
            const requestId = String(message.requestId ?? "").trim();
            if (requestId) {
              const snapshot = this.productionAudio.diagnostics();
              this.port.postMessage({
                type: "production-package-registry",
                requestId,
                // Package registration is a runtime-readiness proof, not just
                // evidence that addModule() executed. Report only packages in
                // the active EngineRegistry and expose deferred Instrument
                // state so the main thread cannot declare the current Project
                // ready while transport still owns an older registry/snapshot.
                packages: snapshot.activeRegistryPackages ?? [],
                pendingInstrumentSync: snapshot.pendingInstrumentSync === true,
                transportActive: snapshot.transportActive === true,
                // Packages whose registration threw in this Worklet scope, with
                // the engine's own reason, so the host can fail at once instead
                // of waiting out its whole proof timeout.
                registrationFailures: globalThis.BRKTRKBrkSynthAbiV1Runtime?.registrationFailures?.() ?? [],
              });
            }
            return;
          }

          // Reject before the base/decorated runtime commits a new transport,
          // timeline or prepared execution generation. A package loaded during
          // Play belongs to the next stopped registry, not the current program.
          if (this.playing && ["update-sequence", "update-plan"].includes(message?.type)
            && !activeRegistryMatchesRegisteredRuntime(this.productionAudio.diagnostics())) {
            this.port.postMessage({
              type: "production-transport-rejected",
              code: "engine-registry-refresh-boundary",
              message: "New engine pending; Stop then Play to apply Project edits",
              stoppedTransport: false,
              deferredUpdate: true,
              details: { deferredUpdate: true, appliedTransport: this.transportIdentity },
              transport: message.transport,
              appliedTransport: this.transportIdentity,
            });
            return;
          }

          const instrumentIds = message?.type === "production-instruments"
            ? snapshotInstrumentIds(message.instruments)
            : [];
          const addressableBefore = new Set(instrumentIds.filter((id) => Boolean(this.productionAudio.hasInstrument?.(id))));
          const handled = this.productionAudio.handleMessage(message);
          if (handled) {
            // A structural Project sync can safely promote another Instrument
            // only when its exact engine package already belongs to the active
            // registry. Reprepare solely for additions that became addressable
            // in this message. If any genuinely new Instrument remains deferred,
            // or the verified runtime set has moved beyond the active registry,
            // keep the current transport/registry untouched until STOP.
            if (message?.type === "production-instruments" && this.playing && instrumentIds.length > 0) {
              const promoted = instrumentIds.filter((id) => !addressableBefore.has(id) && Boolean(this.productionAudio.hasInstrument?.(id)));
              const runtimeSnapshot = this.productionAudio.diagnostics();
              if (promoted.length > 0 && activeRegistryMatchesRegisteredRuntime(runtimeSnapshot)) {
                // Route through the fully decorated runtime so R6 handle
                // resolution and retained prepared-state reconciliation run.
                // A capacity/performer miss is non-fatal here: the structural
                // snapshot remains pending for Stop, while the current program
                // and transport keep playing.
                this.refreshProductionProgram(this.mode === "track-plan"
                  ? { mode: "track-plan", tracks: this.trackPrograms }
                  : { mode: "sequence", steps: this.sequence });
              }
            }
            return;
          }
          baseMessageHandler(event);
        };
      }

      startSequence(sequence, tempo, transport = null, timeline = null) {
        super.startSequence(sequence, tempo, transport, timeline);
        if (this.playing) this.prepareProductionProgram({ mode: "sequence", steps: this.sequence });
      }

      startPlan(plan, tempo, transport = null) {
        super.startPlan(plan, tempo, transport);
        if (this.playing) this.prepareProductionProgram({ mode: "track-plan", tracks: this.trackPrograms });
      }

      updateSequence(sequence, transport = null, timeline = null) {
        super.updateSequence(sequence, transport, timeline);
        if (this.playing) this.prepareProductionProgram({ mode: "sequence", steps: this.sequence });
      }

      updatePlan(plan, transport = null) {
        super.updatePlan(plan, transport);
        if (this.playing) this.prepareProductionProgram({ mode: "track-plan", tracks: this.trackPrograms });
      }

      refreshProductionProgram(program) {
        try { return this.productionAudio.prepareProgram(program); }
        catch (error) {
          this.port.postMessage({
            type: "production-transport-rejected",
            code: error?.code ?? "live-instrument-admission-deferred",
            message: String(error?.message ?? error),
            details: error?.details ?? null,
            stoppedTransport: false,
            transport: this.transportIdentity,
          });
          return null;
        }
      }

      prepareProductionProgram(program) {
        try { return this.productionAudio.prepareProgram(program); }
        catch (error) {
          this.port.postMessage({ type: "production-transport-rejected", code: error?.code ?? "production-program-error", message: String(error?.message ?? error), details: error?.details ?? null, stoppedTransport: true, transport: this.transportIdentity });
          try { this.stop(this.transportIdentity); } catch {}
          return null;
        }
      }

      stop(transport = null) {
        try { this.productionAudio?.stop?.(); }
        catch (error) {
          this.port.postMessage({ type: "production-engine-error", code: error?.code ?? "production-stop-cleanup-failed", message: String(error?.message ?? error), details: error?.details ?? null, transport: this.transportIdentity });
        } finally {
          super.stop(transport);
        }
      }

      processTimelineLifecycle(frame, packet = null) {
        const tracePacket = packet ?? traceDomain.buildFramePacket({
          frame,
          program: this.timelineProgramSnapshot(),
          rowEvents: this.timelineRowEvents(),
          trackCount: this.voices.length,
        });
        const consumed = this.productionAudio.routeTracePacket(tracePacket);
        if (consumed.size === 0) return super.processTimelineLifecycle(frame, tracePacket);
        const hostLifecycleEvents = Object.freeze(tracePacket.events.filter((event) => !consumed.has(event.ordinal)));
        const hostLifecyclePacket = Object.freeze({ ...tracePacket, events: hostLifecycleEvents });
        super.processTimelineLifecycle(frame, hostLifecyclePacket);
        this.lastEventTracePacket = tracePacket;
        this.lastLifecycleFrame = frame;
        return tracePacket;
      }

      process(inputs, outputs) {
        const output = outputs[0];
        const left = output?.[0];
        const right = output?.[1] ?? left;
        if (!left || !right || left.length === 0) return super.process(inputs, outputs);

        const hasProduction = this.productionAudio.hasProductionInstruments();
        const blockStartFrame = this.currentBlockStartFrame();
        let began = false;
        try {
          if (hasProduction) {
            this.productionAudio.beginBlock(blockStartFrame, left.length);
            began = true;
          }

          // The base processor owns timing/lifecycle only. Product audio is
          // sourced exclusively from package-backed production performers.
          const keepAlive = super.process(inputs, outputs);
          this.productionMixLeft.fill(0, 0, left.length);
          this.productionMixRight.fill(0, 0, right.length);
          if (hasProduction && this.productionAudio.hasPreparedPerformers()) {
            this.productionAudio.renderInto(this.productionMixLeft, this.productionMixRight, this.trackMix);
          }

          // Keep the current production graph linear through the Track Mixer.
          // Master limiting/saturation is a future explicit host-owned domain;
          // it must not exist here as hidden always-on DSP.
          let peakLeft = 0;
          let peakRight = 0;
          for (let frame = 0; frame < left.length; frame += 1) {
            const mixedLeft = this.productionMixLeft[frame];
            const mixedRight = this.productionMixRight[frame];
            left[frame] = mixedLeft;
            right[frame] = mixedRight;
            peakLeft = Math.max(peakLeft, Math.abs(mixedLeft));
            peakRight = Math.max(peakRight, Math.abs(mixedRight));
          }

          if (this.meterCounter === 0) this.port.postMessage({ type: "meter", left: peakLeft, right: peakRight });

          if (began) {
            this.productionAudio.endBlock();
            began = false;
          }
          return keepAlive;
        } catch (error) {
          if (began) { try { this.productionAudio.endBlock(); } catch {} }
          let failure = null;
          try { failure = this.productionAudio.recordRenderFailure?.(error, { blockStartFrame }) ?? null; } catch {}
          // stoppedTransport says this failure is why playback is about to stop,
          // so the main thread can name the reason instead of showing a bare stop.
          this.port.postMessage({
            type: "production-engine-error",
            code: error?.code ?? "production-engine-error",
            track: Number.isInteger(error?.productionTrack) ? error.productionTrack : null,
            message: String(error?.message ?? error),
            transport: this.transportIdentity,
            stoppedTransport: true,
            renderFailures: failure?.failure ?? null,
          });
          try { this.stop(this.transportIdentity); } catch {}
          left.fill(0);
          if (right !== left) right.fill(0);
          return true;
        }
      }
    };
  }

  const api = Object.freeze({ extendProcessor });
  globalThis.BRKTRKProductionAudioProcessorExtension = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
