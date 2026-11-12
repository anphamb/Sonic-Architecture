# Sonic Architecture

Turn sound into architecture in the browser. Bass pours the foundation, mids raise the walls, highs grow the spires.

## Files

```
index.html                 page structure
style.css                  layout and visual design
sketch.js                  audio input, FFT analysis, procedural geometry, export
fonts/archivo.css          Archivo variable font (embedded) + OFL-LICENSE.txt
fonts/marker.css           Permanent Marker font (embedded) + MARKER-LICENSE.txt
vendor/three.bundle.js     three.js r187 + OrbitControls, GLTFExporter, RoomEnvironment
vendor/THREE-LICENSE.txt   three.js MIT licence
NOTE.md                    short submission note
```

No build step and no external requests: every file the page needs is in this folder.

## Run it

- **Quick look:** double-click `index.html`. The demo sound and file upload work; the microphone needs a secure page.
- **With microphone:** serve the folder locally, e.g. `python3 -m http.server` and open `http://localhost:8000`.

## Deploy (pick one)

**Netlify Drop (fastest):** go to app.netlify.com/drop and drag the whole `sonic-architecture` folder onto the page. You get an https link in seconds.

**GitHub Pages:**
1. Create a new public repository and upload all files in this folder (keep `index.html` at the root).
2. Repository **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, folder = `/ (root)`. Save.
3. After a minute the site is live at `https://<username>.github.io/<repository>/`.

**Vercel:** import the repository, framework preset *Other*, no build command, output directory `.`.

All of these serve over https, so the microphone works.

## How it works

1. **Input:** microphone (`getUserMedia` → `AnalyserNode`, sampled 12 times a second), an audio file (`decodeAudioData`), or a demo melody synthesised with `OfflineAudioContext`.
2. **Analysis:** each moment becomes a frame with energy in eight log-spaced bands (30 Hz–16 kHz), loudness, spectral centroid and pitch (harmonic product spectrum). Files are analysed with a hand-written radix-2 FFT when loaded, but nothing is built yet.
3. **Build while playing:** as playback (or recording) reaches each moment it is revealed to the builder. Each word, syllable or note becomes one building: its highest pitch sets the height (higher = taller, held notes keep growing, nothing ever shrinks), bass its width, brightness its facade. Pauses grow parks, new passages open new blocks on a straight street grid.
4. **Modes:** City, Tower, River. **Colours:** Flyer, Pitch (colour by note), Daylight, White model, Night (moon, stars, lamp light).
   **Controls:** microphone picker, 1× / 2× / 4× speed, camera Drag / Follow mouse / Spin, Back to start.
5. **Output:** PNG poster or GLB model. **Back to start** clears the city and rewinds.

Shortcuts: **Space** plays/pauses, **arrow keys** on the section drawing step through moments (**Shift** for 10).

## Credits

- [three.js](https://threejs.org), MIT licence.
- [Archivo](https://fonts.google.com/specimen/Archivo) by Omnibus-Type, SIL Open Font License.
- [Permanent Marker](https://fonts.google.com/specimen/Permanent+Marker) by Font Diner, Apache License 2.0.
- Demo sound is generated in code; no third-party audio is included.
