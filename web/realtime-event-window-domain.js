(function initRealtimeEventWindowDomain() {
  "use strict";

  const WINDOW_VERSION = 1;
  const DEFAULT_PACKET_CAPACITY = 4096;
  const DEFAULT_EVENT_CAPACITY = 131072;
  const DEFAULT_SAME_FRAME_EVENT_CAPACITY = 131072;
  const DEFAULT_QUALITY_TIER = "full";

  function positiveInteger(value, fallback, label) {
    if (value === undefined || value === null) return fallback;
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer`);
    return value;
  }

  function normalizeBudget(candidate = {}) {
    const source = candidate && typeof candidate === "object" ? candidate : {};
    const qualityTier = typeof source.qualityTier === "string" && source.qualityTier.trim()
      ? source.qualityTier.trim()
      : DEFAULT_QUALITY_TIER;
    return Object.freeze({
      windowVersion: WINDOW_VERSION,
      qualityTier,
      packetCapacity: positiveInteger(source.packetCapacity, DEFAULT_PACKET_CAPACITY, "packetCapacity"),
      eventCapacity: positiveInteger(source.eventCapacity, DEFAULT_EVENT_CAPACITY, "eventCapacity"),
      sameFrameEventCapacity: positiveInteger(
        source.sameFrameEventCapacity,
        DEFAULT_SAME_FRAME_EVENT_CAPACITY,
        "sameFrameEventCapacity",
      ),
    });
  }

  const DEFAULT_BUDGET = normalizeBudget();

  class RealtimeWindowError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "RealtimeWindowError";
      this.code = code;
      this.details = Object.freeze({ ...details });
    }
  }

  class RealtimeEventWindow {
    constructor(candidateBudget = DEFAULT_BUDGET) {
      this.budget = normalizeBudget(candidateBudget);
      this.packets = new Array(this.budget.packetCapacity);
      this.packetCount = 0;
      this.eventCount = 0;
      this.lastPacketFrame = null;
      this.startFrame = 0;
      this.endFrame = 0;
      this.frameCount = 0;
      this.active = false;
      this.previousEndFrame = null;
      this.highWaterPackets = 0;
      this.highWaterEvents = 0;
      this.lateEventCount = 0;
      this.overrunCount = 0;
      this.underrunCount = 0;
      this.renderOverlapCount = 0;
      this.lastUnderrunFrames = 0;
      this.lastRenderOverlapFrames = 0;
      this.lastErrorCode = null;
    }

    clearPackets() {
      for (let index = 0; index < this.packetCount; index += 1) this.packets[index] = undefined;
      this.packetCount = 0;
      this.eventCount = 0;
      this.lastPacketFrame = null;
    }

    resetContinuity() {
      this.clearPackets();
      this.active = false;
      this.previousEndFrame = null;
      this.lastUnderrunFrames = 0;
      this.lastRenderOverlapFrames = 0;
      this.lastErrorCode = null;
      return this;
    }

    begin(startFrame, frameCount) {
      if (!Number.isSafeInteger(startFrame) || startFrame < 0) throw new RangeError("startFrame must be a non-negative safe integer");
      if (!Number.isSafeInteger(frameCount) || frameCount <= 0) throw new RangeError("frameCount must be a positive safe integer");
      const endFrame = startFrame + frameCount;
      if (!Number.isSafeInteger(endFrame)) throw new RangeError("render window end frame exceeds safe integer range");

      this.lastUnderrunFrames = 0;
      this.lastRenderOverlapFrames = 0;
      if (Number.isSafeInteger(this.previousEndFrame)) {
        if (startFrame > this.previousEndFrame) {
          this.underrunCount += 1;
          this.lastUnderrunFrames = startFrame - this.previousEndFrame;
        } else if (startFrame < this.previousEndFrame) {
          this.renderOverlapCount += 1;
          this.lastRenderOverlapFrames = this.previousEndFrame - startFrame;
        }
      }

      this.clearPackets();
      this.startFrame = startFrame;
      this.endFrame = endFrame;
      this.frameCount = frameCount;
      this.active = true;
      this.lastErrorCode = null;
      return this;
    }

    fail(code, message, details) {
      this.lastErrorCode = code;
      throw new RealtimeWindowError(code, message, details);
    }

    assertSameFrameDemand(demand, packetFrame) {
      if (!Number.isSafeInteger(demand) || demand < 0) this.fail("invalid-demand", "same-frame demand must be a non-negative safe integer");
      if (demand <= this.budget.sameFrameEventCapacity) return demand;
      this.overrunCount += 1;
      this.fail("same-frame-overrun", "same-frame event demand exceeds the realtime budget", {
        demand,
        capacity: this.budget.sameFrameEventCapacity,
        packetFrame,
      });
    }

    reserveFrame(packetFrame, packetEvents = 0) {
      if (!this.active) this.fail("window-inactive", "realtime event window is not active");
      if (!Number.isSafeInteger(packetFrame)) this.fail("invalid-packet", "event trace packet requires a safe integer frame");
      if (!Number.isSafeInteger(packetEvents) || packetEvents < 0) this.fail("invalid-demand", "event trace packet event count must be a non-negative safe integer");
      if (packetFrame < this.startFrame) {
        this.lateEventCount += 1;
        this.fail("late-event", "event trace packet arrived before the active render window", {
          packetFrame,
          windowStartFrame: this.startFrame,
        });
      }
      if (packetFrame >= this.endFrame) {
        this.fail("outside-window", "event trace packet is outside the active render window", {
          packetFrame,
          windowStartFrame: this.startFrame,
          windowEndFrame: this.endFrame,
        });
      }
      if (this.packetCount > 0 && packetFrame <= this.lastPacketFrame) {
        this.fail("non-monotonic-packet", "event trace packets must be strictly increasing within a render window", {
          packetFrame,
          previousFrame: this.lastPacketFrame,
        });
      }
      this.assertSameFrameDemand(packetEvents, packetFrame);
      if (this.packetCount + 1 > this.budget.packetCapacity) {
        this.overrunCount += 1;
        this.fail("packet-overrun", "render-block packet demand exceeds the realtime budget", {
          demand: this.packetCount + 1,
          capacity: this.budget.packetCapacity,
          packetFrame,
        });
      }
      if (this.eventCount + packetEvents > this.budget.eventCapacity) {
        this.overrunCount += 1;
        this.fail("event-overrun", "render-block event demand exceeds the realtime budget", {
          demand: this.eventCount + packetEvents,
          capacity: this.budget.eventCapacity,
          packetFrame,
        });
      }

      this.packetCount += 1;
      this.eventCount += packetEvents;
      this.lastPacketFrame = packetFrame;
      if (this.packetCount > this.highWaterPackets) this.highWaterPackets = this.packetCount;
      if (this.eventCount > this.highWaterEvents) this.highWaterEvents = this.eventCount;
      return packetEvents;
    }

    push(packet) {
      if (!packet || typeof packet !== "object" || !Number.isSafeInteger(packet.frame)) {
        this.fail("invalid-packet", "event trace packet requires a safe integer frame");
      }
      const packetEvents = Array.isArray(packet.events) ? packet.events.length : 0;
      this.reserveFrame(packet.frame, packetEvents);
      this.packets[this.packetCount - 1] = packet;
      return packet;
    }

    finish() {
      if (!this.active) return this;
      this.previousEndFrame = this.endFrame;
      this.active = false;
      return this;
    }

    packetAt(index) {
      if (!Number.isInteger(index) || index < 0 || index >= this.packetCount) return null;
      return this.packets[index] ?? null;
    }

    budgetSnapshot() {
      return this.budget;
    }

    diagnosticSnapshot() {
      return Object.freeze({
        windowVersion: WINDOW_VERSION,
        startFrame: this.startFrame,
        endFrame: this.endFrame,
        frameCount: this.frameCount,
        packetCount: this.packetCount,
        eventCount: this.eventCount,
        highWaterPackets: this.highWaterPackets,
        highWaterEvents: this.highWaterEvents,
        lateEventCount: this.lateEventCount,
        overrunCount: this.overrunCount,
        underrunCount: this.underrunCount,
        renderOverlapCount: this.renderOverlapCount,
        lastUnderrunFrames: this.lastUnderrunFrames,
        lastRenderOverlapFrames: this.lastRenderOverlapFrames,
        lastErrorCode: this.lastErrorCode,
      });
    }
  }

  function createRealtimeEventWindow(candidateBudget) {
    return new RealtimeEventWindow(candidateBudget);
  }

  const api = Object.freeze({
    WINDOW_VERSION,
    DEFAULT_PACKET_CAPACITY,
    DEFAULT_EVENT_CAPACITY,
    DEFAULT_SAME_FRAME_EVENT_CAPACITY,
    DEFAULT_QUALITY_TIER,
    DEFAULT_BUDGET,
    RealtimeWindowError,
    RealtimeEventWindow,
    normalizeBudget,
    createRealtimeEventWindow,
  });

  if (typeof globalThis !== "undefined") globalThis.BRKTRKRealtimeEventWindowDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
