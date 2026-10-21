(() => {
  "use strict";

  const DEFAULT = Object.freeze({ probability: 100, every: 1, offset: 0 });
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const integer = (value, fallback) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.round(numeric) : fallback;
  };

  function normalize(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const probability = clamp(integer(source.probability, DEFAULT.probability), 0, 100);
    const every = clamp(integer(source.every, DEFAULT.every), 1, 16);
    const offset = clamp(integer(source.offset, DEFAULT.offset), 0, every - 1);
    return Object.freeze({ probability, every, offset });
  }

  function active(value) {
    const condition = normalize(value);
    return condition.probability !== DEFAULT.probability
      || condition.every !== DEFAULT.every
      || condition.offset !== DEFAULT.offset;
  }

  function badge(value) {
    const condition = normalize(value);
    if (!active(condition)) return "";
    const parts = [];
    if (condition.probability !== 100) parts.push(`${condition.probability}%`);
    if (condition.every !== 1 || condition.offset !== 0) parts.push(`${condition.offset + 1}/${condition.every}`);
    return parts.join("·");
  }

  function title(value) {
    const condition = normalize(value);
    if (!active(condition)) return "Condition · always";
    const probability = condition.probability === 100 ? "probability 100%" : `probability ${condition.probability}%`;
    const iteration = condition.every === 1 && condition.offset === 0
      ? "every iteration"
      : `iteration ${condition.offset + 1} of every ${condition.every}`;
    return `Condition · ${probability} · ${iteration}`;
  }

  const api = Object.freeze({ DEFAULT, normalize, active, badge, title });
  globalThis.BRKTRKPhraseConditionPresentation = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
