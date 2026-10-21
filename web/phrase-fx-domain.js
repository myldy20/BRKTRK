(() => {
  const SLOT_COUNT = 3;
  const COMMAND_CODE_MIN = 0x00;
  const COMMAND_CODE_MAX = 0xFF;
  const VALUE_MIN = 0x00;
  const VALUE_MAX = 0xFF;
  const SLOT_VERSION = 1;

  const COMMANDS = Object.freeze([
    Object.freeze({
      id: "none",
      code: 0x00,
      label: "---",
      valueKind: "none",
      runtimeStatus: "empty",
      consumer: null,
    }),
    Object.freeze({
      id: "cut",
      code: 0x01,
      label: "CUT",
      valueKind: "byte",
      runtimeStatus: "active",
      consumer: "M4.1C",
    }),
    Object.freeze({
      id: "delay",
      code: 0x04,
      label: "DLY",
      valueKind: "byte",
      runtimeStatus: "active",
      consumer: "M4.1C",
    }),
    Object.freeze({
      id: "retrigger",
      code: 0x05,
      label: "RET",
      valueKind: "byte",
      runtimeStatus: "partial",
      consumer: "M4.1C",
    }),
  ]);

  const COMMAND_BY_ID = new Map(COMMANDS.map((entry) => [entry.id, entry]));
  const COMMAND_BY_CODE = new Map(COMMANDS.map((entry) => [entry.code, entry]));

  const integer = (value, label) => {
    const numeric = Number(value);
    if (!Number.isInteger(numeric)) throw new TypeError(`${label} must be an integer`);
    return numeric;
  };

  const byte = (value, label) => {
    const numeric = integer(value, label);
    if (numeric < 0 || numeric > 0xFF) throw new RangeError(`${label} must be 00-FF`);
    return numeric;
  };

  function commandDescriptor(command) {
    if (typeof command === "string") return COMMAND_BY_ID.get(command.toLowerCase()) ?? null;
    const code = byte(command, "FX command");
    return COMMAND_BY_CODE.get(code) ?? null;
  }

  function normalizeCommandCode(command) {
    if (typeof command === "string") {
      const descriptor = commandDescriptor(command);
      if (!descriptor) throw new RangeError(`Unknown FX command id: ${command}`);
      return descriptor.code;
    }
    return byte(command, "FX command");
  }

  function createSlot(command = 0, value = 0) {
    const commandCode = normalizeCommandCode(command);
    const descriptor = COMMAND_BY_CODE.get(commandCode) ?? null;
    const normalizedValue = descriptor?.valueKind === "none" ? 0 : byte(value, "FX value");
    return Object.freeze({
      slotVersion: SLOT_VERSION,
      commandCode,
      commandId: descriptor?.id ?? null,
      value: normalizedValue,
      known: Boolean(descriptor),
      runtimeStatus: descriptor?.runtimeStatus ?? "unknown-inert",
    });
  }

  function normalizeSlot(value = 0) {
    if (typeof value === "number") return createSlot(value, 0);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Phrase FX slot must be a legacy command byte or slot object");
    }
    if (Object.hasOwn(value, "commandCode")) return createSlot(value.commandCode, value.value ?? 0);
    if (Object.hasOwn(value, "command")) return createSlot(value.command, value.value ?? 0);
    if (Object.hasOwn(value, "commandId")) return createSlot(value.commandId, value.value ?? 0);
    throw new TypeError("Phrase FX slot requires commandCode, command or commandId");
  }

  function normalizeSlots(value = []) {
    const source = Array.isArray(value) ? value : [];
    return Object.freeze(Array.from({ length: SLOT_COUNT }, (_, index) => normalizeSlot(source[index] ?? 0)));
  }

  function serializeSlot(value) {
    const slot = normalizeSlot(value);
    return Object.freeze({ command: slot.commandCode, value: slot.value });
  }

  function serializeSlots(value) {
    return Object.freeze(normalizeSlots(value).map(serializeSlot));
  }

  function migrateLegacySlots(legacyFx = []) {
    const slots = normalizeSlots(legacyFx);
    const issues = [];
    slots.forEach((slot, index) => {
      if (slot.commandCode !== 0 && !slot.known) {
        issues.push(Object.freeze({
          kind: "unknown-legacy-command",
          slot: index,
          commandCode: slot.commandCode,
          preserved: true,
        }));
      }
    });
    return Object.freeze({
      slots,
      issues: Object.freeze(issues),
      lossy: false,
    });
  }

  function registry() {
    return COMMANDS;
  }

  function assertRegistry() {
    if (COMMANDS.length !== new Set(COMMANDS.map((entry) => entry.id)).size) throw new Error("Duplicate FX command id");
    if (COMMANDS.length !== new Set(COMMANDS.map((entry) => entry.code)).size) throw new Error("Duplicate FX command code");
    if (COMMAND_BY_CODE.get(0)?.id !== "none") throw new Error("FX command 00 must remain NONE");
    for (const entry of COMMANDS) {
      if (entry.code < COMMAND_CODE_MIN || entry.code > COMMAND_CODE_MAX) throw new Error(`FX command out of byte range: ${entry.id}`);
      if (!Object.isFrozen(entry)) throw new Error(`FX registry entry must be immutable: ${entry.id}`);
    }
    return true;
  }

  const api = Object.freeze({
    SLOT_COUNT,
    SLOT_VERSION,
    COMMAND_CODE_MIN,
    COMMAND_CODE_MAX,
    VALUE_MIN,
    VALUE_MAX,
    registry,
    commandDescriptor,
    createSlot,
    normalizeSlot,
    normalizeSlots,
    serializeSlot,
    serializeSlots,
    migrateLegacySlots,
    assertRegistry,
  });

  assertRegistry();
  globalThis.BRKTRKPhraseFxDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
