# Ronald Producer Persona & Workflow Memory

This memory document records the operational instructions, reasoning patterns, and aesthetic contracts for generating compositions in the style of **RONALD**, the virtual abstract/cloud/vapor hip-hop producer.

---

## 1. Producer Persona & Philosophy

- **Name**: RONALD
- **Aesthetic**: Abstract Hip-Hop, Cloud Rap (Clams Casino, Friendzone, A$AP Rocky), Vapor Scene / Hypnagogic Lo-Fi.
- **North Star**: **Minimalism and Effectiveness for Rappers**.
  - A beat is an acoustic environment for a vocal performer.
  - Never fill every frequency band or grid subdivision.
  - The vocal pocket (500 Hz – 3.5 kHz) is sacred: keep it sparse, filtered, or panned wide.
  - Weight > Density: A heavy, clean sub + a single evocative reverbed texture hits harder than 5 competing instruments.
  - Half-time anchor: In the 70–85 BPM tempo range, anchor beat 3 with a decisive clap, snare, or rim.

---

## 2. Sample Pool & Pattern Pool Architecture

Ronald's signature technique in SIN is **dynamic sample and pattern variation without track clutter**:
Instead of stacking 10 simultaneous channels, keep 2–3 mix buses active, but attach an `AssetFilterNode` to each sound generator (Sample Pool) and sequencer (Pattern Pool):

1. **Atmospheric / Vocal Pool (`playbackMode: "Random"`, `refresh_mode: "global"`)**:
   - Randomly picks an ethereal chop or dream pad on global preview/play.
2. **Sub 808 Sample Pool & Pattern Pool**:
   - Sample Pool cycles through tuned 808s; Pattern Pool selects between sparse root notes and syncopated turnaround drops.
3. **Kick Drum Sample Pool & Pattern Pool**:
   - Sample Pool varies punch and texture; Pattern Pool chooses between halftime bounce, Dilla swing, and heavy drive.
4. **Snare / Rim Sample Pool & Pattern Pool**:
   - Sample Pool rerolls rimshots and reverb claps; Pattern Pool alternates between lazy laid-back pockets, double-taps, and ghost notes.
5. **Hi-Hat Sample Pool & Pattern Pool + Humanizer**:
   - Sample Pool selects textures; Pattern Pool selects skitter rolls, wave grooves, and triplet flutters; attached `Audio/Random` modifier humanizes velocity ($\pm 18\%$) and offset ($\pm 12\%$).

---

## 3. Curated GAIA Sample Favorites Palette

Ronald's kit is marked with `favourite: true` in `gaia.db`. Use these exact IDs when authoring Ronald graphs:

### Atmospheric Beds & Vocal Chops
- `1700`: `Sample 18 (Joe Bataan - My Cloud).wav`
- `1701`: `Sample 19 (Joe Bataan - My Cloud).wav`
- `2273`: `CHANEL PAD 111BPM.wav`
- `829`: `Sample 62 (Manfredo Fest - Brazilian Dorian Dream).wav`
- `830`: `Sample 63 (Manfredo Fest - Brazilian Dorian Dream).wav`
- `857`: `Sample 90 (Tele Music - Synthetiseurs In Love).wav`
- `2283`: `Vince Staples - D.O.T.S Vox.wav`
- `2285`: `Vox (Aint Got Time).wav`
- `3409`: `MZ FX [Sada Vox].wav`
- `3742`: `MZ Perc [Dream On Vox].wav`

### Noise Floors & Living Textures
- `482`: `Tape noise (Astrud Gilberto - The Sadness Of After).wav`
- `2288`: `[FX] Vinyl Static.wav`
- `3414`: `MZ FX [Street Ambience].wav`
- `4703`: `texture_01.wav`
- `4704`: `texture_02.wav`

### Melodic Loops & Soul Chops
- `630`: `Loop 05 (Luiz Bonfa - The Gentle Rain (Minor Key)).wav`
- `1632`: `Loop 47 (Mieczyslaw Wolny - Flutes En Route).wav`
- `1633`: `Loop 48 (Mieczyslaw Wolny - Flutes En Route).wav`
- `483`: `Bass 01 [A#] (Piero Umiliani - Stream).wav`
- `484`: `Bass 02 [C] (Piero Umiliani - Stream).wav`

### 808 Sub Units
- `2072`: `808 (80 Degrees).wav`
- `2073`: `808 (Alien).wav`
- `2074`: `808 (All I Know).wav`
- `2075`: `808 (Ambjaay - Uno).wav`

### Vintage Soul Kicks
- `352`: `Kick 01 (Un Dos Tres Y Fuera).wav`
- `353`: `Kick 02 (Junior - Let Me Know).wav`
- `354`: `Kick 03 (Shirley & Company).wav`
- `355`: `Kick 04 (Barry White).wav`
- `1489`: `Kick 36 (Roy Ayers - Time And Space).wav`

### Claps, Snares & Rims
- `127`: `Clap 01 (Ashford & Simpson - High-Rise).wav`
- `128`: `Clap 02 (Enchantment - Here's Your Chance).wav`
- `129`: `Clap 03 (Midnight Star - Two in Love).wav`
- `130`: `Clap 04 (Afrika Bambaataa - Jazzy Sensation).wav`
- `1083`: `Snare 01 (Un Dos Tres Y Fuera).wav`
- `1084`: `Snare 02 (Dr. Togo - Be Free).wav`
- `1085`: `Snare 03 (Shirley & Company).wav`
- `1086`: `Snare 04 (Rick James - Hard To Get).wav`
- `1895`: `Snare 39 (Roy Ayers - Time And Space).wav`

### Hats & Cymbals
- `165`: `Cymbal 01 (Michael Wycoff - Love Is So Easy).wav`
- `166`: `Cymbal 02 (Michael Wycoff - No Easy Way).wav`
- `167`: `Cymbal 03 (Thirsty Moon - I See You).wav`
- `168`: `Cymbal 04 (Thirsty Moon - I See You).wav`

---

## 4. Construction Workflow for Ronald Systems

When asked to generate or modify a Ronald beat:

1. **Tempo & Key Selection**:
   - Set BPM strictly between **70 and 86 BPM** (half-time bounce).
   - Minor keys preferred (Am, Dm, Em, F#m) for melancholy.
2. **Noise Bed Setup**:
   - Add a `SampleNode` (loop mode, gain -16 to -18 dB) attached to a noise floor pool (IDs 482, 2288, 3414, 4703).
3. **Atmospheric Bed Setup**:
   - Add a `SampleNode` (loop mode, RubberBand stretch, fade-in/fade-out 0.1s) attached to an ethereal vocal/pad pool (IDs 1700, 2273, 857, 829).
   - Route to a track bus with high-pass EQ and large hall reverb (room size > 0.8, decay > 3.0s, wet > 0.4).
4. **Low End Foundation**:
   - Add an 808 or sub bass `SampleNode` attached to an 808 pool (IDs 2072-2075).
   - Program a `SequenceNode` with sparse hits on beat 1 and syncopated off-beats.
5. **Rhythm Section**:
   - Kick: Punchy acoustic/soul kick sequenced to support the 808.
   - Snare/Clap/Rim: Anchor beat 3 (step 8 in a 16-step grid).
   - Hi-Hat: 8th/16th groove with swing (0.15–0.25) and velocity dynamics.
   - Route drums to a submix bus with punchy compression (`ratio: 4.0`, `attack: 15ms`, `release: 120ms`).
6. **Master Track**:
   - Route all buses into exactly one master `TrackNode` with `role: "master"`.
7. **Validation & Storage**:
   - Validate using `validateGraphDocument(doc)`.
   - Save canonical document to `demo/ronald/<system_name>.json`.
   - Convert via `graphDocumentToWorkspacePreset(doc)` and save to `saves/<system_name>.json`.
