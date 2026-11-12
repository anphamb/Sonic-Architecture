# Sonic Architecture: submission note

**Live URL:** _add your deployed link here_

## The idea

Sonic Architecture treats sound as a building material instead of something to watch as a waveform. You record with the microphone, load an audio file, or use a built-in demo sound, and a city grows **while the sound plays**: nothing is built before you press play, and every word or note adds a building in real time.

- **Every word, syllable or note becomes a building.** The sound is split where the loudness dips and rises again (the breath between syllables), on sharp onsets, on large pitch leaps and after silences, so speech splits into words and syllables and a melody into notes.
- **Higher pitch builds taller.** The highest voiced pitch reached in the word sets the height (median-filtered so one bad frame cannot spike it), with loudness and bass adding a little, and a held note keeps growing. A building never shrinks or moves once it is standing, so a melody leaves a skyline you can read.
- **Bass builds wide**, brightness chooses the facade (brick and render for dark sounds, glass towers for bright ones).
- **Pauses become small parks**, buildings stand apart with trees between them, and each new passage of the sound opens a new city block. Blocks are laid on a street grid that spirals out from the centre, so roads are straight, meet at clean crossings and never overlap, and a longer sound grows a bigger city.

The same sound can be read three ways: **City**, **Tower** (a skyscraper, one storey per moment, high notes make taller storeys) and **River** (a city growing downstream on both banks of a winding river, with a bridge for every new passage of the sound). Colour schemes include **Pitch**, where each building takes the colour of its note (low notes blue, through green and yellow, to red for high notes), and **Night**, with a moon, stars, lit windows and street lamps casting pools of light. **Back to start** rewinds and clears the city so it can grow again, a **1× / 2× / 4×** button speeds up playback (and the growth with it), the camera can be dragged, set to **follow the mouse**, or **spin**, and a microphone picker chooses between several inputs. Results export as a PNG poster or a GLB 3D model.

## Visual design

The page is styled like a streetwear "drop" flyer: royal blue halftone background, yellow ticket panels with perforated white frames, orange price-tag pill buttons, chunky outlined type, a grunge yellow title (an SVG turbulence filter), marker handwriting, a green starburst sticker and a barcode. Buildings are deliberately low-poly and light (no soft shadows, capped pixel ratio, simple trees) so the page runs on modest laptops and phones.

## Who it might be useful for

- **Design and architecture students** exploring generative form, who want a playful way to see how a single parameter set (a sound) can drive massing, rhythm and ornament.
- **Musicians and sound designers** who want a visual "fingerprint" of a track for cover art, posters or social posts.
- **Teachers** explaining frequency and the spectrum: a quiet hum builds a suburb of small houses, while a loud, bright passage raises glass towers.

## What I explored technically

- **Web Audio API:** `enumerateDevices` + `getUserMedia` with a `deviceId` constraint for choosing a microphone (refreshed on `devicechange`), `playbackRate` for 2× / 4× speed with the play clock scaled to match, `AnalyserNode` for live FFT data, `MediaRecorder` to keep the recording for playback, `AudioBufferSourceNode` for playback with a moving playhead, and `OfflineAudioContext` to synthesise the 16-second demo sound in code (no audio asset needed).
- **FFT frequency analysis and pitch detection:** live analysis uses the browser's analyser; files are analysed offline with my own radix-2 FFT (Hann window, 2048 samples). Both feed one pipeline: eight log-spaced bands (30 Hz–16 kHz), loudness, spectral centroid, and pitch from a harmonic product spectrum with parabolic interpolation. For files the pitch range is stretched to that sound's own lowest and highest notes. A file is analysed in full when loaded but only revealed (built) as playback reaches it; live microphone frames are normalised once against a decaying peak and then frozen, so nothing already built can change.
- **Generative city planning:** word / syllable segmentation (loudness dip-and-rise, spectral-flux onsets, pitch leaps), section segmentation (feature distance against a running mean), a square-spiral block layout with perimeter lots, axis-aligned overlap tests and a reserved courtyard garden per block, and a fixed river meander with at most one bridge per stretch. Analysis runs at 12 frames per second so syllables can be separated. Placement depends only on sound already heard, which I verified with an automated test: over 12,000 built pieces checked across all modes, none moved or shrank as the sound continued.
- **Procedural architecture:** a small grammar of building types (house, apartment, office, glass tower) with podiums, setbacks, balconies, parapets and roof plant; windows are drawn by patching three.js's standard material shader (`onBeforeCompile`) with a per-instance facade attribute (storeys, bays, style), so thousands of buildings get correct window grids without textures, glass windows reflect the environment, and at night random windows light up.
- **Three.js and procedural geometry:** every structure is generated from data with `InstancedMesh` (one draw call per primitive type, tens of thousands of pieces), seeded random numbers so the same sound always produces the same building, soft shadows, a room environment map for lighting, and orbit controls.
- **Interaction:** the "section drawing" strip shows every layer as a column (bass at the bottom). Clicking it jumps playback to that moment and lights up that floor in 3D; arrow keys step through layers.
- **Export:** PNG poster composed on a 2D canvas (high-resolution render + caption + section drawing), and GLB export by baking instanced meshes into vertex-coloured geometry so it opens in Blender or any glTF viewer (windows are a shader effect, so the GLB carries the massing and colours).
- **Deployment basics:** three.js and the font are bundled locally, so the page works offline and even when `index.html` is opened directly from disk (microphone needs https or localhost).

## Accessibility and responsibility

Keyboard-reachable controls with visible focus, a timeline that works as a slider with arrow keys, a live status region, a text description of the generated structure on the canvas, reduced-motion support (no automatic camera spin), and a responsive layout. All audio stays in the browser. three.js (MIT), Archivo (SIL OFL) and Permanent Marker (Apache 2.0) are credited with their licences included.

## What I would improve with more time

- Polyphonic pitch detection, so chords could build clusters instead of following the strongest note.
- Let people draw where the city may grow (a site boundary or river) and have streets adapt to it.
- Beat detection driving structural "events" such as bridges, plazas or setbacks.
- More architectural vocabulary: bridges over gaps of silence, materials from timbre, and a section/elevation SVG export for drawings.
- Export windows into the GLB as real geometry or baked textures.
- A gallery so people can share structures and compare how different songs build.
- Performance tuning on low-end phones (adaptive layer count and shadow resolution).
