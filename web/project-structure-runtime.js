(() => {
  const root = globalThis;
  if (root.BRKTRKProjectStructureRuntime) {
    if (typeof module !== "undefined" && module.exports) module.exports = root.BRKTRKProjectStructureRuntime;
    return;
  }

  const structureTypes = root.BRKTRKProjectStructure
    ?? (typeof require === "function" ? require("./project-structure.js") : null);
  const fields = root.BRKTRKFieldSchema
    ?? (typeof require === "function" ? require("./field-schema.js") : null);
  if (!structureTypes || !fields) throw new Error("Project structure and Field Schema must load before structural runtime");

  function storeFor(env = {}) {
    const store = env.projectStore ?? root.BRKTRKStores?.project;
    if (!store) throw new Error("ProjectStore is required for structural fields");
    return store;
  }

  function domainFor(env = {}) {
    return structureTypes.install(storeFor(env));
  }

  function mutationOptions(options = {}, fallbackSource) {
    return {
      ...options,
      source: options.source ?? fallbackSource,
    };
  }

  function patchDescriptor(descriptor, write) {
    if (!descriptor) throw new Error("Required structural Field Schema descriptor is missing");
    Object.defineProperty(descriptor, "write", {
      value: write,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }

  const songChainRef = fields.resolve("song", 0);
  const chainPhraseRef = fields.resolve("chain", 0);
  const chainTranspose = fields.resolve("chain", 1);

  patchDescriptor(songChainRef, (env, cursor, value, options = {}) => {
    const mutation = domainFor(env).setSongChainRef(
      cursor.row,
      cursor.col,
      value,
      mutationOptions(options, "field.song.chainRef"),
    );
    if (mutation.after >= 0) {
      env.state.chain = mutation.after;
      env.state.lastChain = mutation.after;
    }
    return mutation;
  });

  patchDescriptor(chainPhraseRef, (env, cursor, value, options = {}) => {
    const mutation = domainFor(env).setChainPhraseRef(
      env.state.chain,
      cursor.row,
      value,
      mutationOptions(options, "field.chain.phraseRef"),
    );
    if (mutation.after >= 0) {
      env.state.phrase = mutation.after;
      env.state.lastPhrase = mutation.after;
    }
    return mutation;
  });

  patchDescriptor(chainTranspose, (env, cursor, value, options = {}) => domainFor(env).setChainTranspose(
    env.state.chain,
    cursor.row,
    value,
    mutationOptions(options, "field.chain.transpose"),
  ));

  const browserStore = root.BRKTRKStores?.project ?? null;
  const browserDomain = browserStore ? structureTypes.install(browserStore) : null;
  // Every subtype whose change the structural renderer knows how to draw. A
  // subtype published but not listed here is a render that silently never
  // happens, which is how UX0-03's duplicate-and-repoint first shipped.
  const structuralSubtypes = new Set([
    "song.chainRef",
    "chain.phraseRef",
    "chain.transpose",
    "chain.duplicate-repoint",
    "phrase.duplicate-repoint",
    // A restored snapshot can remove an object navigation is standing on.
    // The renderer clamps before renderAll() allocates it back.
    "history.undo",
    "history.redo",
  ]);
  const disconnect = browserStore?.subscribe?.("render", (changeSet) => {
    if (!structuralSubtypes.has(changeSet?.subtype)) return;
    root.BRKTRKStructuralRenderer?.refreshLinkedEditors?.(changeSet);
  }) ?? (() => {});

  if (root.document?.body) root.document.body.dataset.structureArchitecture = "m4.0a";

  const api = Object.freeze({
    domain: browserDomain,
    domainFor,
    descriptors: Object.freeze({ songChainRef, chainPhraseRef, chainTranspose }),
    disconnect,
  });

  root.BRKTRKProjectStructureRuntime = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
