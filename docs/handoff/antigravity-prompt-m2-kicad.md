# Antigravity prompt: Milestone 2 (KiCad schematic editor + simulate from KiCad)

Paste everything below the line into Antigravity's agent, with the E-IDE repo open.

---

You are continuing the E-IDE extension. Milestone 1 (LTspice editor, runner, waveforms, live re-run, agent tools) is done and reviewed. Now add KiCad, following the same patterns.

## Read first

- `extension/src/ltspice/ascParser.ts`, `ascEditorProvider.ts`, `ltspiceRunner.ts`, `rawParser.ts`, and `extension/src/agent/tools.ts`. Reuse their patterns: pure parsers with no `vscode` import, the text document as the single source of truth, diff-and-highlight on every change, and edits through `WorkspaceEdit`.
- In `ascEditorProvider.ts`, note how `triggerSimulation` keeps its own `controller` instead of reading the shared `abortController` after `await`. Use the same pattern for any async run you add, so a stale run never posts results over a newer one.

## Rules (same as milestone 1)

- The `.kicad_sch` file text is the source of truth.
- Parsing, netlist conversion, and CLI calls go in modules with no `vscode` import, with `node --test` tests for each.
- Webview: existing CSP (no inline scripts, no remote resources) and VS Code theme CSS variables only.
- Never write to a KiCad file the user has open in KiCad itself without first checking the file's modified time hasn't changed since we read it. If it has, reload and re-apply, or tell the user.
- No hardware actions. Small commits, one feature each.
- Commit as the repo's configured git user. Do not change git config. Push to `origin main` when the milestone's tests pass.

## Tasks, in order

### 1. S-expression parser (`extension/src/kicad/sexpr.ts`)
- Parse and print KiCad S-expressions: lists, symbols, quoted strings with escapes, and numbers.
- Keep source positions (start and end offsets) on every node, so edits can replace exactly one property's text without reformatting the rest of the file.
- Tests: a round trip (parse, then print unchanged nodes) must keep the file byte-identical.

### 2. Schematic model (`extension/src/kicad/schParser.ts`)
- From a `.kicad_sch` file (KiCad 7 to 10 format), extract: `lib_symbols` (pin positions and graphics), placed `symbol` instances (lib_id, at x y angle, mirror, properties Reference/Value/Footprint), `wire`, `junction`, `label`, `global_label`, `hierarchical_label`, `no_connect`, and `text`.
- Units are millimetres. Y grows downward, the same as SVG.
- Build nets: connect wire endpoints, junctions, pin positions (after rotation and mirror), and labels with the same name. Return `nets: [{name, pins: [{ref, pin}]}]`.
- `propertyEdit(sch, ref, key, value)` returns a text-range edit that replaces only that property's value string.
- `diffSchematics(prev, next)` returns the same shape of changes as the LTspice one.
- Tests: add 2 small `.kicad_sch` fixtures created with KiCad 9 or 10 (an RC filter, and a 5 V to 3.3 V LDO with decoupling caps) under `extension/test/fixtures/kicad/`, and copy one into `samples/`.

### 3. KiCad schematic editor (`extension/src/kicad/schEditorProvider.ts`, `media/kicad.js`, `media/kicad.css`)
- A custom editor for `*.kicad_sch`, registered like the LTspice one.
- Draw symbols from their `lib_symbols` graphics (rectangle, polyline, circle, arc, pin), so the drawing matches KiCad closely. Draw wires, junctions, labels, and the reference and value text.
- Components table with editable Value and Footprint fields, highlighting of changes, and an "Open as text" button. Share the highlight CSS with the LTspice editor rather than copying it.
- Click a net to highlight every wire and pin on it.

### 4. KiCad CLI integration (`extension/src/kicad/kicadCli.ts`)
- Find `kicad-cli` from setting `eide.kicad.cliPath`, then the default Windows install paths (`C:\Program Files\KiCad\<version>\bin\kicad-cli.exe`, newest version first), then `PATH`.
- Commands: `E-IDE: Run ERC` (`kicad-cli sch erc --format json`), showing violations in the Problems panel at the right symbol, and `E-IDE: Export Netlist` (`kicad-cli sch export netlist --format spice`).
- Tests: path discovery (with a fake environment), and parsing of a saved ERC JSON fixture.

### 5. Simulate a KiCad schematic
- Command `E-IDE: Simulate in LTspice`: export the SPICE netlist with `kicad-cli`, take simulation directives from schematic text items that start with `.` (KiCad's own convention), run it with the existing `ltspiceRunner` (add a netlist (`.cir`) input mode next to `.asc`), and show waveforms in a panel under the KiCad schematic using the same waveform code as the LTspice editor. Move that code into a shared module instead of copying it.
- If a symbol has no SPICE model (KiCad's `Sim.*` fields, or a plain R, C, L, V, or I), list it clearly in the result and do not guess a model.
- The live loop: when the KiCad file changes and `eide.kicad.autoSimulate` is on (default off for KiCad), re-export and re-run with the same debounce and before/after overlay.

### 6. Agent tools
- In `extension/src/agent/tools.ts` add: `getKicadSchematic(path)` (components, nets, labels), `setKicadProperty(path, ref, key, value)`, `runErc(path)`, and `simulateKicad(path)`. Edits go through `WorkspaceEdit` so the open editor highlights them.
- Make `runSimulation` in tools post its result to the open editor (if there is one) so agent-started runs also show waveforms.

## Done when

- `npm test` passes, including the new parser, net building, CLI, and round-trip tests.
- Opening the LDO sample shows a schematic that matches KiCad's layout. Editing a value in our table updates the file, and KiCad shows the same value after reloading the file.
- Running ERC puts violations in the Problems panel.
- "Simulate in LTspice" on the RC sample plots `V(out)`, and changing the capacitor value shows the new trace over the faded old one.
- Report what you verified and what you could not (for example, if KiCad is not installed).
