# BRK Modal upstream factory program source

These are the **28 unmodified factory XML files from RipplerX 1.5.18** by
Tiago Rodrigues (`tiagolr`). The precise public source revision is
`e9f6537e5e3d6c648b2463e6a90f15e5f612bb75`:
https://github.com/tiagolr/ripplerx/tree/e9f6537e5e3d6c648b2463e6a90f15e5f612bb75/resources/presets

Original files: `resources/presets/*.xml`. Imported **byte-for-byte** into
`engines/brk-modal/upstream-factory/resources/presets/`, with 28/28
Git blob SHA matches. Copyright and license remain those of RipplerX:
GNU GPL version 3 (see root `LICENSE` and `PROVENANCE.md`).

The build invokes the checked-in import/generator and Modal state serializer to
produce 28 Reference presets, plus 6 BRK presets, as 768-byte state-v1 blobs.
`scripts/prepare-modal-factory-index.py` derives the **89 actual normalized
parameter values** from each serialized binary state and validates magic,
engine identity, canonical record order, CRC32, and [0,1] bounds. This is needed
by BRKTRK Sound: a binary patch without a complete parameter snapshot is
**unavailable** for applying/editing in its current preset surface.

All source inputs are now in BRKTRK; generation requires no network or private
BRKSNTH repository. This source import does **not** publish the Modal engine or
old private archive. A newly pinned package and production host tests are next.
