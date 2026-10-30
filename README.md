# E-IDE

Visual editors for electrical engineering files inside Antigravity and VS Code-compatible editors. Open a circuit file, edit it visually, simulate it, and watch changes made by you or an AI agent appear live.

## Features

- **LTspice (`.asc`)**: schematic view, editable component values, simulation in LTspice, and a waveform panel with cursors, measurements, and a faded overlay of the previous run.
- **KiCad (`.kicad_sch`)**: schematic view drawn from KiCad's own symbols, net highlighting, editable values and footprints, ERC results in the Problems panel, and simulation through LTspice.
- **Live changes**: any edit to the file flashes on screen and can re-run the simulation automatically.

## Requirements

- LTspice (24 or newer recommended)
- KiCad 9 or newer, for KiCad files
- Node.js 20 or newer, to build

## Try it

1. `cd extension && npm install && npm test`
2. Open the `extension` folder and press F5. A development window opens with `samples/`.
3. Open `rc_lowpass.asc` or `rc_filter.kicad_sch`, then change a value in the table or edit the file as text.
