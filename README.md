# E-IDE

Visual editors for electrical engineering files inside Antigravity and VS Code-compatible editors. Open a circuit or control file, edit it visually, simulate it, and watch changes made by you or an AI agent appear live.

## Features

- **LTspice (`.asc`)**: schematic view, editable component values, simulation in LTspice, and a waveform panel with cursors, measurements, and a faded overlay of the previous run.
- **KiCad (`.kicad_sch`)**: schematic view drawn from KiCad's own symbols, net highlighting, editable values and footprints, ERC results in the Problems panel, and simulation through LTspice.
- **MATLAB Scripts (`.m`)**: CodeLens "Run in MATLAB" action, persistent TCP bridge, output logging, side panel figure viewer with previous run comparison, and Problems panel error diagnostics.
- **Simulink Models (`.slx`)**: fast offline block diagram rendering, interactive pan/zoom, subsystem drill-down, live disk change watcher with diff pulse highlights, aside parameter editor, simulation runner with logsout/simlog waveform plotting, and click-to-log line toggles.
- **Arduino (`.ino`)**: sketch verification and uploading via `arduino-cli`, compiler diagnostics in Problems panel, serial monitor & live numeric waveform plotter, and automatic serial port release/reconnect around firmware flashes.
- **Desktop Apps inside E-IDE**: run full desktop engineering tools (MATLAB/Simulink, KiCad, LTspice, Arduino IDE) inside IDE tabs via WinMirror window capture.
- **Agent Tools (`tools.ts`)**: programmatic API for AI agents to inspect schematics, mutate block parameters, connect blocks, and run simulations live in open editors.

## Apps inside E-IDE

Run and interact with full-featured desktop EEE engineering applications directly within editor tabs. Supported applications include **MATLAB / Simulink**, **KiCad**, **LTspice**, and **Arduino IDE**.

### Features

- **EEE Apps View**: Accessible via the Activity Bar icon. Displays the status of each supported application (`Installed`, `Running`, or `Not installed`) with an automatic 5-second refresh interval. Click to open installed or running applications inside an IDE tab, or trigger installation downloads for missing ones.
- **Status Bar Integration**: A `$(window) Apps` item in the status bar provides quick access to launch applications (`eide.apps.open`).
- **Disk Change Watcher**: When a file is open in a mirrored desktop app and modified externally (e.g. by an AI agent), E-IDE detects the change via FileSystemWatcher and prompts: *"Changed on disk, reload in <app>?"* to ensure synchronization.

### Usage

You can open a desktop app inside E-IDE using any of the following methods:

1. **Sidebar**: Click an application in the **EEE Apps** activity bar view.
2. **Status Bar**: Click the `$(window) Apps` button.
3. **Context Menu**: Right-click a supported file (`.asc`, `.kicad_sch`, `.slx`, `.ino`, etc.) in the file explorer or editor title bar and select **Open in Desktop App Inside IDE**.

### Limitations

- **Platform**: Windows only (powered by Windows desktop window capture).
- **Keyboard Input**: While an app tab has focus, keys and shortcuts (`Ctrl+S`, `Ctrl+Z`, ...) go to the app. `Ctrl+Tab`, `Ctrl+PageUp/PageDown`, `Ctrl+Shift+P` and `F1` stay with the IDE.

## Install

- **Requirements**: Windows 10/11, Windows PowerShell 5.1, Node.js 20+.
- **Build `.vsix`**:
  ```bash
  cd extension
  npm install
  npx @vscode/vsce package --skip-license
  ```
- **Install**:
  ```bash
  antigravity-ide --install-extension e-ide-0.0.1.vsix
  ```
- **Troubleshooting**:
  - **Windows Defender**: E-IDE loads `mirror/WinMirror.cs` in-memory via `winmirror.ps1` and `Add-Type`, writing no unsigned `.exe` to disk.
  - **DPI Scaling**: `WinMirror` uses Per-Monitor V2 DPI awareness for 150% displays; toggle **Fit window to tab** in the tab header to match window dimensions 1:1.
  - **App not detected**: Click **Set Path** on the warning prompt or configure `eide.apps.<app>Path` in Settings (`E-IDE: Set Custom App Paths`).

## Requirements

- LTspice (24 or newer recommended)
- KiCad 9 or newer, for KiCad files
- MATLAB R2020b or newer (e.g. R2026a), for MATLAB script and Simulink bridge features
- Node.js 20 or newer, to build

## Try it

1. `cd extension && npm test`
2. Open the `extension` folder in VS Code and press F5.
3. Open `samples/rc_circuit.slx` for Simulink, `samples/rc_response.m` for MATLAB scripts, `samples/rc_filter.kicad_sch` for KiCad, or `samples/rc_lowpass.asc` for LTspice.
