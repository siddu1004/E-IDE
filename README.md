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

Research phase. See [docs/research/electrical-ide-feasibility.md](docs/research/electrical-ide-feasibility.md) for feasibility, existing integrations, licensing constraints, and the MVP plan.

## Open questions

- MathWorks licensing for multi-user or hosted use
- Antigravity extension API and MCP configuration (verify against official docs)
- Which KiCad MCP server to adopt after license and maintenance review
- First-release hardware target list