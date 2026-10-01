# Roadmap: from wave/sample groovebox to granular instrument

Target: a **Microgranny-style hands-on granular voice** and a **Roland P-6-style sampler workflow**
(sample, chop, play the slices granularly from pads, resample) inside the existing panel and
sequencer. Order is by value per effort (80/20 first).

## Where v1 stands

Phase 1, shipped in the first PR:

- Engine with WAVE (mip-mapped single cycles and wavetables, unison), SMPL, and GRAN (async/sync emission, position/size/density/spray/scan, pitch jitter free/octave/oct+5th, reverse probability, 6 window shapes, pan spread).
- Every grain parameter is p-lockable per step and LFO-modulatable (POS, SIZE, DENS, SPRY). That already covers the "each step a different grain" P-6 trick.
- Sequencer, p-locks, conditions, MIDI I/O and clock, keyboard-first editing, persistence and export.
- Worst-case CPU (48 voices, 176 unison oscillators, 256 grains): about 26% of one core. There's headroom for everything below without WASM.

| Feature | Microgranny 2 | Roland P-6 | Ferenc v1 |
|---|---|---|---|
| Grain size / position / shift speed | ✓ | ✓ | ✓ SIZE / POS / SCAN |
| Bit crush / rate reduce | ✓ | – | ✓ BR / SRR |
| Start/end region for grains | ✓ | ✓ | ✗ → phase 3 |
| Tuned (pitched) grain loop | ✓ | – | partial (EMIT SYNC) → phase 3 |
| Record from mic/line | ✓ | ✓ | ✗ → phase 2 |
| Resample internal output | – | ✓ | ✗ → phase 2 |
| Chop / slice to pads | – | ✓ | ✗ → phase 2 |
| Step sequencer with motion rec | – | ✓ | seq ✓, motion rec → phase 4 |
| Per-step parameter locks | – | partial | ✓ |
| Wavetable oscillators | – | – | ✓ |

## Phase 2: get sound in (sampler core, P-6)

1. **Library browser for big single-cycle collections.** Use the File System Access API
   (`showDirectoryPicker`): browse thousands of waves (AKWF, Oxford Overdrive) without loading
   them into the 128 slots. ▲▼ audition on the current track, YES pins one to a slot. The SMP knob
   can also scan the library folder directly. *Highest value for the existing wave collection.*
2. **Sampling from IN L/R** (mic/line through `getUserMedia`) with an AudioWorklet recorder:
   arm, threshold auto-start, max 60 s, auto trim/normalise, saved to a slot and IndexedDB.
3. **Resampling**: record the master or a single track (post-FX) into a new slot.
   Granular textures printed back into the pool, then granulated again.
4. **Chop**: auto-slice by transients, equal 4/8/16, or manual markers. Slices map to trig keys in
   KB mode and get a `SLIC` param on SMPL/GRAN (p-lockable, so every step can pick a slice).
5. **Waveform editor on the screen**: zoom, drag STRT/END/LPOS/POS markers with the mouse,
   zero-crossing snap.

## Phase 3: granular depth (Microgranny and beyond)

1. **Grain region**: STRT/END for GRAN so SCAN loops inside a window (Microgranny start/end).
2. **Freeze / hold**: latch the scan position. FUNC+YES on the GRAN page.
3. **Tuned grains**: density and size key-track the note, which gives pitched pulsar/buzz tones
   (Microgranny tuned mode). Also a "grain = n cycles" mode for single cycles in GRAN.
4. **Live granular**: grains read from a rolling input buffer (Clouds/Beads style), with
   feedback and freeze.
5. **Cycle extraction**: pull N single cycles out of a long sample (pitch detect plus
   zero-crossing alignment) and build a WAVE wavetable from them. This bridges the two collections.
6. Grain pitch quantised to the KB scale, continuous window morph, per-grain filter cutoff spread,
   stereo rotation.

## Phase 4: performance and sequencing

1. **Motion recording**: knob moves while REC + PLAY become p-locks on the passing steps.
2. **Retrigs/ratchets, chord trigs** (several notes per step), slide trigs.
3. **Scenes / crossfader**: morph all params between two snapshots (Octatrack style). Well suited to granular.
4. **MIDI learn + controller templates** (map hardware encoders, e.g. a Digitakt II, as a control
   surface). Also MIDI-only tracks with CC locks to sequence external gear.
5. Arpeggiator, per-step LFO retrigger.
6. **Bounce to WAV**: render a pattern or the song through an `OfflineAudioContext`. This is what
   turns jams into releasable material.

## Phase 5: platform

- PWA (installable, offline), tablet layout (multi-touch already works through pointer events).
- Zip export of project plus samples, and sharing sample packs.
- WASM/SIMD DSP only if profiling shows a need. SharedArrayBuffer for visualisation.

## Suggested order

1. Library browser (phase 2.1)
2. Grain region + freeze (3.1, 3.2)
3. Sampling + resampling (2.2, 2.3)
4. Motion recording (4.1)
5. Bounce to WAV (4.6)
6. Chop (2.4)
7. Tuned grains (3.3)
8. Live granular (3.4)

Each item is a self-contained PR. The engine already has the hooks it needs: the `engine.out` tap
for resampling and recording, the p-lock pipeline for new params, and `PAGES` in `params.js` for UI pages.
