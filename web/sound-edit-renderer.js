(() => {
  "use strict";

  const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const activePages = new Map();
  const PERFORMANCE_PAGE = Symbol("brktrk-performance-page");
  let catalogPromise = null;
  let presetSurfacePromise = null;
  let renderToken = 0;

  async function presetSurface() {
    if (globalThis.BRKTRKSoundPresetSurface) return globalThis.BRKTRKSoundPresetSurface;
    if (!presetSurfacePromise) {
      presetSurfacePromise = import("./sound-preset-surface.js").then(() => {
        if (!globalThis.BRKTRKSoundPresetSurface) throw new Error("Sound preset surface did not register");
        return globalThis.BRKTRKSoundPresetSurface;
      }).catch((error) => {
        presetSurfacePromise = null;
        throw error;
      });
    }
    return presetSurfacePromise;
  }

  function mutationContext(mutation, side) {
    return mutation?.[`context${side}`]
      ?? mutation?.[side.toLowerCase()]?.context
      ?? mutation?.[side.toLowerCase()]
      ?? {};
  }

  function selectionDelta(before = {}, after = {}) {
    return Object.freeze({
      instrumentChanged: Number(before.instrument) !== Number(after.instrument),
      parameterChanged: Number(before.soundParam) !== Number(after.soundParam),
    });
  }

  function parameterCards() {
    if (typeof document === "undefined") return [];
    return typeof $$ === "function"
      ? $$("#instrumentInspector .a4a-param")
      : [...document.querySelectorAll("#instrumentInspector .a4a-param")];
  }

  function parameterCount(instrumentId = state?.instrument ?? 0) {
    if (typeof document === "undefined") return 0;
    const shell = document.querySelector("#instrumentInspector .a4a-sound-shell");
    if (!shell || Number(shell.dataset.productionInstrument) !== Number(instrumentId)) return 0;
    return parameterCards().length;
  }

  function refreshCardSelection({ focus = true } = {}) {
    const cards = parameterCards();
    const selected = Math.max(0, Math.min(cards.length - 1, Number(state?.p3?.soundParam ?? 0) || 0));
    cards.forEach((card, index) => {
      card.dataset.param = String(index);
      card.tabIndex = index === selected ? 0 : -1;
      card.classList.toggle("p301-keyboard-focus", index === selected);
      card.setAttribute("aria-selected", String(index === selected));
    });
    if (focus) globalThis.BRKTRKCommandBindings?.focusUtility?.();
    return cards[selected] ?? null;
  }

  function productionParameter(changeSet = {}) {
    const path = Array.isArray(changeSet.path) ? changeSet.path : [];
    if (path[0] !== "instrumentPool" || path[2] !== "parameterSnapshot") return null;
    const instrumentId = Number(path[1]);
    const parameterId = String(path.slice(3).join(".") || changeSet?.transaction?.parameterKey || "").trim();
    if (!Number.isInteger(instrumentId) || instrumentId < 0 || instrumentId > 255 || !parameterId) return null;
    return Object.freeze({ instrumentId, parameterId });
  }

  function enumLabels(parameter, ui = {}) {
    const labels = ui?.enumLabels?.[parameter.id];
    if (Array.isArray(labels) && labels.length) return labels.map(String);
    if (Array.isArray(parameter.values) && parameter.values.length) return parameter.values.map(String);
    if (Array.isArray(parameter.labels) && parameter.labels.length) return parameter.labels.map(String);
    return [];
  }

  // What the engine itself shipped this parameter at. The notch on every track
  // points here and a double-tap returns here, so it needs one definition.
  function defaultNormalized(parameter) {
    return clamp01(parameter?.defaultNormalized ?? parameter?.normalized_default ?? parameter?.default ?? 0);
  }

  function normalizedValue(parameter, instrument) {
    const stored = instrument?.parameterSnapshot?.[parameter.id];
    if (Number.isFinite(Number(stored))) return clamp01(stored);
    return defaultNormalized(parameter);
  }

  function normalizedFromEnumIndex(index, count) {
    if (count <= 1) return 0;
    return clamp01(Number(index) / (count - 1));
  }

  function enumIndexFromNormalized(value, count) {
    if (count <= 1) return 0;
    return Math.max(0, Math.min(count - 1, Math.round(clamp01(value) * (count - 1))));
  }

  function selectedParameterContext(instrumentId = state?.instrument ?? 0, parameterIndex = state?.p3?.soundParam ?? 0) {
    const id = Number(instrumentId);
    const index = Number(parameterIndex);
    if (!Number.isInteger(id) || id < 0 || id > 255 || !Number.isInteger(index) || index < 0) return null;
    const instrument = globalThis.BRKTRKStores?.project?.getState?.()?.instrumentPool?.[id];
    if (!instrument?.engineRef) return null;
    const cards = parameterCards();
    if (!cards.length) return null;
    const card = cards[Math.min(index, cards.length - 1)];
    const parameterId = String(card?.dataset?.productionParam ?? "").trim();
    if (!parameterId) return null;
    const interaction = globalThis.BRKTRKProductionEngineHost?.interactionFor?.(instrument.engineRef, parameterId);
    if (!interaction?.parameter) return null;
    return Object.freeze({
      instrumentId: id,
      parameterIndex: Math.min(index, cards.length - 1),
      parameterId,
      parameter: interaction.parameter,
      interaction,
      value: normalizedValue(interaction.parameter, instrument),
      count: cards.length,
    });
  }

  function normalizeParameterInput(context, value) {
    const normalized = clamp01(value);
    const labels = enumLabels(context?.parameter ?? {}, {});
    if (labels.length > 1) return normalizedFromEnumIndex(enumIndexFromNormalized(normalized, labels.length), labels.length);
    return normalized;
  }

  function parameterStep(context, magnitude = "fine") {
    const labels = enumLabels(context?.parameter ?? {}, {});
    if (labels.length > 1) return 1 / (labels.length - 1);
    return magnitude === "coarse" ? 0.1 : 0.01;
  }

  // A normalized control maps to a plain value linearly unless the parameter
  // declares a curve. Filter cutoff and envelope times are exponential in every
  // engine that sounds musical, so mapping them linearly printed a confidently
  // wrong number - worse than a percentage, because it claims to be true. An
  // engine that declares nothing keeps the original linear behaviour.
  function plainFromNormalized(parameter, value) {
    const range = parameter.plainRange;
    if (!Array.isArray(range) || range.length < 2) return null;
    const min = Number(range[0]);
    const max = Number(range[1]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    const normalized = clamp01(value);
    // An unrecognised curve must not fall through to linear. A package that
    // misspells "exponential" would otherwise print ~10 kHz where the DSP uses
    // ~775 Hz, which is exactly the confidently wrong reading a declared curve
    // exists to prevent. Fall back to a percentage instead.
    const curve = parameter.plainCurve == null ? "linear" : String(parameter.plainCurve);
    if (curve === "exponential") {
      // Only defined for strictly positive bounds; fall back rather than
      // render NaN for a malformed descriptor.
      if (min <= 0 || max <= 0) return null;
      return min * Math.pow(max / min, normalized);
    }
    if (curve !== "linear") return null;
    return min + (max - min) * normalized;
  }

  // Unit selection is declared by the package, not inferred here: the renderer
  // must not need to know that 1000 Hz is a kHz. Scales are tried in order, so
  // a descriptor lists the largest threshold first.
  function formatPlain(parameter, plain) {
    const scales = Array.isArray(parameter.plainScales) ? parameter.plainScales : null;
    if (scales) {
      for (const scale of scales) {
        const threshold = Number(scale.atLeast);
        if (Number.isFinite(threshold) && Math.abs(plain) < threshold) continue;
        const divisor = Number(scale.divide);
        const scaled = plain / (Number.isFinite(divisor) && divisor !== 0 ? divisor : 1);
        // toFixed throws outside 0..100, and a control that throws takes the
        // whole Sound surface down rather than degrading, so clamp rather than
        // trust the descriptor.
        const decimals = Math.min(20, Math.max(0, Number.isInteger(scale.decimals) ? scale.decimals : 2));
        const unit = scale.unit ? ` ${scale.unit}` : "";
        return `${fixedWithoutNegativeZero(scaled, decimals)}${unit}`;
      }
    }
    const text = fixedWithoutNegativeZero(plain, Math.abs(plain) >= 10 ? 1 : 2);
    return parameter.plainUnit ? `${text} ${parameter.plainUnit}` : text;
  }

  // --- what the engine itself says a control means ---------------------------
  // An engine binary carries plain_min/plain_max/unit per parameter and BRKTRK
  // now reads them (#455). They outrank the package JSON because they cannot
  // drift from the DSP: the same binary answers both.
  //
  // The curve comes from the package UI profile rather than the ABI, because
  // the ABI descriptor has no skew field - that split is deliberate upstream.
  // `plainSkewByKey` is BRKSNTH's existing contract and its own host applies it
  // as `proportion = normalized^(1/skew)` (host/browser/brk_sound_panel.mjs).
  const abiDescriptorFor = (parameter, view) => {
    if (!parameter?.id || !view?.entry) return null;
    const described = globalThis.BRKTRKProductionEngineHost?.abiDescriptorsFor?.(view.entry);
    if (!described?.parameters?.length) return null;
    return described.parameters.find((candidate) => candidate.key === parameter.id) ?? null;
  };

  // A unitless 0..1 range is a percentage, and printing "0.50" for it would be
  // a downgrade dressed as precision. Most of a real engine's parameters are
  // genuinely normalized - 56 of BRK Modal's 89 - so this rule decides which
  // third actually gains from the ABI.
  const describesPlainValue = (descriptor) => {
    if (!descriptor) return false;
    const min = Number(descriptor.plainMin);
    const max = Number(descriptor.plainMax);
    if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return false;
    if (String(descriptor.unit ?? "").trim()) return true;
    return min !== 0 || max !== 1;
  };

  // The ABI descriptor is authoritative about the RANGE, the unit and the step,
  // and says nothing at all about the normalized->plain CURVE - the 96-byte
  // struct has no field for one. So the package stays the only place a curve
  // can be declared, and the two have to be composed. Taking the ABI range with
  // an implied linear curve is what printed 2001 ms for an `attack` whose DSP
  // runs the declared exponential mapping and is actually at 63 ms.
  // Returns null when the package declares a curve this renderer does not know:
  // guessing linear there is exactly the confident lie a declared curve exists
  // to prevent, so the caller falls back instead.
  function plainFromAbi(parameter, descriptor, value, skew) {
    const min = Number(descriptor.plainMin);
    const max = Number(descriptor.plainMax);
    const normalized = clamp01(value);
    const declaredCurve = parameter?.plainCurve == null ? null : String(parameter.plainCurve);
    let plain;
    if (declaredCurve === "exponential") {
      // Only defined for strictly positive bounds.
      if (min <= 0 || max <= 0) return null;
      plain = min * Math.pow(max / min, normalized);
    } else if (declaredCurve !== null && declaredCurve !== "linear") {
      return null;
    } else {
      // No package curve: BRKSNTH's own `plainSkewByKey`, applied as its host
      // does (proportion = normalized^(1/skew)), then linear.
      const factor = Number(skew);
      const usableSkew = Number.isFinite(factor) && factor > 0 ? factor : 1;
      const proportion = usableSkew === 1 || normalized <= 0
        ? normalized
        : Math.exp(Math.log(normalized) / usableSkew);
      plain = min + (max - min) * proportion;
    }
    const step = Number(descriptor.plainStep);
    if (Number.isFinite(step) && step > 0) return min + step * Math.round((plain - min) / step);
    return plain;
  }

  // Decimals have to come from the step's actual decimal representation, not
  // from -log10(step): that is only right for powers of ten, and it rounds a
  // value stepped by 0.25 to one decimal, printing "0.3" for a value the
  // engine holds at exactly 0.25.
  function stepDecimals(step) {
    const value = Number(step);
    if (!Number.isFinite(value) || value <= 0) return 0;
    // ABI v1 stores plainStep as f32. String(value) exposes the binary->double
    // expansion (for example 0.1f becomes 0.10000000149...), which is not the
    // semantic display precision. Find the shortest decimal representation
    // that round-trips to the same f32 value instead.
    const target = Math.fround(value);
    for (let digits = 0; digits <= 6; digits += 1) {
      if (Math.fround(Number(value.toFixed(digits))) === target) return digits;
    }
    return 6;
  }

  // A value a hair below zero prints as "-0.00", which reads as negative where
  // the parameter is exactly at its own zero - the place a bipolar control now
  // draws a tick and users deliberately land on. The rounded text is what
  // decides, so this can never flip a genuinely negative reading.
  function fixedWithoutNegativeZero(plain, digits) {
    const text = plain.toFixed(digits);
    return Number(text) === 0 ? (0).toFixed(digits) : text;
  }

  function formatAbiPlain(descriptor, plain) {
    const magnitude = Math.abs(plain);
    // The engine's step is a statement about resolution, so it decides the
    // decimals where it has one: a parameter stepped in whole voices reads
    // "16 voices", not "16.0 voices", which would imply a precision the
    // control does not have. Without a step, scale the decimals by magnitude.
    const step = Number(descriptor.plainStep);
    const digits = Number.isFinite(step) && step > 0
      ? stepDecimals(step)
      : magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
    const unit = String(descriptor.unit ?? "").trim();
    const text = fixedWithoutNegativeZero(plain, digits);
    return unit ? `${text} ${unit}` : text;
  }

  // --- how a control's fill reads ---------------------------------------------
  // A bipolar parameter is one whose plain range crosses zero. WARP at -0.25 is
  // a negative value, and drawing it as a quarter-full bar growing from the
  // left says the opposite of what it is. So the fill has to start at the
  // parameter's own zero and grow towards the value.
  //
  // That zero is only at the middle of the track when the range happens to be
  // symmetric, so it is computed from the engine's declared range and curve
  // rather than assumed. A parameter that does not cross zero, or whose curve
  // this renderer cannot honour, stays unipolar: drawing a guessed centre is
  // exactly the confident lie the display path already refuses to tell.
  const packagePlainRange = (parameter) => {
    const range = parameter?.plainRange;
    if (!Array.isArray(range) || range.length < 2) return null;
    const min = Number(range[0]);
    const max = Number(range[1]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return null;
    return { min, max, curve: parameter.plainCurve };
  };

  function zeroAnchor(parameter, ui = {}, view = null) {
    const descriptor = abiDescriptorFor(parameter, view);
    // Which source supplies the range decides whether the skew applies at all,
    // because only the ABI reading path composes it. Taking the skew on the
    // package path drew the tick where the number was not zero: for
    // plainRange [-1, 1] with skew 0.35 it landed at 0.785, which reads 0.57.
    const fromAbi = describesPlainValue(descriptor);
    const range = fromAbi
      ? { min: Number(descriptor.plainMin), max: Number(descriptor.plainMax), curve: parameter?.plainCurve }
      : packagePlainRange(parameter);
    if (!range || !(range.min < 0 && range.max > 0)) return null;
    // An exponential mapping is only defined for strictly positive bounds, so a
    // range that crosses zero can only be the linear-or-absent curve.
    const curve = range.curve == null ? "linear" : String(range.curve);
    if (curve !== "linear") return null;
    const proportion = (0 - range.min) / (range.max - range.min);
    if (!fromAbi) return clamp01(proportion);
    // On the ABI path the skew is applied to the reading as
    // `proportion = normalized^(1/skew)`, so the normalized position of a plain
    // value is `proportion^skew`.
    const skew = Number(ui?.plainSkewByKey?.[parameter?.id]);
    const usableSkew = Number.isFinite(skew) && skew > 0 ? skew : 1;
    return clamp01(usableSkew === 1 ? proportion : Math.pow(proportion, usableSkew));
  }

  function fillGeometry(parameter, value, ui = {}, view = null) {
    const normalized = clamp01(value);
    const zero = zeroAnchor(parameter, ui, view);
    if (zero === null) return Object.freeze({ bipolar: false, zero: null, from: 0, to: normalized });
    return Object.freeze({
      bipolar: true,
      zero,
      from: Math.min(zero, normalized),
      to: Math.max(zero, normalized),
    });
  }

  // The fill is painted by the track's own background from these custom
  // properties, so a value change is one style write on an element that is
  // already being updated - no extra node, no second source of truth.
  function applyFill(card, input, parameter, value, ui = {}, view = null) {
    if (!input) return null;
    const geometry = fillGeometry(parameter, value, ui, view);
    const percent = (fraction) => `${(fraction * 100).toFixed(3)}%`;
    input.style.setProperty("--a4a-fill-from", percent(geometry.from));
    input.style.setProperty("--a4a-fill-to", percent(geometry.to));
    input.style.setProperty("--a4a-default", percent(clamp01(defaultNormalized(parameter))));
    if (geometry.bipolar) input.style.setProperty("--a4a-fill-zero", percent(geometry.zero));
    else input.style.removeProperty("--a4a-fill-zero");
    if (card) {
      if (geometry.bipolar) card.dataset.bipolar = "true";
      else delete card.dataset.bipolar;
    }
    return geometry;
  }

  function displayValue(parameter, value, ui = {}, view = null) {
    const labels = enumLabels(parameter, ui);
    if (labels.length) return labels[enumIndexFromNormalized(value, labels.length)];

    const descriptor = abiDescriptorFor(parameter, view);
    if (describesPlainValue(descriptor)) {
      const plain = plainFromAbi(parameter, descriptor, value, ui?.plainSkewByKey?.[parameter.id]);
      // null means the package declared a curve this renderer cannot honour;
      // fall through to the package path rather than print a guess.
      if (plain !== null) {
        // A package that declared `plainScales` authored them for its own
        // curve and unit tiers (1.18 ms, not "1 ms"), so they outrank the
        // single step-derived precision here.
        return Array.isArray(parameter.plainScales) && parameter.plainScales.length
          ? formatPlain(parameter, plain)
          : formatAbiPlain(descriptor, plain);
      }
    }

    // No engine answer: fall back to whatever the package JSON declared. This
    // is what every engine predating the descriptor calls still uses.
    const plain = plainFromNormalized(parameter, value);
    if (plain !== null) return formatPlain(parameter, plain);
    return `${Math.round(clamp01(value) * 100)}%`;
  }

  function pageControls(view, pageId) {
    const parameters = Array.isArray(view?.parameters) ? view.parameters : [];
    const ui = view?.ui ?? {};
    const pages = Array.isArray(ui.pages) && ui.pages.length
      ? ui.pages
      : [{ id: "all", label: "All", mode: "all" }];
    const page = pages.find((candidate) => candidate.id === pageId) ?? pages[0];
    if (page.mode === "all" || !Array.isArray(page.controls)) return Object.freeze({ page, controls: Object.freeze(parameters) });
    const byId = new Map(parameters.map((parameter) => [parameter.id, parameter]));
    return Object.freeze({ page, controls: Object.freeze(page.controls.map((id) => byId.get(String(id))).filter(Boolean)) });
  }

  // This is not a second parameter/macro model: it is one carefully sized
  // view over the engine's real stable parameter IDs. The authored first page
  // decides musical order; a level/output control remains reachable even if
  // it was authored last. The full engine pages never lose parameters.
  function performanceControls(view, limit = 6) {
    const parameters = Array.isArray(view?.parameters) ? view.parameters : [];
    const pages = Array.isArray(view?.ui?.pages) ? view.ui.pages : [];
    const curated = pages.find((page) => page.mode !== "all" && Array.isArray(page.controls) && page.controls.length);
    const mapped = new Map(parameters.map((param) => [param.id, param]));
    const ordered = curated ? curated.controls.map((id) => mapped.get(String(id))).filter(Boolean) : parameters;
    const unique = [];
    for (const param of ordered) {
      if (unique.some((candidate) => candidate.id === param.id)) continue;
      unique.push(param);
    }
    const max = Math.max(1, Math.min(8, Math.round(Number(limit) || 6)));
    const selected = unique.slice(0, max);
    const level = parameters.find((param) => /^(level|volume|output(?:_gain)?|master_gain|gain)$/i.test(String(param.id)));
    if (level && !selected.some((param) => param.id === level.id)) {
      if (selected.length === max) selected[selected.length - 1] = level;
      else selected.push(level);
    }
    return Object.freeze(selected);
  }

  function knobDragValue(value, displacementPx, fine = false) {
    const pixelsPerSweep = fine ? 600 : 160;
    return clamp01(Number(value) + Number(displacementPx) / pixelsPerSweep);
  }

  function paintKnob(well, value) {
    if (!well) return;
    const fraction = clamp01(value);
    well.style.setProperty("--a4a-knob-arc", `${(fraction * 270).toFixed(3)}deg`);
    well.style.setProperty("--a4a-knob-angle", `${(-135 + fraction * 270).toFixed(3)}deg`);
  }

  function refreshFilterAvailability(inspector, instrument, view) {
    const mode = view?.parameters?.find?.((parameter) => parameter.id === "filter_mode");
    const firstMode = mode ? enumLabels(mode, view.ui ?? {})[0] : null;
    // Infer bypass only when the engine itself labels the first mode as such.
    // Some engines use mode zero for an active filter, so never guess from 0.
    const bypass = /^(off|none|bypass|disabled?)$/i.test(String(firstMode ?? "").trim())
      && enumIndexFromNormalized(normalizedValue(mode, instrument), enumLabels(mode, view.ui ?? {}).length) === 0;
    for (const id of ["cutoff", "resonance"]) {
      const card = [...inspector.querySelectorAll(".a4a-param")].find((candidate) => candidate.dataset.productionParam === id);
      if (!card) continue;
      card.toggleAttribute("data-filter-bypassed", bypass);
      let hint = card.querySelector(".a4a-filter-bypass-hint");
      if (bypass && !hint) {
        hint = document.createElement("small");
        hint.className = "a4a-filter-bypass-hint";
        hint.textContent = "FILTER OFF · select a filter mode to hear this control";
        card.append(hint);
      } else if (!bypass) hint?.remove();
    }
  }

  function buildCreationInput(view, slot) {
    if (!view?.entry) throw new TypeError("verified package view is required to create a production Instrument");
    const parameterSnapshot = {};
    for (const parameter of Array.isArray(view.parameters) ? view.parameters : []) {
      parameterSnapshot[parameter.id] = defaultNormalized(parameter);
    }
    const title = String(view.ui?.title ?? view.engine?.title ?? view.engine?.name ?? view.entry.engineId).trim();
    return Object.freeze({
      name: (title || `INSTRUMENT ${Number(slot).toString(16).toUpperCase().padStart(2, "0")}`).slice(0, 48),
      engineRef: Object.freeze({
        moduleId: view.entry.moduleId,
        engineId: view.entry.engineId,
        requestedVersion: view.entry.version,
        resolvedVersion: view.entry.version,
        resolvedPackageSha256: view.entry.packageSha256,
        hostContract: view.entry.hostContract?.id ?? null,
        channel: String(view.entry.channel ?? "stable"),
      }),
      patchState: Object.freeze({ schemaVersion: view.entry.stateSchemaVersion, encoding: "base64", data: null }),
      parameterSnapshot: Object.freeze(parameterSnapshot),
      provenance: Object.freeze({ source: "engine-catalog", packageSha256: view.entry.packageSha256, createdBy: "brktrk-a4" }),
    });
  }

  function ensureStyle() {
    if (typeof document === "undefined" || document.querySelector("#a4a-production-sound-style")) return;
    const style = document.createElement("style");
    style.id = "a4a-production-sound-style";
    style.textContent = `
      #instrumentInspector .a4a-sound-shell{display:grid;gap:10px;min-width:0}
      .a4a-sound-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px;border:1px solid var(--line,#343944);border-radius:8px;background:rgba(255,255,255,.025)}
      .a4a-sound-toolbar label{display:flex;gap:6px;align-items:center;font-size:11px}
      .a4a-sound-toolbar select,.a4a-sound-toolbar input,.a4a-sound-toolbar button,.a4a-page-tabs button,.a4a-create-panel select,.a4a-create-panel button{font:inherit;min-height:32px}
      .a4a-sound-toolbar input[type=text]{min-width:130px;flex:1}.a4a-engine-id{font-size:10px;opacity:.7;overflow-wrap:anywhere}
      .a4a-page-tabs{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px}.a4a-page-tabs button{white-space:nowrap;border:1px solid var(--line,#343944);border-radius:999px;padding:4px 10px;background:transparent;color:inherit}.a4a-page-tabs button[aria-pressed=true]{background:rgba(255,255,255,.12)}
      .a4a-parameter-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(154px,1fr));gap:2px 14px;align-items:start}.a4a-param{display:grid;gap:6px;padding:9px 2px 8px;border:0;box-shadow:inset 0 -1px 0 rgba(70,96,120,.34);min-width:0}.a4a-param header{display:flex;justify-content:space-between;gap:10px;align-items:baseline}.a4a-param header strong{font-size:8px;letter-spacing:.14em;text-transform:uppercase;opacity:.72;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.a4a-param output{font-variant-numeric:tabular-nums;font-size:15px;font-weight:800}
      .a4a-param input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:16px;margin:0;padding:0;background:transparent;cursor:ew-resize}.a4a-param input[type=range]::-webkit-slider-runnable-track{height:7px;border-radius:4px;background-color:#0a121b;box-shadow:inset 0 1px 2px rgba(0,0,0,.75),inset 0 -1px 0 rgba(255,255,255,.035);background-image:linear-gradient(90deg,transparent 0 var(--a4a-default,50%),rgba(141,160,178,.5) var(--a4a-default,50%) calc(var(--a4a-default,50%) + 1px),transparent calc(var(--a4a-default,50%) + 1px) 100%),linear-gradient(90deg,transparent 0 var(--a4a-fill-from,0%),var(--a4a-accent,var(--pink,#ff3f92)) var(--a4a-fill-from,0%) var(--a4a-fill-to,0%),transparent var(--a4a-fill-to,0%) 100%)}.a4a-param[data-bipolar] input[type=range]::-webkit-slider-runnable-track{background-image:linear-gradient(90deg,transparent 0 var(--a4a-fill-zero,50%),rgba(226,238,248,.62) var(--a4a-fill-zero,50%) calc(var(--a4a-fill-zero,50%) + 1px),transparent calc(var(--a4a-fill-zero,50%) + 1px) 100%),linear-gradient(90deg,transparent 0 var(--a4a-default,50%),rgba(141,160,178,.5) var(--a4a-default,50%) calc(var(--a4a-default,50%) + 1px),transparent calc(var(--a4a-default,50%) + 1px) 100%),linear-gradient(90deg,transparent 0 var(--a4a-fill-from,0%),var(--a4a-accent,var(--pink,#ff3f92)) var(--a4a-fill-from,0%) var(--a4a-fill-to,0%),transparent var(--a4a-fill-to,0%) 100%)}.a4a-param input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:2px;height:13px;margin-top:-3px;border:0;border-radius:1px;background:var(--ink,#edf3f7)}
      .a4a-param[data-control=enum]{grid-template-columns:minmax(0,auto) minmax(0,1fr);align-items:center;gap:4px 10px}.a4a-param[data-control=enum] header{display:contents}.a4a-param[data-control=enum] output{display:none}.a4a-param[data-control=enum] small{grid-column:1/-1}.a4a-param select{-webkit-appearance:none;appearance:none;width:100%;min-width:0;padding:0 15px 0 0;border:0;background-color:transparent;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23506477' stroke-width='3.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right center;background-size:9px 9px;color:var(--a4a-accent,var(--cyan,#32d7ee));font-size:12px;font-weight:800;text-align:right;text-align-last:right;cursor:pointer}.a4a-param small{opacity:.62;font-size:7px;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .a4a-create-panel{display:grid;gap:8px;padding:10px;border:1px dashed var(--line,#343944);border-radius:8px;margin-bottom:10px}.a4a-create-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.a4a-create-row select{min-width:180px;flex:1}.a4a-sound-state{font-size:10px;opacity:.7}.a4a-error{color:var(--danger,#ff6b6b)}
      .a4b-preset-panel{display:grid;grid-template-columns:minmax(0,1fr) minmax(150px,auto);grid-template-areas:"row heading" "save heading" "manage heading";gap:6px;padding:9px;border:1px solid var(--line,#343944);border-radius:8px;background:rgba(255,255,255,.018)}.a4b-preset-heading{grid-area:heading}.a4b-preset-row{grid-area:row}.a4b-preset-save-row{grid-area:save}.a4b-preset-manage-row{grid-area:manage;display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:6px}.a4b-preset-manage-row[hidden]{display:none}.a4b-preset-heading,.a4b-preset-row{display:flex;gap:8px;align-items:center}.a4b-preset-heading{justify-content:space-between}.a4b-preset-row select{min-width:180px;flex:1;min-height:32px}.a4b-preset-row button{min-height:32px}.a4b-preset-save-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:6px;min-width:0}.a4b-preset-save-row[hidden]{display:none}.a4b-preset-save-row input,.a4b-preset-save-row select{min-width:0;min-height:32px}.a4b-preset-save-row button{min-height:32px}.a4b-preset-manage-row input{min-width:0;min-height:32px}.a4b-preset-manage-row button{min-height:32px}.a4b-preset-blocked{flex:none;font-size:8px;letter-spacing:.06em;opacity:.7}.a4b-preset-blocked[hidden]{display:none}.a4b-preset-state{font-size:9px;opacity:.68;text-align:right}.a4b-recovery-panel small{overflow-wrap:anywhere;opacity:.72}.a4b-recovery-panel button{justify-self:start}
      @media(max-width:640px){.a4b-preset-panel{grid-template-columns:minmax(0,1fr);grid-template-areas:"heading" "row" "save" "manage"}.a4a-parameter-grid{grid-template-columns:1fr;gap:0}.a4a-param input[type=range]{height:44px;margin-top:-10px;margin-bottom:-8px}.a4a-param output{font-size:17px}.a4a-sound-toolbar{align-items:stretch}.a4a-sound-toolbar label{width:100%}.a4a-sound-toolbar select,.a4a-sound-toolbar input[type=text]{flex:1;min-width:0}.a4b-preset-row{align-items:stretch;flex-wrap:wrap}.a4b-preset-row select{flex:1 1 auto;min-width:8rem}.a4b-preset-save-row{grid-template-columns:repeat(3,minmax(0,1fr))}.a4b-preset-save-row input{grid-column:1/-1}.a4b-preset-blocked{flex:1 0 100%;text-align:left}.a4b-preset-save-row input,.a4b-preset-save-row select,.a4b-preset-save-row button,.a4b-preset-manage-row input,.a4b-preset-manage-row button{min-height:44px}.a4b-preset-heading{align-items:flex-start}.a4b-preset-state{max-width:58%}}
    `;
    document.head.append(style);
  }

  function slotLabel(id, pool) {
    const hexId = Number(id).toString(16).toUpperCase().padStart(2, "0");
    const instrument = pool?.[id];
    return instrument ? `${hexId} · ${instrument.name}` : `${hexId} · empty`;
  }

  function navigateInstrument(id) {
    const navigation = globalThis.BRKTRKStores?.navigation;
    if (!navigation?.captureContext || !navigation?.restoreContext) return false;
    const before = navigation.captureContext();
    navigation.restoreContext({ ...before, instrument: Number(id), dock: "sound" }, {
      source: "a4-production-instrument-picker",
      subtype: "sound.instrument",
      target: "navigation.sound.instrument",
      path: ["poolBrowsing", "instrument"],
      renderTargets: ["navigation.context", "navigation.focus"],
    });
    renderProductionSurface();
    return true;
  }

  function toolbar(slot, instrument, view, onEngineChange = null) {
    const project = globalThis.BRKTRKStores.project.getState();
    const bar = document.createElement("div");
    bar.className = "a4a-sound-toolbar";
    const slotLabelEl = document.createElement("label");
    slotLabelEl.append("INST");
    const slotSelect = document.createElement("select");
    slotSelect.setAttribute("aria-label", "Production Instrument slot");
    for (let id = 0; id < 256; id += 1) {
      const option = document.createElement("option");
      option.value = String(id);
      option.textContent = slotLabel(id, project.instrumentPool);
      option.selected = id === slot;
      slotSelect.append(option);
    }
    slotSelect.addEventListener("change", () => navigateInstrument(Number(slotSelect.value)));
    slotLabelEl.append(slotSelect);

    const nameLabel = document.createElement("label");
    nameLabel.append("NAME");
    const name = document.createElement("input");
    name.type = "text";
    name.maxLength = 48;
    name.value = instrument.name;
    name.setAttribute("aria-label", "Production Instrument name");
    name.addEventListener("change", () => {
      const value = name.value.trim();
      if (!value) { name.value = instrument.name; return; }
      globalThis.BRKTRKStores.project.renameProductionInstrument(slot, value, { source: "a4-sound-name" });
    });
    nameLabel.append(name);

    const engine = document.createElement("span");
    engine.className = "a4a-engine-id";
    engine.textContent = `${view.entry.moduleId}/${view.entry.engineId}@${view.entry.version}`;
    engine.title = `Package ${view.entry.packageSha256}`;
    bar.append(slotLabelEl, nameLabel, engine);
    if (typeof onEngineChange === "function") {
      const change = document.createElement("button");
      change.type = "button";
      change.className = "a4a-engine-change";
      change.textContent = "CHANGE ENGINE";
      change.setAttribute("aria-label", "Change this Instrument's synthesis engine");
      change.addEventListener("click", onEngineChange);
      bar.append(change);
    }
    return bar;
  }

  // Physical Sound input accounting.
  //
  // The former rAF range coalescer owned this diagnostic while also queueing
  // writes. Physical Chrome delivered input at frame cadence, so it coalesced
  // nothing (1007 events -> 0 coalesced) while letting a queued pointer sample
  // outlive a preset/project/history boundary and overwrite a later direct
  // write. The queue is retired; the accounting stays here, where the input
  // actually happens, and never defers or reorders a write.
  const inputAccounting = {
    rangeInputEvents: 0,
    enumInputEvents: 0,
    committedMutations: 0,
    unchangedMutations: 0,
    rejectedMutations: 0,
    lastParameterId: null,
    lastValue: null,
  };

  function soundInputSnapshot() {
    return Object.freeze({
      version: 2,
      owner: "sound-edit-renderer",
      coalescing: "retired",
      ...inputAccounting,
    });
  }

  function writeProductionParameter(slot, parameterId, value, source) {
    if (source === "a4-sound-range") inputAccounting.rangeInputEvents += 1;
    else inputAccounting.enumInputEvents += 1;
    inputAccounting.lastParameterId = String(parameterId);
    inputAccounting.lastValue = value;
    let result;
    try {
      // Direct canonical write. Every physical Sound input reaches ProjectStore
      // in the order the user produced it, so a later write always wins.
      result = globalThis.BRKTRKStores.project.setProductionInstrumentParameter(slot, parameterId, value, {
        source,
        transient: source === "a4-sound-range",
      });
    } catch (error) {
      inputAccounting.rejectedMutations += 1;
      throw error;
    }
    if (result?.mutated) inputAccounting.committedMutations += 1;
    else inputAccounting.unchangedMutations += 1;
    return result;
  }

  // Engines order their parameters by signal flow and tag each with a `group`
  // (OSC / FILTER / ENV / AMP ...). Until now every control went into one flat
  // grid and repeated its own group name as a hint underneath - for an engine
  // like BRK Modal, 89 undifferentiated controls each captioned with the
  // section it belongs to. Grouping is what the metadata was for.
  //
  // `ui.groupLabels` is part of brk-sound-ui-profile-v1 and was read by nothing
  // before this. It supplies the human label; the raw key is the fallback.
  function groupedControls(controls, ui = {}) {
    const order = [];
    const byGroup = new Map();
    for (const parameter of controls) {
      const key = String(parameter.group ?? "").trim();
      if (!byGroup.has(key)) {
        byGroup.set(key, []);
        // First appearance decides section order, so the engine's own signal
        // flow survives rather than being alphabetised into nonsense.
        order.push(key);
      }
      byGroup.get(key).push(parameter);
    }
    return order.map((key) => {
      const declaredLabel = key ? String(ui?.groupLabels?.[key] ?? "").trim() : "";
      return Object.freeze({
        key,
        label: key ? (declaredLabel || key) : null,
        controls: Object.freeze(byGroup.get(key)),
      });
    });
  }

  // The engine already says which section every control belongs to, and BRKTRK
  // read that metadata only to print a heading. Spending the existing palette
  // on it turns a long parameter list into a signal path you can scan.
  //
  // An engine that declares no sections yields one unlabelled group and gets no
  // accent at all: colour here is metadata made visible, never decoration
  // invented on top of an engine that did not ask for one.
  const SECTION_ACCENTS = Object.freeze(["var(--cyan)", "var(--pink)", "var(--amber)", "var(--green)"]);

  function sectionAccent(group, index) {
    if (!group?.label) return null;
    return SECTION_ACCENTS[Number(index) % SECTION_ACCENTS.length];
  }

  function parameterControl(slot, instrument, parameter, ui, view = null, { knob = false } = {}) {
    const value = normalizedValue(parameter, instrument);
    const card = document.createElement("div");
    card.className = "a4a-param";
    card.dataset.productionParam = parameter.id;
    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = String(parameter.name ?? parameter.label ?? parameter.id);
    const output = document.createElement("output");
    output.textContent = displayValue(parameter, value, ui, view);
    header.append(title, output);
    card.append(header);

    const labels = enumLabels(parameter, ui);
    if (labels.length) {
      // A list of options gets no track, because dragging one does nothing.
      // It keeps the native select so a 30-entry shape list still opens the
      // platform picker instead of forcing 30 taps through a cycle button.
      card.dataset.control = "enum";
      const select = document.createElement("select");
      select.setAttribute("aria-label", title.textContent);
      labels.forEach((label, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = label;
        select.append(option);
      });
      select.value = String(enumIndexFromNormalized(value, labels.length));
      select.addEventListener("change", () => {
        const normalized = normalizedFromEnumIndex(Number(select.value), labels.length);
        output.textContent = displayValue(parameter, normalized, ui, view);
        writeProductionParameter(slot, parameter.id, normalized, "a4-sound-enum");
        if (parameter.id === "filter_mode") {
          refreshFilterAvailability(document.querySelector("#instrumentInspector"),
            globalThis.BRKTRKStores.project.getState().instrumentPool?.[slot], view);
        }
      });
      card.append(select);
    } else {
      if (knob) card.dataset.control = "knob";
      else card.dataset.control = "range";
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "1";
      input.step = "0.001";
      input.value = String(value);
      input.setAttribute("aria-label", title.textContent);
      if (knob) input.className = "a4a-knob-input";
      let wheel = null;
      input.addEventListener("input", () => {
        const normalized = clamp01(input.value);
        output.textContent = displayValue(parameter, normalized, ui, view);
        applyFill(card, input, parameter, normalized, ui, view);
        paintKnob(wheel, normalized);
        input.setAttribute("aria-valuetext", output.textContent);
        writeProductionParameter(slot, parameter.id, normalized, "a4-sound-range");
      });
      if (knob) {
        wheel = document.createElement("div");
        wheel.className = "a4a-knob-wheel";
        wheel.title = "Drag up/down to adjust · Shift for fine · double-click/tap to reset";
        const dial = document.createElement("span");
        dial.className = "a4a-knob-dial";
        const needle = document.createElement("span");
        needle.className = "a4a-knob-needle";
        wheel.append(dial, needle, input);
        let drag = null;
        let lastTap = 0;
        wheel.addEventListener("pointerdown", (event) => {
          if (event.button !== 0 || drag) return;
          drag = {
            id: event.pointerId, type: event.pointerType, startY: event.clientY,
            lastY: event.clientY, value: clamp01(input.value), changed: false,
          };
          input.focus({ preventScroll: true });
          try { wheel.setPointerCapture?.(event.pointerId); } catch { /* synthetic/unsupported pointer */ }
          event.preventDefault();
        });
        wheel.addEventListener("pointermove", (event) => {
          if (!drag || event.pointerId !== drag.id) return;
          // A finger has real touch jitter. A tap should never become a drag
          // until the pointer travels at least six CSS pixels.
          if (drag.type === "touch" && !drag.changed
              && Math.abs(event.clientY - drag.startY) < 6) return;
          // Accumulate incremental deltas so toggling Shift midway cannot
          // re-interpret previous motion or jump the control backwards.
          drag.value = knobDragValue(drag.value, drag.lastY - event.clientY, event.shiftKey);
          drag.lastY = event.clientY;
          if (Math.abs(drag.value - Number(input.value)) < 0.0005) return;
          drag.changed = true;
          lastTap = 0;
          input.value = String(drag.value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          event.preventDefault();
        });
        const finish = (event) => {
          if (!drag || event.pointerId !== drag.id) return;
          const moved = drag.changed;
          drag = null;
          try { if (wheel.hasPointerCapture?.(event.pointerId)) wheel.releasePointerCapture(event.pointerId); } catch {}
          if (moved) {
            // The native range 'change' event closes InputSafety's gesture,
            // publishing its already-written last sample to persistence once.
            // Re-writing an identical value here would be a no-op and leave
            // the hidden range gesture pending (lost durability on reload).
            input.dispatchEvent(new Event("change", { bubbles: true }));
          } else if (event.type === "pointerup" && event.pointerType === "touch") {
            const now = Date.now();
            if (now - lastTap < 350) {
              lastTap = 0;
              const original = defaultNormalized(parameter);
              if (Math.abs(Number(input.value) - original) > 1e-9) {
                input.value = String(original);
                output.textContent = displayValue(parameter, original, ui, view);
                applyFill(card, input, parameter, original, ui, view);
                paintKnob(wheel, original);
                input.setAttribute("aria-valuetext", output.textContent);
                writeProductionParameter(slot, parameter.id, original, "a4-sound-default-reset");
              }
            } else lastTap = now;
          }
        };
        wheel.addEventListener("pointerup", finish);
        wheel.addEventListener("pointercancel", finish);
        card.append(wheel);
        paintKnob(wheel, value);
      } else card.append(input);
      input.setAttribute("aria-valuetext", output.textContent);
      applyFill(card, input, parameter, value, ui, view);

      // Returning a control to its default is near-universal in plugins and was
      // missing here. The notch makes it discoverable: you can see where it
      // will land before you do it. The write is an ordinary committed
      // parameter change, so it undoes like any other.
      card.addEventListener("dblclick", (event) => {
        event.preventDefault();
        const fallback = defaultNormalized(parameter);
        if (Math.abs(clamp01(input.value) - fallback) < 1e-9) return;
        input.value = String(fallback);
        output.textContent = displayValue(parameter, fallback, ui, view);
        applyFill(card, input, parameter, fallback, ui, view);
        paintKnob(wheel, fallback);
        input.setAttribute("aria-valuetext", output.textContent);
        writeProductionParameter(slot, parameter.id, fallback, "a4-sound-default-reset");
      });
    }

    // `parameter.group` is deliberately absent: it names the section this
    // control already sits in, and repeating it under every control is the
    // noise that made a large engine unreadable.
    const hintText = [parameter.mapping, parameter.signalPosition].filter(Boolean).join(" · ");
    if (hintText) {
      const hint = document.createElement("small");
      hint.textContent = hintText;
      // The row is narrow enough to clip a long mapping, so the full text stays
      // reachable instead of being silently truncated away.
      card.title = hintText;
      card.append(hint);
    }
    return card;
  }

  // Switching engines is a structural Instrument replacement, never a patch
  // preset load. The old engine's opaque state and parameter IDs have no
  // meaning in the new ABI. Require stopped transport, a verified exact
  // package, and an explicit second confirmation of reset.
  function transportStoppedForEngineSwap() {
    const snapshot = globalThis.BRKTRKStores?.transport?.runtime?.snapshot?.() ?? null;
    return snapshot?.phase === "stopped" && snapshot?.playing === false;
  }

  function renderEngineReplacePanel({ slot, originalView, rerender }) {
    const stores = globalThis.BRKTRKStores;
    const host = globalThis.BRKTRKProductionEngineHost;
    const panel = document.createElement("section");
    panel.className = "a4a-engine-replace-panel";
    panel.dataset.engineReplaceSlot = String(slot);
    const title = document.createElement("strong");
    title.textContent = "CHANGE ENGINE";
    const warning = document.createElement("small");
    warning.textContent = "Resets sound, patch, presets and engine-specific assets. Undo restores the previous sound.";
    const row = document.createElement("div");
    row.className = "a4a-engine-replace-row";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "New engine for existing Instrument");
    const candidates = host.catalogCandidates();
    const choices = catalogEngineChoices(candidates).filter(choice => {
      if (!choice.compatible) return false;
      const next = candidates[choice.index]?.entry;
      return next?.packageSha256 !== originalView.entry.packageSha256;
    });
    for (const choice of choices) {
      const option = document.createElement("option");
      option.value = String(choice.index);
      option.textContent = choice.label;
      option.dataset.engineVersion = choice.version;
      select.append(option);
    }
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = "REPLACE ENGINE";
    confirm.disabled = choices.length === 0;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "CANCEL";
    const status = document.createElement("small");
    status.className = "a4a-engine-replace-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = choices.length
      ? "STOP playback before replacing the engine"
      : "NO OTHER COMPATIBLE ENGINES";
    let armedIndex = null, busy = false;
    function resetConfirmation() {
      armedIndex = null;
      confirm.textContent = "REPLACE ENGINE";
      panel.dataset.engineReplaceArmed = "false";
    }
    select.addEventListener("change", resetConfirmation);
    cancel.addEventListener("click", () => { if (!busy) panel.remove(); });
    confirm.addEventListener("click", async () => {
      if (busy) return;
      const candidate = selectedCatalogCandidate(candidates, select.value);
      if (!candidate || candidate.entry.packageSha256 === originalView.entry.packageSha256) return;
      if (!transportStoppedForEngineSwap()) {
        resetConfirmation();
        status.textContent = "STOP playback to change the engine";
        return;
      }
      const current = stores.project.getState().instrumentPool?.[slot];
      if (!current || current.engineRef?.resolvedPackageSha256 !== originalView.entry.packageSha256) {
        status.textContent = "Instrument changed; reopen the engine selector";
        confirm.disabled = true;
        return;
      }
      if (armedIndex !== select.value) {
        armedIndex = select.value;
        confirm.textContent = "CONFIRM RESET";
        panel.dataset.engineReplaceArmed = "true";
        status.textContent = "Confirm replacing this Instrument's sound. Undo will restore it.";
        return;
      }
      busy = true;
      select.disabled = true;
      confirm.disabled = true;
      cancel.disabled = true;
      status.textContent = "VERIFYING NEW ENGINE…";
      try {
        const entry = candidate.entry;
        const nextView = await host.ensurePackageView({
          moduleId: entry.moduleId,
          engineId: entry.engineId,
          requestedVersion: entry.version,
          resolvedVersion: entry.version,
          resolvedPackageSha256: entry.packageSha256,
          channel: entry.channel ?? "stable",
        }, { channel: entry.channel ?? "stable" });
        if (!panel.isConnected) return;
        if (!transportStoppedForEngineSwap()) throw new Error("Playback started during verification; stop and confirm again");
        const latest = stores.project.getState().instrumentPool?.[slot];
        if (!latest || latest.engineRef?.resolvedPackageSha256 !== originalView.entry.packageSha256) {
          throw new Error("Instrument changed during verification; open the selector again");
        }
        if (nextView.entry.packageSha256 !== entry.packageSha256) throw new Error("Verified engine identity changed");
        stores.project.replaceProductionInstrumentEngine(slot, buildCreationInput(nextView, slot), { source: "sound.engine.replace" });
        rerender();
      } catch (error) {
        if (panel.isConnected) {
          status.textContent = `ENGINE NOT CHANGED · ${String(error?.message ?? error)}`;
          status.classList.add("a4a-error");
        }
      } finally {
        busy = false;
        if (panel.isConnected) {
          resetConfirmation();
          select.disabled = false;
          confirm.disabled = false;
          cancel.disabled = false;
        }
      }
    });
    row.append(select, confirm, cancel);
    panel.append(title, warning, row, status);
    return panel;
  }

  function renderVerifiedInstrument(inspector, slot, instrument, view) {
    const shell = document.createElement("div");
    shell.className = "a4a-sound-shell";
    shell.dataset.productionInstrument = String(slot);
    shell.dataset.enginePackage = view.entry.packageSha256;
    const rerender = () => renderVerifiedInstrument(inspector, slot, globalThis.BRKTRKStores.project.getState().instrumentPool?.[slot] ?? instrument, view);
    const bar = toolbar(slot, instrument, view, () => {
      const previous = shell.querySelector(".a4a-engine-replace-panel");
      if (previous) { previous.remove(); return; }
      bar.after(renderEngineReplacePanel({ slot, originalView: view, rerender }));
    });
    shell.append(bar);

    const samplePanel = globalThis.BRKTRKSampleAssetSurface?.renderPanel?.({
      slot,
      instrument,
      view,
      rerender,
    }) ?? null;
    if (samplePanel) shell.append(samplePanel);

    presetSurface().then((surface) => {
      if (inspector.firstElementChild !== shell) return;
      const panel = surface.renderPresetPanel({
        slot,
        instrument: globalThis.BRKTRKStores.project.getState().instrumentPool?.[slot] ?? instrument,
        view,
        rerender,
      });
      if (panel && inspector.firstElementChild === shell) bar.after(panel);
    }).catch((error) => console.warn("A4B preset surface unavailable", error));

    const pages = Array.isArray(view.ui?.pages) && view.ui.pages.length ? view.ui.pages : [{ id: "all", label: "All", mode: "all" }];
    const pageKey = `${slot}\u0000${view.entry.packageSha256}`;
    const requested = activePages.get(pageKey) ?? PERFORMANCE_PAGE;
    const active = requested === PERFORMANCE_PAGE || pages.some((page) => page.id === requested)
      ? requested : PERFORMANCE_PAGE;
    const pageTabs = document.createElement("div");
    pageTabs.className = "a4a-page-tabs";
    pageTabs.setAttribute("aria-label", "Sound editor pages");
    for (const page of [{ id: PERFORMANCE_PAGE, label: "PLAY" }, ...pages]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = String(page.label ?? page.id);
      button.setAttribute("aria-pressed", String(page.id === active));
      button.addEventListener("click", () => { activePages.set(pageKey, page.id); rerender(); });
      pageTabs.append(button);
    }
    shell.append(pageTabs);

    const performance = active === PERFORMANCE_PAGE;
    const { controls } = performance
      ? { controls: performanceControls(view) }
      : pageControls(view, active);
    const groups = performance
      ? [{ key: "performance", label: "PLAY CONTROLS", controls }]
      : groupedControls(controls, view.ui ?? {});
    for (const group of groups) {
      // An engine that declares no groups yields exactly one unlabelled group,
      // so it still renders as the single flat grid it does today.
      const section = document.createElement("section");
      section.className = "a4a-param-group";
      section.dataset.parameterGroup = group.key;
      if (group.label) {
        const heading = document.createElement("h4");
        heading.className = "a4a-param-group-title";
        heading.textContent = group.label;
        section.append(heading);
      }
      const accent = sectionAccent(group, groups.indexOf(group));
      if (accent) {
        section.style.setProperty("--a4a-accent", accent);
        section.dataset.sectionAccent = String(groups.indexOf(group) % SECTION_ACCENTS.length);
      }
      const grid = document.createElement("div");
      grid.className = "a4a-parameter-grid";
      grid.dataset.layout = performance ? "performance" : "detail";
      group.controls.forEach((parameter) => grid.append(parameterControl(slot, instrument, parameter, view.ui ?? {}, view, { knob: performance })));
      section.append(grid);
      shell.append(section);
    }
    shell.dataset.parameterGroups = String(groups.filter((group) => group.label).length);
    inspector.replaceChildren(shell);
    refreshFilterAvailability(inspector, instrument, view);
    document.body.dataset.productionSoundState = "ready";
    document.body.dataset.productionSoundInstrument = String(slot);
    document.body.dataset.productionSoundEngine = `${view.entry.moduleId}/${view.entry.engineId}@${view.entry.version}`;
    refreshCardSelection({ focus: false });
    return shell;
  }

  async function createFromCatalog(slot, entry, button, status) {
    const host = globalThis.BRKTRKProductionEngineHost;
    const stores = globalThis.BRKTRKStores;
    button.disabled = true;
    status.textContent = "VERIFYING PACKAGE…";
    try {
      const view = await host.ensurePackageView({
        moduleId: entry.moduleId,
        engineId: entry.engineId,
        requestedVersion: entry.version,
        resolvedVersion: entry.version,
        resolvedPackageSha256: entry.packageSha256,
        channel: entry.channel ?? "stable",
      }, { channel: entry.channel ?? "stable" });
      stores.project.createProductionInstrument(slot, buildCreationInput(view, slot), { source: "a4-sound-create" });
      status.textContent = "CREATED";
      renderProductionSurface();
    } catch (error) {
      console.error(error);
      status.textContent = `CREATE FAILED · ${String(error?.message ?? error)}`;
      status.classList.add("a4a-error");
      button.disabled = false;
    }
  }

  function catalogCandidatePresentation(candidate) {
    const entry = candidate?.entry ?? {};
    const compatibility = candidate?.compatibility ?? {};
    const compatible = compatibility.compatible === true;
    const identity = `${String(entry.engineId ?? "unknown")} · ${String(entry.version ?? "?")}`;
    const code = String(compatibility.code ?? "compatibility-unknown");
    const reason = String(compatibility.reason ?? "Host compatibility is unavailable");
    return Object.freeze({
      compatible,
      disabled: !compatible,
      label: compatible ? identity : `${identity} · unavailable · ${code}: ${reason}`,
      status: compatible ? "Verified package will create this Instrument" : `UNAVAILABLE · ${code} · ${reason}`,
      code,
      reason,
    });
  }

  // The Create picker listed every catalog row flat, one per VERSION, each
  // labelled "<engine> · <version>". Picking an engine therefore meant reading
  // the engine name several times and choosing a release candidate by hand,
  // when the answer is nearly always "the newest one that runs here".
  //
  // Grouping by engine says the engine name once, and ordering each group
  // newest-first puts that answer at the top. Older versions stay listed
  // underneath, because an Instrument pinned to an exact version (#474) must
  // still be creatable; they are just no longer the thing you have to hunt past.
  // The Create path resolves one channel (`resolveCatalogEntry` filters on it,
  // defaulting to stable) while `catalogCandidates()` reports compatibility
  // without ever reading `channel`. So a compatible preview or dev entry can be
  // offered, and with newest-first ordering it would be the PRESELECTED one —
  // and Create would then fail with `package-unavailable` on the row the panel
  // put under the user's thumb. The picker offers only what Create can build.
  function catalogPickerGroups(candidates = [], { channel } = {}) {
    const defaultChannel = globalThis.BRKTRKEnginePackageDomain?.DEFAULT_CHANNEL ?? "stable";
    const declaredChannels = channel == null
      ? globalThis.BRKTRKProductionEngineHost?.catalogChannels?.() ?? [defaultChannel]
      : Array.isArray(channel) ? channel : [channel];
    const resolvable = new Set(
      declaredChannels.map((value) => String(value ?? "").trim()).filter(Boolean),
    );
    if (resolvable.size === 0) resolvable.add(defaultChannel);
    const order = [];
    const byEngine = new Map();
    candidates.forEach((candidate, index) => {
      const entry = candidate?.entry ?? {};
      // Catalog normalization always fills `channel`, so an entry without one
      // is what normalization would have made it, not a wildcard.
      if (!resolvable.has(String(entry.channel ?? defaultChannel))) return;
      const key = `${entry.moduleId ?? "?"}\u0000${entry.engineId ?? "?"}`;
      if (!byEngine.has(key)) {
        byEngine.set(key, []);
        order.push(key);
      }
      byEngine.get(key).push({ index, candidate, entry });
    });
    // An engineId shared by two modules has to say which module it came from,
    // or the two groups are indistinguishable.
    const engineIdCounts = new Map();
    for (const key of order) {
      const engineId = String(key.split("\u0000")[1]);
      engineIdCounts.set(engineId, (engineIdCounts.get(engineId) ?? 0) + 1);
    }
    const compare = globalThis.BRKTRKEnginePackageDomain?.compareVersions
      ?? ((left, right) => String(left).localeCompare(String(right)));
    return Object.freeze(order.map((key) => {
      const [moduleId, engineId] = key.split("\u0000");
      const members = byEngine.get(key).slice();
      members.sort((left, right) => compare(String(right.entry.version ?? ""), String(left.entry.version ?? "")));
      return Object.freeze({
        label: (engineIdCounts.get(engineId) ?? 0) > 1 ? `${moduleId} · ${engineId}` : engineId,
        options: Object.freeze(members.map((member) => {
          const presentation = catalogCandidatePresentation(member.candidate);
          return Object.freeze({
            index: member.index,
            version: String(member.entry.version ?? "?"),
            // The engine name is the group's label, so a row that runs here is
            // just its version. A row that cannot run is disabled, so selecting
            // it can never update the status line and its title is unreachable
            // on touch — its own label is the only place its reason can live.
            label: presentation.compatible
              ? String(member.entry.version ?? "?")
              : `${member.entry.version ?? "?"} · unavailable · ${presentation.code}: ${presentation.reason}`,
            compatible: presentation.compatible,
            disabled: presentation.disabled,
            code: presentation.code,
            status: presentation.status,
          });
        })),
      });
    }));
  }

  // The newest compatible version of the first engine that has one: what the
  // owner reaches for, already selected, so Create is one tap away. Returns -1
  // when nothing here can run, which is what decides the button's wording - a
  // fallback index would say CREATE over a catalog that cannot create anything.
  function defaultCatalogIndex(groups = []) {
    for (const group of groups) {
      const option = group.options.find((candidate) => candidate.compatible);
      if (option) return option.index;
    }
    return -1;
  }

  // One choice per engine. The exact version is resolved once from the
  // published, compatible channel; CREATE still pins that package identity.
  function catalogEngineChoices(candidates = [], options = {}) {
    return Object.freeze(catalogPickerGroups(candidates, options).map((group) => {
      const entry = group.options.find((option) => option.compatible) ?? group.options[0];
      return Object.freeze({ ...entry, label: entry.compatible ? group.label.toUpperCase().replaceAll("-", " ") : `${group.label} · unavailable · ${entry.code}` });
    }));
  }

  async function prefetchCatalogEngine(candidate) {
    if (!candidate?.compatibility?.compatible) return null;
    const entry = candidate.entry;
    return globalThis.BRKTRKProductionEngineHost.ensurePackageView({
      moduleId: entry.moduleId, engineId: entry.engineId,
      requestedVersion: entry.version, resolvedVersion: entry.version,
      resolvedPackageSha256: entry.packageSha256,
      channel: entry.channel ?? "stable",
    }, { channel: entry.channel ?? "stable" });
  }

  function selectedCatalogCandidate(candidates, value) {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) return null;
    const candidate = candidates[index];
    return candidate?.compatibility?.compatible === true ? candidate : null;
  }

  function renderCreatePanel(inspector, slot) {
    inspector.querySelector(".a4a-create-panel")?.remove();
    const panel = document.createElement("div");
    panel.className = "a4a-create-panel";
    panel.dataset.productionSlot = String(slot);
    const title = document.createElement("strong");
    title.textContent = `PRODUCTION INSTRUMENT ${Number(slot).toString(16).toUpperCase().padStart(2, "0")}`;
    const row = document.createElement("div");
    row.className = "a4a-create-row";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Production synth engine");
    const candidates = globalThis.BRKTRKProductionEngineHost.catalogCandidates();
    const choices = catalogEngineChoices(candidates);
    const identityOf = (candidate) => {
      const entry = candidate?.entry ?? {};
      return `${entry.engineId ?? "?"} ${entry.version ?? "?"}`;
    };
    for (const entry of choices) {
        const option = document.createElement("option");
        option.value = String(entry.index);
        option.textContent = entry.label;
        option.disabled = entry.disabled;
        option.dataset.compatibilityCode = entry.code;
        option.dataset.engineVersion = entry.version;
        option.title = entry.status;
        select.append(option);
    }
    const firstCompatibleIndex = choices.find((entry) => entry.compatible)?.index ?? -1;
    const fallbackIndex = choices[0]?.index ?? -1;
    if (firstCompatibleIndex >= 0) select.value = String(firstCompatibleIndex);
    else if (fallbackIndex >= 0) select.value = String(fallbackIndex);
    select.disabled = candidates.length === 0;
    panel.dataset.enginePickerGroups = String(choices.length);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = firstCompatibleIndex >= 0 ? "CREATE" : candidates.length ? "NO COMPATIBLE ENGINES" : "NO ENGINES";
    const status = document.createElement("span");
    status.className = "a4a-sound-state";

    const refresh = () => {
      const index = Number(select.value);
      const candidate = Number.isInteger(index) ? candidates[index] ?? null : null;
      if (!candidate) {
        button.disabled = true;
        status.textContent = candidates.length ? "NO COMPATIBLE ENGINES" : "Loading trusted engine catalog…";
        status.classList.toggle("a4a-error", candidates.length > 0);
        return;
      }
      const presentation = catalogCandidatePresentation(candidate);
      button.disabled = !presentation.compatible;
      button.textContent = presentation.compatible ? "CREATE" : "NO COMPATIBLE ENGINES";
      // A collapsed <select> shows the selected OPTION's text, never its
      // optgroup label, so the group's name would vanish the moment the picker
      // closed. The status line is always visible and already tracks the
      // selection, so the engine is named there.
      status.textContent = `${identityOf(candidate)} · ${presentation.status}`;
      status.classList.toggle("a4a-error", !presentation.compatible);
    };

    select.addEventListener("change", () => {
      refresh();
      const selected = select.value;
      prefetchCatalogEngine(selectedCatalogCandidate(candidates, selected)).catch((error) => {
        if (!panel.isConnected || select.value !== selected) return;
        status.textContent = `ENGINE LOAD FAILED · ${String(error?.message ?? error)}`;
        status.classList.add("a4a-error");
      });
    });
    refresh();
    button.addEventListener("click", () => {
      const candidate = selectedCatalogCandidate(candidates, select.value);
      if (!candidate) { refresh(); return; }
      createFromCatalog(slot, candidate.entry, button, status);
    });
    row.append(select, button);
    panel.append(title, row, status);
    inspector.prepend(panel);
    return panel;
  }

  async function ensureCatalog() {
    const host = globalThis.BRKTRKProductionEngineHost;
    if (!host) return [];
    const existing = host.catalogCandidates();
    if (existing.length || host.snapshot?.().catalog) return existing;
    if (!catalogPromise) {
      catalogPromise = host.refreshCatalog()
        .then(() => host.catalogCandidates())
        .finally(() => { catalogPromise = null; });
    }
    return catalogPromise;
  }

  function panelOrTrue(inspector) { return Boolean(inspector.querySelector(".a4a-create-panel")); }

  function renderProductionSurface() {
    if (typeof document === "undefined") return false;
    const stores = globalThis.BRKTRKStores;
    const host = globalThis.BRKTRKProductionEngineHost;
    const inspector = document.querySelector("#instrumentInspector");
    if (!stores?.project || !host || !inspector) return false;
    ensureStyle();
    // HARD-03 (#376). This function replaces the inspector's children, which
    // is how a preset panel becomes detached. Telling the panel registry here
    // means the release happens at the moment of the detach, including the
    // cases that mount no replacement panel at all - an empty slot, a
    // recovery panel, a switch away from Sound. The surface is a lazy import,
    // so it is asked only if it is loaded.
    globalThis.BRKTRKSoundPresetSurface?.disposeDetachedPanels?.();
    const slot = Math.max(0, Math.min(255, Number(state.instrument) || 0));
    const instrument = stores.project.getState().instrumentPool?.[slot] ?? null;
    const token = ++renderToken;

    if (!instrument) {
      renderCreatePanel(inspector, slot);
      ensureCatalog()
        .then(() => { if (token === renderToken && !stores.project.getState().instrumentPool?.[slot]) renderCreatePanel(inspector, slot); })
        .catch((error) => {
          if (token !== renderToken) return;
          const panel = renderCreatePanel(inspector, slot);
          const status = panel.querySelector(".a4a-sound-state");
          if (status) { status.textContent = `ENGINE CATALOG UNAVAILABLE · ${String(error?.message ?? error)}`; status.classList.add("a4a-error"); }
        });
      document.body.dataset.productionSoundState = "empty";
      document.body.dataset.productionSoundInstrument = String(slot);
      return panelOrTrue(inspector);
    }

    const loading = document.createElement("div");
    loading.className = "a4a-create-panel";
    loading.textContent = `VERIFYING ${instrument.engineRef.engineId}@${instrument.engineRef.resolvedVersion ?? instrument.engineRef.requestedVersion ?? "?"}…`;
    inspector.replaceChildren(loading);
    document.body.dataset.productionSoundState = "loading";
    const loadVerified = () => host.ensurePackageView(instrument.engineRef).then((view) => {
      if (token !== renderToken || stores.project.getState().instrumentPool?.[slot]?.engineRef?.resolvedPackageSha256 !== instrument.engineRef.resolvedPackageSha256) return view;
      renderVerifiedInstrument(inspector, slot, stores.project.getState().instrumentPool[slot], view);
      return view;
    });
    loadVerified().catch((error) => {
      if (token !== renderToken) return;
      document.body.dataset.productionSoundState = "error";
      presetSurface().then((surface) => surface.renderRecoveryPanel({
        inspector,
        instrument,
        error,
        retry: async () => {
          if (token !== renderToken) return;
          await loadVerified();
        },
      })).catch(() => {
        loading.textContent = `PRODUCTION ENGINE UNAVAILABLE · ${String(error?.message ?? error)}`;
        loading.classList.add("a4a-error");
      });
    });
    return true;
  }

  function renderSelection(mutation, options = {}) {
    const before = mutationContext(mutation, "Before");
    const after = mutationContext(mutation, "After");
    const delta = selectionDelta(before, after);
    if (delta.instrumentChanged) renderProductionSurface();
    refreshCardSelection(options);
    if (typeof renderInspectorIdentity === "function") renderInspectorIdentity();
    globalThis.BRKTRKTouchActions?.refresh?.();
    globalThis.BRKTRKCommandBindings?.refreshNoteDock?.();
    if (typeof document !== "undefined") {
      const count = Number(document.body.dataset.targetedSoundSelections || 0) + 1;
      document.body.dataset.targetedSoundSelections = String(count);
      document.body.dataset.targetedSoundInstrument = String(after.instrument ?? state.instrument);
      document.body.dataset.targetedSoundParameter = String(after.soundParam ?? state.p3?.soundParam ?? 0);
      return Object.freeze({ ...delta, count });
    }
    return delta;
  }

  function renderProjectMutation(changeSet = {}) {
    const production = productionParameter(changeSet);
    if (!production) return false;
    if (typeof document === "undefined" || Number(state.instrument) !== production.instrumentId) return false;
    const card = document.querySelector(`#instrumentInspector .a4a-param[data-production-param="${CSS.escape(production.parameterId)}"]`);
    if (!card) return false;
    const instrument = globalThis.BRKTRKStores?.project?.getState?.()?.instrumentPool?.[production.instrumentId];
    const view = globalThis.BRKTRKProductionEngineHost?.interactionFor?.(instrument?.engineRef, production.parameterId);
    const input = card.querySelector('input[type="range"]');
    const select = card.querySelector("select");
    const output = card.querySelector("output");
    const value = clamp01(changeSet.after);
    if (input && Number(input.value) !== value) input.value = String(value);
    // A targeted re-render draws the same fill the full render would, so a
    // store-driven value change (preset load, undo) moves the bar too.
    if (input && view) applyFill(card, input, view.parameter, value, view.ui ?? {}, view);
    if (input) paintKnob(card.querySelector(".a4a-knob-wheel"), value);
    if (select && view) {
      const labels = enumLabels(view.parameter, view.ui ?? {});
      if (labels.length) select.value = String(enumIndexFromNormalized(value, labels.length));
    }
    if (output) output.textContent = view ? displayValue(view.parameter, value, view.ui ?? {}, view) : `${Math.round(value * 100)}%`;
    if (input) input.setAttribute?.("aria-valuetext", output?.textContent ?? `${Math.round(value * 100)}%`);
    if (production.parameterId === "filter_mode") {
      const current = globalThis.BRKTRKStores.project.getState().instrumentPool?.[production.instrumentId];
      const inspector = document.querySelector("#instrumentInspector");
      const fullView = globalThis.BRKTRKProductionEngineHost?.verifiedPackageViewFor?.(current?.engineRef);
      if (inspector && fullView) refreshFilterAvailability(inspector, current, fullView);
    }
    const count = Number(document.body.dataset.targetedProductionSoundParameterRenders || 0) + 1;
    document.body.dataset.targetedProductionSoundParameterRenders = String(count);
    document.body.dataset.targetedProductionSoundParameterTarget = `${production.instrumentId}:${production.parameterId}`;
    return Object.freeze({ ...production, value, count });
  }

  function renderStructuralField(descriptor, cursor) {
    if (!descriptor || !cursor) return false;
    if (descriptor.pane === "song") return globalThis.BRKTRKStructuralRenderer?.renderSongCell?.(cursor.row, cursor.col) ?? false;
    if (descriptor.pane === "chain") return globalThis.BRKTRKStructuralRenderer?.renderChainRow?.(state.chain, cursor.row) ?? false;
    if (descriptor.pane === "phrase") return globalThis.BRKTRKPhraseStepRenderer?.render?.(state.phrase, cursor.row) ?? false;
    return false;
  }

  function renderFieldCompletion(mutation, options = {}) {
    if (!mutation?.mutated) return Object.freeze({ rendered: false, count: Number(document?.body?.dataset?.targetedFieldCompletions || 0) });
    const descriptor = mutation.descriptor;
    const cursor = options.cursor ?? state.focus;
    let rendered = true;
    if (!mutation.projectChangeSet && !mutation.navigationChangeSet) rendered = renderStructuralField(descriptor, cursor);
    if (typeof renderTrackerCursor === "function") {
      const context = globalThis.BRKTRKStores?.navigation?.captureContext?.() ?? {};
      renderTrackerCursor({ contextBefore: context, contextAfter: context });
    }
    globalThis.BRKTRKTouchActions?.refresh?.();
    globalThis.BRKTRKCommandBindings?.refreshNoteDock?.();
    if (options.focus !== false) globalThis.BRKTRKCommandBindings?.focusSelectedCell?.();
    const count = Number(document?.body?.dataset?.targetedFieldCompletions || 0) + 1;
    if (document?.body) {
      document.body.dataset.targetedFieldCompletions = String(count);
      document.body.dataset.targetedFieldDescriptor = descriptor?.id ?? "unknown";
    }
    return Object.freeze({ rendered, count, descriptor: descriptor?.id ?? null });
  }

  let descriptorSubscription = null;
  function initialize() {
    if (!globalThis.BRKTRKStores?.project || !globalThis.BRKTRKProductionEngineHost) return false;
    globalThis.renderInstrumentParameters = renderProductionSurface;
    // The Worklet answers the descriptor request asynchronously, so the reply
    // routinely lands after this surface has drawn. Nothing else redraws on its
    // own, so without this the controls keep their percentage fallback until an
    // unrelated interaction happens to redraw them.
    if (!descriptorSubscription) {
      descriptorSubscription = globalThis.BRKTRKProductionEngineHost.onEngineDescriptorsChanged?.(() => {
        renderProductionSurface();
      }) ?? null;
    }
    renderProductionSurface();
    // Warm the default published engine without creating project data or
    // resuming browser audio. Existing Instruments keep their exact packages.
    ensureCatalog().then((candidates) => {
      const choice = catalogEngineChoices(candidates).find((entry) => entry.compatible);
      return prefetchCatalogEngine(choice ? candidates[choice.index] : null);
    }).catch((error) => console.warn("Default engine preload failed", error));
    return true;
  }

  const api = Object.freeze({
    soundInputSnapshot,
    writeProductionParameter,
    selectionDelta,
    parameterCount,
    selectedParameterContext,
    normalizeParameterInput,
    parameterStep,
    productionParameter,
    enumLabels,
    normalizedValue,
    normalizedFromEnumIndex,
    enumIndexFromNormalized,
    plainFromNormalized,
    displayValue,
    defaultNormalized,
    zeroAnchor,
    fillGeometry,
    sectionAccent,
    pageControls,
    performanceControls,
    knobDragValue,
    groupedControls,
    buildCreationInput,
    transportStoppedForEngineSwap,
    catalogCandidatePresentation,
    catalogPickerGroups,
    catalogEngineChoices,
    prefetchCatalogEngine,
    defaultCatalogIndex,
    selectedCatalogCandidate,
    refreshCardSelection,
    renderSelection,
    renderProjectMutation,
    renderFieldCompletion,
    renderProductionSurface,
    initialize,
  });
  globalThis.BRKTRKSoundEditRenderer = api;
  queueMicrotask(() => initialize());
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
