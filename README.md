# E-IDE

Visual editors for electrical engineering files inside Antigravity and VS Code-compatible editors. Open a circuit or control file, edit it visually, simulate it, and watch changes made by you or an AI agent appear live.

## Features

- **LTspice (`.asc`)**: schematic view, editable component values, simulation in LTspice, and a waveform panel with cursors, measurements, and a faded overlay of the previous run.
- **KiCad (`.kicad_sch`)**: schematic view drawn from KiCad's own symbols, net highlighting, editable values and footprints, ERC results in the Problems panel, and simulation through LTspice.
- **MATLAB Scripts (`.m`)**: CodeLens "Run in MATLAB" action, persistent TCP bridge, output logging, side panel figure viewer with previous run comparison, and Problems panel error diagnostics.
- **Simulink Models (`.slx`)**: fast offline block diagram rendering, interactive pan/zoom, subsystem drill-down, live disk change watcher with diff pulse highlights, aside parameter editor, simulation runner with logsout/simlog waveform plotting, and click-to-log line toggles.
- **Agent Tools (`tools.ts`)**: programmatic API for AI agents to inspect schematics, mutate block parameters, connect blocks, and run simulations live in open editors.

## Requirements

- LTspice (24 or newer recommended)
- KiCad 9 or newer, for KiCad files
- MATLAB R2020b or newer (e.g. R2026a), for MATLAB script and Simulink bridge features
- Node.js 20 or newer, to build

## Try it

1. `cd extension && npm test`
2. Open the `extension` folder in VS Code and press F5.
3. Open `samples/rc_circuit.slx` for Simulink, `samples/rc_response.m` for MATLAB scripts, `samples/rc_filter.kicad_sch` for KiCad, or `samples/rc_lowpass.asc` for LTspice.
