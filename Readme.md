# Ferenc

A browser groovebox for **single-cycle waveforms, wavetables and granular sources**, with an
Elektron-style step sequencer (parameter locks, trig conditions, micro-timing) and **Web MIDI in/out**.
The panel layout follows the Digitakt II workflow (8 encoders, TRIG/SRC/FLTR/AMP/FX/MOD pages,
16 trig keys, FUNC combos). It's widened to landscape so the screen is usable with a mouse.

No build step and no dependencies: plain ES modules plus an AudioWorklet.

## Run

```sh
python3 -m http.server 8080      # or: npm start
# open http://localhost:8080 and press POWER ON
```

AudioWorklets and Web MIDI need `http://localhost` or `https://`. Opening `index.html` from
`file://` does not work. To host it: **Settings → Pages → Deploy from branch → `main` / root**.
The app is static and needs nothing else.

Browsers: Chrome / Edge (full), Firefox (MIDI asks permission). Safari has no Web MIDI.

## What's in the box

| Machine | Use | SRC parameters |
|---|---|---|
| **WAVE** | single cycles and wavetables as a band-limited oscillator | TUNE FINE SMP WPOS (table position) UNI (1-7 voice unison) DTUN SPRD LEV |
| **SMPL** | classic sample playback | TUNE FINE SMP STRT END MODE (FWD/REV/LOOP/RLOOP/PING) LPOS LEV |
| **GRAN** | granular cloud (Microgranny / P-6 direction) | POS SIZE DENS SPRY SCAN (2nd page: PJIT JMOD RVRS WIN PSPR EMIT LEV) |

Per track: SVF filter (LP2/LP4/BP/HP/notch) with its own ADSR, amp ADSR/AHD, bit reduction,
sample-rate reduction, overdrive, 2 LFOs (8 waves, free/trig/one-shot, tempo sync, fade-in,
12 destinations), delay and reverb sends. Polyphony 1-8 per track (mono + glide for leads and basses).

**Single cycles** (≤ 4096 samples, e.g. AKWF's 600-sample waves) are detected automatically. Their
WAV sample rate is read from the header so the cycle length stays exact. Each cycle is resynthesised
into mip-mapped, band-limited tables, so bright waves don't alias at high notes. Serum-style
wavetables (`clm` chunk) load as multi-frame tables you can scan with WPOS. The type of any slot can
be flipped between cycle and sample in the SAMPLES menu.

**Sequencer**: 8 tracks × up to 64 steps, per-track length and scale (polymeter), master length,
swing, micro-timing, probability, conditions (FILL, 1ST, A:B), note length up to INF, and live
recording with optional quantize. It has 64 patterns in 4 banks with queued switching, a song chain,
copy/paste/clear with undo, and a 96 PPQN clock that keeps running in background tabs.

**MIDI**: notes drive the active track, or a fixed track per channel. CC 16-23 = knobs A-H, plus a
fixed map (74 cutoff, 71 reso, 73/72/75 attack/release/decay, 76-79 grain params, 64 sustain,
pitch bend, program change selects a pattern). Sequencer notes can go out per track (INT OFF makes
a MIDI-only track). Clock and transport in/out, thru.

Ships with generated factory sounds (basic shapes, organ, vox formant, PWM/FM/shapes wavetables,
a granular texture, glass, kick, snare, noise) and a demo pattern. Your samples and project
autosave in the browser (IndexedDB). EXPORT writes one JSON file with the samples embedded.

## Controls

Press `?` in the app for the full reference. The short version:

- **Page buttons** select what knobs A-H edit. Press again for page 2. **FUNC + SRC** switches the machine.
- **Knobs**: drag (Shift = fine), wheel or trackpad, double-click resets.
- **Trig keys**: click toggles a step. Long-press, right-click or FUNC+click selects a step, and then
  knob moves become **parameter locks** for that step (amber). NO releases the selection.
- **TRK** + key = track, **PTN** + key = pattern, **KB** = keys become a scale keyboard, **PAGE** = steps 17-64 (hold = FILL).
- **FUNC + REC / PLAY / STOP** = copy / clear / paste. **NO** right after that undoes it.

### Keyboard-first editing (Tab toggles EDIT / PLAY)

```
EDIT   1 2 3 4 5 6        TRIG SRC FLTR AMP FX MOD (again = page 2)   7 delay/reverb  8 mixer  9 seq  0 samples
        Q W E R           knobs A B C D   ┐ hold the key and move the mouse up/down (no click needed),
        A S D F   G       knobs E F G H   ┘ or tap to select, then scroll / arrow keys      G = preview note
         Z X C V B N M ,  tracks 1-8 (Shift = mute)                    Backspace = reset selected param
PLAY   A W S E D F T G Y H U J K O L P = notes, Z/X octave, 1-8 tracks
both   Space play/pause · Shift = FUNC / fine · Enter YES · Esc NO · [ ] step page
```

## Code map

```
index.html, css/panel.css   panel markup / styling
js/params.js                every parameter: range, default, display format, DSP conversion, pages, CC map
js/audio/worklet.js         DSP: voices, WAVE/SMPL/GRAN sources, SVF, envelopes, LFOs, sends (AudioWorklet)
js/audio/engine.js          AudioContext graph: worklet, ping-pong delay, convolution reverb, limiter
js/audio/wavetable.js       FFT + band-limited mip-map builder
js/pool.js, js/factory.js   sample slots, WAV sniffing / decoding, generated factory sounds
js/sequencer.js             lookahead scheduler, conditions, swing, live record, MIDI clock
js/midi.js                  Web MIDI I/O
js/app.js                   controller: modes, buttons, p-locks, notes, persistence, keyboard
js/ui/*                     knob widget, screen visualisations, menus
test/engine.test.mjs        headless DSP + sequencer tests (`npm test`, Node ≥ 18)
```

Roadmap toward a full granular instrument (Microgranny / Roland P-6 feature set): [docs/ROADMAP.md](docs/ROADMAP.md).
