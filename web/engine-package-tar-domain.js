(() => {
  "use strict";

  const loaderDomain = globalThis.BRKTRKEnginePackageLoader
    ?? (typeof module !== "undefined" && module.exports ? require("./engine-package-loader.js") : null);
  if (!loaderDomain) throw new Error("BRKTRK engine package tar domain requires engine-package-loader.js");

  const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
  const MAX_TAR_FILES = 512;

  class EnginePackageTarError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "EnginePackageTarError";
      this.code = String(code || "engine-package-tar-error");
      this.details = Object.freeze({ ...details });
    }
  }

  const ascii = (bytes) => String.fromCharCode(...bytes).replace(/\0.*$/s, "").trim();
  const align512 = (size) => Math.ceil(size / 512) * 512;

  function octal(bytes, label) {
    const text = ascii(bytes).replace(/^0+/, "") || "0";
    if (!/^[0-7]+$/.test(text)) throw new EnginePackageTarError("invalid-tar", `${label} is not octal`);
    return Number.parseInt(text, 8);
  }

  function safeArchivePath(value) {
    const path = String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!path || path.startsWith("/") || path.includes("\0")) throw new EnginePackageTarError("unsafe-tar-path", `unsafe tar path ${value}`);
    const parts = path.split("/").filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) throw new EnginePackageTarError("unsafe-tar-path", `unsafe tar path ${value}`);
    return parts.join("/");
  }

  function tarChecksum(header) {
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 32 : header[index];
    return sum;
  }

  function parseTar(value, { maxFiles = MAX_TAR_FILES, maxExpandedBytes = MAX_EXPANDED_BYTES } = {}) {
    const bytes = loaderDomain.bytes(value);
    if (bytes.byteLength > maxExpandedBytes) throw new EnginePackageTarError("expanded-too-large", `expanded engine package exceeds ${maxExpandedBytes} bytes`);
    const files = {};
    let offset = 0;
    let fileCount = 0;
    let root = null;

    while (offset + 512 <= bytes.byteLength) {
      const header = bytes.subarray(offset, offset + 512);
      if (header.every((item) => item === 0)) break;
      const expectedChecksum = octal(header.subarray(148, 156), "tar checksum");
      if (tarChecksum(header) !== expectedChecksum) throw new EnginePackageTarError("invalid-tar-checksum", "tar header checksum mismatch");
      const name = ascii(header.subarray(0, 100));
      const prefix = ascii(header.subarray(345, 500));
      const path = safeArchivePath(prefix ? `${prefix}/${name}` : name);
      const size = octal(header.subarray(124, 136), `tar size for ${path}`);
      const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
      if (["1", "2"].includes(type)) throw new EnginePackageTarError("tar-link-forbidden", `links are forbidden in engine package: ${path}`);
      const contentStart = offset + 512;
      const contentEnd = contentStart + size;
      if (contentEnd > bytes.byteLength) throw new EnginePackageTarError("truncated-tar", `tar member ${path} is truncated`);

      if (type === "0") {
        fileCount += 1;
        if (fileCount > maxFiles) throw new EnginePackageTarError("too-many-files", `engine package exceeds ${maxFiles} files`);
        const parts = path.split("/");
        if (!root) root = parts[0];
        if (parts[0] !== root || parts.length < 2) throw new EnginePackageTarError("invalid-package-root", "engine package must contain one rooted directory");
        const relative = parts.slice(1).join("/");
        if (Object.hasOwn(files, relative)) throw new EnginePackageTarError("duplicate-tar-path", `duplicate engine package file ${relative}`);
        files[relative] = bytes.slice(contentStart, contentEnd);
      } else if (type !== "5") {
        throw new EnginePackageTarError("unsupported-tar-entry", `unsupported tar entry type ${type} for ${path}`);
      }
      offset = contentStart + align512(size);
    }

    if (!root || !Object.hasOwn(files, "brk-package.json")) throw new EnginePackageTarError("missing-manifest", "engine package is missing brk-package.json");
    let manifest;
    try { manifest = JSON.parse(new TextDecoder().decode(files["brk-package.json"])); }
    catch (error) { throw new EnginePackageTarError("invalid-manifest-json", "brk-package.json is invalid JSON", { message: String(error?.message ?? error) }); }
    delete files["brk-package.json"];
    return Object.freeze({ root, manifest, files: Object.freeze(files), fileCount });
  }

  async function readStreamWithLimit(stream, limit, label) {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = loaderDomain.bytes(value);
      total += chunk.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch {}
        throw new EnginePackageTarError("payload-too-large", `${label} exceeds ${limit} bytes`);
      }
      chunks.push(chunk);
    }
    const result = new Uint8Array(total);
    let write = 0;
    for (const chunk of chunks) { result.set(chunk, write); write += chunk.byteLength; }
    return result;
  }

  async function gunzip(value, { maxExpandedBytes = MAX_EXPANDED_BYTES } = {}) {
    if (typeof DecompressionStream !== "function") throw new EnginePackageTarError("gzip-unavailable", "DecompressionStream(gzip) is unavailable");
    const stream = new Blob([loaderDomain.bytes(value)]).stream().pipeThrough(new DecompressionStream("gzip"));
    return readStreamWithLimit(stream, maxExpandedBytes, "expanded engine package");
  }

  const api = Object.freeze({ MAX_EXPANDED_BYTES, MAX_TAR_FILES, EnginePackageTarError, safeArchivePath, parseTar, readStreamWithLimit, gunzip });
  globalThis.BRKTRKEnginePackageTarDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
