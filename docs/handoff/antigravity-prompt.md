# Antigravity prompt: Milestone 1 (LTspice live editor + simulation)

Paste everything below the line into Antigravity's agent, with the E-IDE repo open.

---

You are working in the E-IDE repo, a VS Code-compatible extension that gives electrical engineers visual editors for LTspice, KiCad, and MATLAB/Simulink files, where agent edits are visible live.

## What already exists (do not rewrite it)

- `extension/src/ltspice/ascParser.ts`: parses LTspice `.asc` files into `AscSchematic`, diffs two parses (`diffSchematics`), and builds attribute edits (`symbolAttrEdit`). Pure TypeScript, no vscode imports. Keep it that way.
- `extension/src/ltspice/ascEditorProvider.ts`: a `CustomTextEditorProvider` for `*.asc`. The text document is the single source of truth. Every document change is re-parsed, diffed, and posted to the webview, which highlights what changed.
- `extension/media/schematic.js` and `schematic.css`: the webview. Draws the schematic as SVG, has an editable components table, and flashes changed parts orange.
- `extension/test/ascParser.test.ts`: 5 passing tests (`cd extension && npm test`).
- `samples/rc_lowpass.asc`: demo circuit.
- Run the extension with F5 using `extension/.vscode/launch.json`, then open `samples/rc_lowpass.asc`.

## Rules

- The `.asc` file text stays the source of truth. Never keep a second model of the circuit that can drift from the file.
- All parsing and simulation logic goes in modules with no `vscode` import, so it is testable with `node --test`. Add tests for every new module.
- Webview code must work under the existing Content Security Policy: no inline scripts, no remote resources.
- Use VS Code theme CSS variables for colors, never hard-coded colors.
- Do not run anything that flashes or drives hardware.
- Keep commits small, one feature per commit.

## Tasks, in order

### 1. LTspice simulation runner (`extension/src/ltspice/ltspiceRunner.ts`)
- Find the LTspice executable: setting `eide.ltspice.path`, then the default Windows install paths (`%LOCALAPPDATA%\Programs\ADI\LTspice\LTspice.exe`, `C:\Program Files\ADI\LTspice\LTspice.exe`, `C:\Program Files\LTC\LTspiceXVII\XVIIx64.exe`). Show a clear message with a "Set path" button if it is not found.
- Run batch mode: `LTspice.exe -b <file>.asc` (verify the exact flag against the installed version's help). Run it in a temp copy or next to the file, with a 60 s timeout and a cancel button.
- Parse the `.log` file for errors and `.meas` results.
- Register a command `E-IDE: Run Simulation` and a Run button in the schematic header.

### 2. `.raw` waveform parser (`extension/src/ltspice/rawParser.ts`)
- Parse LTspice `.raw` files: the header (UTF-16LE text in most versions, check for both UTF-16LE and ASCII), variable list, and binary data. Transient data is float64 for time and float32 for the other variables, while AC data is complex float64. Handle "compressed" transient points as they are stored.
- Return `{ plotName, variables: [{name, type}], x: Float64Array, series: Record<string, Float64Array | {re, im}> }`.
- Write tests using small handmade `.raw` fixtures checked into `extension/test/fixtures/`.

### 3. Waveform panel in the schematic editor
- Under the schematic, add a waveform panel that draws the series on a canvas or SVG, with no chart library unless it is bundled locally.
- Click a wire or net label to plot its voltage. Click a component to plot its current.
- Show cursors with readouts and basic measurements: min, max, peak-to-peak, RMS, and frequency.
- After every re-run, overlay the previous run as a faded trace so the before/after comparison is visible.

### 4. Live loop
- Add setting `eide.ltspice.autoRun` (default on). When the document changes (user edit or agent edit), debounce 800 ms, save to a temp file, re-run, and update the waveform with the overlay.
- The banner should read like: "Update: changed C1 · re-simulated in 0.6 s".

### 5. Agent tool surface
- Add `extension/src/agent/tools.ts` that exposes plain functions an agent can call through an MCP server later: `getSchematic(path)`, `setComponentValue(path, id, value)`, `runSimulation(path)`, and `getMeasurements(path)`. They must go through the same document edit path as the UI so edits show up live.

## Done when

- `npm test` passes, with tests for the runner's path discovery and log parsing, and for the raw parser.
- Opening `samples/rc_lowpass.asc` shows the schematic. Changing C1 in the table re-runs the sim and the `out` waveform updates with the old trace faded behind it.
- Editing the `.asc` file text directly (as an agent would) produces the same highlight and re-run.
- Report what you verified, and what you could not (for example, if LTspice is not installed).
