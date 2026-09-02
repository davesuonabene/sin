# GAIA Library Editor — layered editor plan

## Product boundary

GAIA will have one global transport footer and one shared media editor. The
editor has one layer model. A layer can be active or inactive, so the same
editor supports one playable item, several synchronized stems, and future
layered variations without separate editor modes.

Folders are not a third editor type. A project, sample pack, collection, or
multitrack folder is an editor session containing selectable media targets.
The footer always shows the current target and provides a dropdown to switch
between the targets in that session.

This keeps the UI small while allowing each container to behave naturally:

- Open a multitrack folder: start with all stems active and layered. Choose one
  stem in the footer target menu: make only that stem active in the same editor.
- Open a sample pack: start on its resolved master/first playable sample with
  one active layer. Use the scrollable target menu or previous/next controls to
  move through the pack's samples.
- Open a project: start on its resolved master. The target menu includes the
  project's playable sources, revisions, mixdowns, and contained media. A
  selected multitrack activates its layers; a selected audio item activates
  one layer.
- MIDI and non-playable items have no editor target for now.

There is no separate project editor or sample-pack editor surface. Containers
provide context, target navigation, and save destinations; the shared editor
does the media work.

## Footer target navigation

The sticky footer keeps a visible name label beside the transport controls.
The label behaves like the vault selector: clicking it opens a menu for the
current editor session.

The menu shows:

- the session/container name at the top;
- the current target with a check mark;
- playable children grouped by role or path;
- a scrollable list for large sample packs and projects;
- for multitracks, the parent mix plus each individual stem;
- target type, short label, and duration where available.

The footer therefore answers two different questions without ambiguity:

- **Now playing:** the item currently heard by the transport.
- **Current editor target:** the item or layer set being edited.

Changing the target should not silently discard unsaved edits. If the current
editor is dirty, the user gets a small Save/Discard/Cancel choice before the
target changes. Playback may continue if the user only changes the target.

When a container has no explicit master, GAIA resolves the default target from
the existing preview rules: profile-designated master first, otherwise the
first playable child. Changing targets in the footer is a session choice, not
a new asset-management workflow.

## Launch and save behavior

### Existing project session

Opening a project resolves its current master and builds a target list from
the project's references and contained media. Selecting a child changes the
active layer set in the shared editor. New renders are added to the existing
project as versioned artifacts.

### Standalone media or folder session

Opening standalone audio or a folder allows immediate audition and editing.
Save/Render offers two destinations:

1. **Create project from result** — ask for a project name and vault. Original
   source files are referenced by default. The user may opt into moving the
   original managed file(s), using the same move/reference behavior as the
   main project-creation flow.
2. **Override original** — explicitly replace the original media in place.

Project creation should reuse the existing project-from-items workflow rather
than inventing a second placement dialog. The render is only committed after
the project/source decision has succeeded.

Override is destructive and must use a temporary output plus atomic replace.
The original item identity, path, tags, and references remain valid; its hash,
size, duration, and analysis are refreshed after replacement. A multi-segment
edit cannot replace one source file with several files, so project creation is
required for multi-output cuts.

For multitracks, the initial safe override policy is mixdown-only: replace a
single selected mixdown result while keeping source stems intact. Rewriting
all stems is a separate destructive action and should not be hidden behind the
same button.

## Shared layered editor

The editor owns one timeline, one playhead, one selection model, and one render
contract. Target selection determines the default active layers; the user can
then activate or deactivate layers directly in the editor.

```text
One active layer:  [ original audio layer ]
Several active:    [ stem 1 ] [ stem 2 ] [ stem 3 ] ...
```

The layer abstraction is useful beyond multitracks. A future feature can add a
second layer pointing to the same source with an offset, gain, or character
treatment to double the original. That future use should not require a second
editor architecture.

For now:

- A direct audio target starts with exactly one active layer.
- A multitrack target starts with all source stems active and synchronized.
- Selecting one stem from a multitrack target makes only that layer active.
- The user can toggle layer activity without leaving the editor.
- The UI should not expose arbitrary layer creation yet; the capability is an
  internal model seam for later doubling and stem-derived workflows.

The one-layer editor surface is intentionally small:

- one waveform and playhead;
- zoom and a range timeline;
- multiple cut segments, each with start and end points;
- gain/volume;
- normalization;
- output conversion to WAV or MP3;
- a future stem-separation action, shown as unavailable until Demucs exists.

### Multiple cuts

The edit is a list of ranges against the original, not a destructive sequence
of edits against the previous result:

```json
{
  "segments": [
    {"id": "a", "start_frame": 12000, "end_frame": 88000, "label": "bird 1"},
    {"id": "b", "start_frame": 104000, "end_frame": 176000, "label": "bird 2"}
  ]
}
```

Each segment renders from the original source. This avoids accumulated timing
errors and lets the user adjust or remove a cut before rendering. Multiple
audio cuts produce multiple derived outputs; the default output classification
is `sample` because the operation is intended to create new samples from a
recording. A single processed result preserves the source family unless the
user explicitly changes its target type later.

### Normalization and conversion

Normalization applies to the rendered result, not the source while it is being
auditioned. The normalization target and peak protection are stored in the
edit document so the result is reproducible. The first conversion target is
WAV or MP3. MP3 encoding must use an available encoder such as FFmpeg; the UI
should report a clear unavailable state if the encoder is missing.

### Future Demucs seam

The editor exposes a disabled “Separate stems” action with a short
“Demucs engine not installed” state. Its future contract is:

- input: one audio item and optional selected segment;
- output: a derived multitrack asset containing separated stems;
- next action: open the resulting multitrack in the same editor with the
  separated layers active;
- destination: create a project or, where meaningful, use the explicit
  override flow.

No Demucs engine or background separation work is part of this implementation.

The multi-layer target is an imported `multitrack` folder, especially a Zoom H4
recording interpreted with the existing `zoom_h4` profile.

The page contains:

1. One shared ruler, playhead, and cut-segment list.
2. One waveform layer per source stem.
3. Per-stem volume/gain.
4. Per-stem mute and solo for audition.
5. A shared normalization/output control.
6. WAV/MP3 output conversion.
7. Render mixdown and render-job progress.

Every cut range is applied to every stem using the same source frame bounds.
No stem may drift independently because of a cut. Volume is independent per
stem; browser audition and server rendering use the same gain values.

Rendering a multitrack produces a new stereo mixdown for each selected segment
or one mixdown for a single range. The original stems remain available. The
existing Zoom `TrLR` mixdown also remains an imported source unless the user
explicitly chooses the narrowly defined mixdown override.

## Folder sessions and target descriptors

The backend should expose a session descriptor rather than forcing the client
to reconstruct folder relationships from raw rows.

```text
GET /items/{item_id}/editor-session
GET /items/{item_id}/editor-session?target_item_id=...
GET /items/{item_id}/waveform?resolution=2000
GET /items/{item_id}/stems/{stem_index}/waveform?resolution=2000
```

The descriptor identifies the session, current target, active layer IDs, and
available layers:

```json
{
  "session": {
    "root_item_id": 123,
    "root_type": "multitrack",
    "title": "H4 take",
    "targets": [
      {"id": "root:123", "item_id": 123, "label": "All stems", "active_layer_ids": [124, 125]},
      {"id": "stem:124", "item_id": 124, "label": "Take_Tr1.wav", "active_layer_ids": [124]},
      {"id": "stem:125", "item_id": 125, "label": "Take_Tr2.wav", "active_layer_ids": [125]}
    ]
  },
  "current_target": {"id": "root:123", "active_layer_ids": [124, 125]},
  "editor": {
    "active_layer_ids": [124, 125],
    "capabilities": {
      "cut": true,
      "volume": true,
      "normalize": true,
      "convert_mp3": true,
      "stem_separation": false
    },
    "duration_seconds": 600.0,
    "sample_rate": 44100,
    "layers": [
      {
        "item_id": 124,
        "stem_index": 0,
        "label": "source channel",
        "filename": "Take_Tr1.wav",
        "stream_url": "/items/123/stems/0/stream",
        "waveform_url": "/items/123/stems/0/waveform"
      }
    ]
  }
}
```

For a sample pack, `targets` contains playable sample children and the
resolved default target is the master/first sample. For a project, `targets`
contains playable referenced sources, revisions, mixdowns, and contained
media. For a multitrack, `targets` contains the all-stems target plus each
selectable stem.

The client must receive safe stream/waveform URLs, not raw filesystem paths.
The current `/items/{item_id}/stems` and stem stream endpoints can remain
compatibility endpoints while the editor-session descriptor becomes canonical.

## Edit document and persistence

Keep unsaved edits in the browser until Validate or Render. Use frames for
deterministic boundaries and seconds only at the UI boundary.

```json
{
  "schema": "gaia-media-edit-v3",
  "source_item_id": 123,
  "source_type": "multitrack",
  "active_layer_ids": [124, 125],
  "segments": [
    {"id": "a", "start_frame": 0, "end_frame": 26460000, "label": "take"}
  ],
  "layers": [
    {"item_id": 124, "gain_db": -3.0, "muted": false},
    {"item_id": 125, "gain_db": 1.5, "muted": false}
  ],
  "audio": {
    "gain_db": 0.0,
    "normalize": true,
    "target_peak_db": -1.0
  },
  "output": {"format": "wav", "sample_rate": 44100, "channels": 2},
  "destination": "create_project"
}
```

Do not add `audio_edits`, `mixdowns`, `multitrack_revisions`, or other
asset-specific tables. For project-backed results:

1. Link the original source into the project with a generic `ItemReference`.
2. Store the edit document under `project/files/edit/` as a regular GAIA file
   artifact.
3. Render outputs under `project/files/mixdown/` or the appropriate stage.
4. Register every output as a normal audio/track/sample item.
5. Use generic references for source, edit, derived output, revision, and
   master relationships.
6. Refresh the project's current.json manifest.

For override, render beside the source, validate the complete output, then
atomically replace the source and refresh its database values. Never delete the
source before the replacement is complete.

## Backend implementation

### Service modules

- `gaia/media_editor.py` — session/target resolution, capability resolution,
  edit validation, frame normalization, segment rendering, volume,
  normalization, and destination orchestration.
- `gaia/media_jobs.py` — background render jobs with progress, cancellation,
  and cleanup, following the existing import/analysis job patterns.
- `gaia/waveforms.py` — bounded min/max peak extraction in blocks.
- `gaia/audio_encoding.py` — WAV output and MP3 conversion behind one small
  adapter.

### Proposed render API

```text
POST /media-edits/validate
POST /media-edits/render
GET  /media-jobs/{job_id}
POST /media-jobs/{job_id}/cancel
```

The render request must carry the active target, layers, edit document, and
destination decision explicitly:

```json
{
  "edit": {
    "source_item_id": 123,
    "active_layer_ids": [124, 125],
    "segments": [],
    "layers": []
  },
  "destination": {
    "mode": "project",
    "project_id": 44,
    "project_name": null,
    "vault_id": null,
    "move_source_ids": []
  }
}
```

For a new project, the UI can use the existing project-from-items endpoint to
create the project and apply the same vault/move/reference choices, then send
the render request with the resulting project ID.

### Renderer behavior

For the MVP, use block-based processing with NumPy and `soundfile`:

- validate every segment against the source duration and sample rate;
- resolve all layers before rendering;
- use the same frame bounds for every multitrack layer;
- apply `10 ** (gain_db / 20)` per audio layer;
- skip muted layers and use solo state only to derive the active audition set;
- mix active multitrack layers to stereo;
- normalize only when requested, with peak protection;
- write WAV to a temporary project/output path;
- convert the completed WAV to MP3 through the encoding adapter when selected;
- hash and register only after the output is closed and verified.

Long field recordings must be processed in blocks. The source must never be
loaded entirely into memory, and a failed/cancelled job must remove temporary
outputs without creating an incomplete GAIA item.

## Frontend implementation

The current GAIA client stores playback in `gaia/static/app.js`. Extract the
new behavior into small plain-JavaScript modules while leaving import and
library filtering intact:

- `gaia/static/transport.js` — global now-playing state, footer, target label,
  target dropdown, scrubber, and editor launch.
- `gaia/static/media-editor.js` — one editor with a shared timeline, active
  layers, cuts, render actions, and dirty state.
- `gaia/static/target-navigator.js` — session target list, scrolling,
  container/master resolution, and target switching.
- `gaia/static/waveform-canvas.js` — peaks, playhead, range handles, and zoom.
- `gaia/static/index.html` / `styles.css` — minimal footer/drawer layout.

The current one-file preview remains a normal stream. Only an opened
multitrack target loads synchronized lane audio for browser audition.

## Delivery phases

### Phase 1 — transport and target navigation

- Add sticky footer and global transport controller.
- Add the visible current-target label and scrollable dropdown.
- Preserve current preview behavior.
- Add container/master resolution for projects, sample packs, and
  multitracks.
- Add the dirty-target Save/Discard/Cancel guard.

### Phase 2 — one-layer editor behavior

- Add one waveform page, playhead, zoom, and multi-segment cut ranges.
- Add volume and normalization audition.
- Add explicit create-project/reference/move and override destination choices.
- Add WAV output and the MP3 encoding adapter.
- Add disabled Demucs action and capability response.

### Phase 3 — active multitrack layers

- Add all-stems target and selectable individual-stem targets.
- Add synchronized waveform layers and shared cuts.
- Apply each cut to every stem.
- Add per-stem volume, mute, solo, normalization, and mixdown rendering.
- Add project-backed revision registration and safe override behavior.

### Phase 4 — persistence and hardening

- Add background render progress/cancellation.
- Add generic references for edit documents, results, revisions, and master.
- Add regression coverage proving source files remain unchanged by default.
- Add atomic replacement tests for explicit override.
- Keep the internal layer model ready for future single-item doubling.

Demucs stem separation becomes a later phase that emits a multitrack result and
hands it back to the same layered editor with the separated layers active.

## Acceptance scenarios

### Multitrack folder

1. Open an imported H4 multitrack in the footer editor.
2. The footer label shows the folder/session name and the target menu shows
   “All stems” plus every stem.
3. The default target activates all stems as synchronized layers.
4. Choose one stem in the target menu and make only that layer active.
5. Return to “All stems,” create shared cut ranges, rebalance individual
   layers, and render a new mixdown.

### Sample pack

1. Open a sample pack and start on its resolved master/first playable sample.
2. Keep the same editor open while scrolling through samples in the target
   menu or using previous/next.
3. Cut, normalize, convert, or adjust the selected sample.
4. Create a project or use an explicit override according to the destination
   choice; never edit pack structure from this editor.

### Project

1. Open a project and start on its resolved master.
2. Use the footer target menu to choose sources, revisions, mixdowns, or
   contained media.
3. An audio target activates one layer; a multitrack target activates its
   available layers.
4. Render a new result back into the project and keep the generic reference
   graph intact.

### Unsupported targets

MIDI and non-playable files do not open an editor. They are omitted or shown as
  unavailable in the target menu without creating a misleading generic page.

## Remaining implementation assumption

The plan assumes that a sample pack without an explicit profile-designated
master opens its first playable child as the default target. If “master sample”
must be a persistent user-selected value, that should be specified before the
session descriptor is implemented.
