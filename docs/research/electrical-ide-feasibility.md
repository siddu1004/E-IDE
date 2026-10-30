# Universal AI Electrical Engineering IDE: Feasibility Research

Status: first-pass research from web search snippets. Licenses, versions, and maintenance status must be verified against each repository before any dependency decision.

## 1. Existing integrations by domain

| Domain | Existing building block | Notes |
|---|---|---|
| MATLAB / Simulink | MathWorks MATLAB MCP Core Server and MATLAB/Simulink Agentic Toolkits (R2026a) | Lets external MCP agents (Claude Code, Copilot, Gemini CLI, Codex) run MATLAB code, tests, and Simulink model queries/edits/sims. Source: `matlab/matlab-mcp-server` on GitHub. Licensing: MCP server use is governed by the MathWorks SLA and is single-user; shared or centralized use needs a MathWorks agreement. MATLAB itself requires a paid license. |
| Simscape | Covered through Simulink/MATLAB | No separate MCP found. Simscape models are reached through the same Simulink toolkit. |
| PCB / schematic | KiCad 9+ IPC API and several open-source MCP servers (`kicad-eda-mcp`, `kicad-mcp-kipy`, `nirulaboratories/kicad-mcp-server` (MIT), `mixelpixx/KiCAD-MCP-Server`) | Most need a running KiCad GUI with IPC enabled. Routing uses Freerouting (Java). Many duplicates exist, so pick one and vet it. |
| Microcontrollers | PlatformIO Core, Arduino CLI, and MCP wrappers (`powerdragonfire/platformio.mcp`, `jl-codes/platformio-mcp`) | PlatformIO covers Arduino, ESP32, STM32, and RP2040. Wrappers add build, flash, serial monitor, and GDB. Flash/erase should sit behind a permission policy. |
| Antigravity / IDE host | Antigravity is a VS Code-based fork; its MCP support is reported as available in 2.0, but official extension-API docs were not found | Verify against Google's docs before committing to an Antigravity-first extension. |

## 2. Feasibility assessment

- **Strongest path: orchestrate existing tools rather than rebuild them.** MATLAB/Simulink, KiCad, and PlatformIO all already expose CLIs, APIs, or MCP servers. The product's value is the agent loop: plan → generate → simulate → test → flash → read results.
- **Hardest gap: digital twins and waveform validation against real hardware.** No open, reusable product was identified here. This would need a bridge: scope/DAQ drivers (e.g., SCPI/VISA), sensor logs, and a model-to-measurement comparison.
- **Licensing is the main constraint.** MATLAB/Simulink require paid licenses and restrict MCP server sharing. Any multi-user or hosted product must either use a per-user install model or negotiate with MathWorks. Open-source alternatives for simulation (e.g., ngspice, Xcos/Scilab, OpenModelica) are weaker for Simscape-level work, so a plan with and without MATLAB should be designed.
- **Platform choice:** Build the engine as a standalone MCP-compatible service first. An Antigravity/VS Code extension is a thin UI on top of it. This keeps the same backend for VS Code, Cursor, and standalone use.

## 3. Proposed architecture

```
UI layer        : VS Code-compatible extension (Antigravity, VS Code, Cursor) | standalone shell later
Agent layer     : LLM agent with tool schemas; plans, edits, and iterates
Execution engine: local service exposing MCP tools
  ├─ MATLAB/Simulink adapter   (MATLAB MCP Core + Simulink toolkit)
  ├─ Circuit/PCB adapter       (KiCad IPC API / MCP)
  ├─ MCU adapter               (PlatformIO CLI; flash behind policy)
  ├─ Instrument adapter        (VISA/SCPI, serial) for measurements
  └─ Results store             (waveforms, logs, run history)
Visualization   : webview panels for schematics, waveforms, and sim dashboards
```

## 4. Recommended MVP (scope to one vertical slice)

Goal: "Describe a 5V-to-3.3V LDO plus an ESP32 blink-and-sense board" → agent produces schematic in KiCad, a PlatformIO sketch, a Simulink or ngspice check of the regulator, builds and flashes the ESP32, and displays the measured result.

Milestones:
1. **M1, engine:** MCP tool server with three adapters (PlatformIO, KiCad, MATLAB) and a permission policy for flash/erase/serial write.
2. **M2, visualization:** Simulation and waveform viewer fed by adapter outputs.
3. **M3, extension:** Thin VS Code-compatible extension that connects to the engine and shows run status and panels.
4. **M4, hardware loop:** Instrument adapter; compare measured versus simulated waveforms.

Out of scope for MVP: hosted multi-user service, automatic PCB fabrication ordering, and full digital-twin synchronization.

## 5. Open questions to resolve before building

1. MathWorks licensing for the intended user base (per-seat install vs. shared service).
2. Antigravity extension API and MCP config (check Google's official docs).
3. KiCad IPC API stability across versions (9 vs. 10).
4. Which open-source KiCad MCP server to adopt, after license and maintenance review.
5. Target hardware list for the first release.

## Sources (search snippets, not verified in depth)

- MathWorks agentic AI page: https://www.mathworks.com/products/matlab/agentic-ai.html
- MathWorks R2026a announcement: https://nl.mathworks.com/company/newsroom/matlab-and-simulink-release-2026a-features-new-generative-ai-powered-simulink-copilot-that-enhances-design-and-development-workflows-for-engineered-systems.html
- Antigravity MCP overview: https://lilys.ai/en/notes/google-antigravity-20260129/mcp-servers-antigravity-ide
- Antigravity VS Code extension request: https://github.com/google-antigravity/antigravity-cli/issues/346
- kicad-eda-mcp: https://pypi.org/project/kicad-eda-mcp/
- KiCad forum MCP roundup: https://forum.kicad.info/t/i-built-an-mcp-server-that-lets-ai-assistants-help-with-kicad-pcb-design/66451
- PlatformIO MCP: https://mcpservers.org/servers/powerdragonfire/platformio.mcp
- jl-codes platformio-mcp: https://skillsmp.com/ko/creators/jl-codes/platformio-mcp
