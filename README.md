# E-IDE

AI-assisted electrical and electronics engineering development: describe a system in natural language, and an agent designs it, models it, simulates it, tests it, and flashes hardware.

## Direction

A standalone IDE is not the first step. Agentic development already happens in Antigravity, VS Code, and Codex, so E-IDE is built as:

1. **Execution engine**: a local MCP tool server that wraps existing engineering tools.
   - MATLAB/Simulink (MathWorks MATLAB MCP Core Server and Simulink toolkit)
   - KiCad (IPC API and MCP servers) for schematics and PCBs
   - PlatformIO for ESP32, Arduino, STM32, and RP2040 build and flash
   - Instrument drivers (VISA/SCPI, serial) for measurements
2. **Extension layer**: a thin VS Code-compatible extension for Antigravity, VS Code, and Cursor, plus Codex through its MCP support. It shows run status, schematics, waveforms, and simulation dashboards.
3. **Standalone shell**: evaluated later, once the engine and extension are proven.

## Status

Milestone 0 is done: the LTspice schematic editor. Opening an `.asc` file shows a visual schematic with an editable components table, and any change to the file (by you or an agent) flashes on screen.

Try it:

1. `cd extension && npm install && npm test`
2. Open the `extension` folder and press F5. A development window opens with `samples/`.
3. Open `rc_lowpass.asc`, then change a value in the table or edit the file as text.

Next milestone (simulation runner, waveforms, live re-run): [docs/handoff/antigravity-prompt.md](docs/handoff/antigravity-prompt.md).

Background research: see [docs/research/electrical-ide-feasibility.md](docs/research/electrical-ide-feasibility.md) for feasibility, existing integrations, licensing constraints, and the MVP plan.

## Open questions

- MathWorks licensing for multi-user or hosted use
- Antigravity extension API and MCP configuration (verify against official docs)
- Which KiCad MCP server to adopt after license and maintenance review
- First-release hardware target list