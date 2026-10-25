# BRK Modal parity harness

Status: **P1A implemented; external RipplerX reference capture pending**

The parity harness turns “sounds similar” into a repeatable comparison matrix. It does not claim that BRK Modal already matches every RipplerX preset.

## Build and render the candidate matrix

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
./build/brk_modal_parity build/parity-output
```

Generated files:

```text
build/parity-output/
  cases.csv
  metrics.csv
  candidate/
    string.wav
    beam.wav
    squared.wav
    membrane.wav
    plate.wav
    drumhead.wav
    marimba.wav
    open_tube.wav
    closed_tube.wav
    dual_parallel.wav
    dual_serial.wav
    low_note.wav
    high_note.wav
    soft_velocity.wav
    hard_velocity.wav
```

`metrics.csv` records:

- peak;
- transient RMS (0–50 ms);
- body RMS (50–500 ms);
- tail RMS;
- spectral centroid;
- approximate T30 decay;
- stereo difference RMS.

## Add RipplerX references

Export matched RipplerX renders as PCM WAV using the exact filenames from `cases.csv` and place them in:

```text
build/parity-output/reference/
```

Reference capture rules:

- 48 kHz;
- no DAW effects or track processing;
- note begins at sample zero;
- note release at 0.8 seconds;
- total render length 3 seconds;
- normalize nothing;
- stereo output retained;
- use the init/parameter settings documented for the matching case.

The current harness describes the candidate cases and filenames. Exact RipplerX automation/preset capture notes will be frozen after the first real reference export pass.

## Compare

```bash
python3 tools/compare_parity.py build/parity-output
```

The comparator:

- reads PCM 16/24/32-bit WAV;
- resamples candidate audio to the reference rate when necessary;
- onset-aligns the pair;
- level-matches the first 500 ms;
- reports correlation and normalized RMSE;
- reports transient/body/tail level deltas;
- reports spectral-centroid delta.

Output:

```text
build/parity-output/comparison.csv
```

The script uses only the Python standard library.

## Automated smoke test

CTest renders a two-case smoke matrix:

```bash
ctest --test-dir build --output-on-failure
```

This catches broken model rendering, file output and metrics generation. It is not a substitute for the full external reference matrix.

## P1 corrections already applied

Source inspection identified several P0 mismatches that materially affected timbre. P1 corrects:

- Beam ratio generation to the 8×8 model calculation;
- Membrane and Plate mode ordering and normalization;
- Drumhead ratios to the documented Bessel-root table;
- Marimba ratios to the analyzed modal table;
- default model gains to unity for the nine supported reference models;
- default inharmonicity offset so `0.0001` is effectively harmonic;
- source-style 20 ms comb stereoizer;
- source-style serial modal frequency splitting;
- tube waveguide decay calibration.

These changes improve structural parity. Actual numerical and listening parity remains gated on external RipplerX reference WAVs.
