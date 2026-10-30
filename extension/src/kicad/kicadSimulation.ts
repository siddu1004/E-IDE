// KiCad schematic simulation in LTspice.
// Exports SPICE netlist via kicad-cli, validates models, incorporates schematic directives,
// and runs LTspice simulation returning waveforms.
// Pure TypeScript module, zero vscode imports.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runLtspiceSimulation, SimulationRunResult } from '../ltspice/ltspiceRunner';
import { exportSpiceNetlist } from './kicadCli';
import { KicadPlacedSymbol, parseKicadSch } from './schParser';

export interface KicadSimOptions {
  kicadCliPath: string;
  ltspicePath: string;
  schPath?: string;
  schContent?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface KicadSimResult {
  success: boolean;
  missingModels: string[];
  runResult?: SimulationRunResult;
  error?: string;
}

// Determines if a placed symbol has a recognized SPICE model
export function isSpiceModelSupported(sym: KicadPlacedSymbol): boolean {
  const ref = sym.ref.toUpperCase();
  const libId = sym.libId.toLowerCase();

  // Power ports are net references, not devices
  if (ref.startsWith('#PWR') || libId.startsWith('power:')) {
    return true;
  }

  // Check for explicit KiCad simulation model fields
  if (sym.properties['Sim.Device'] || sym.properties['Sim.Model'] || sym.properties['Sim.Pins']) {
    return true;
  }

  // Standard SPICE primitive component prefixes: R, C, L, V, I, D, Q, M
  const prefix = ref.charAt(0);
  if (prefix === 'R' || prefix === 'C' || prefix === 'L' || prefix === 'V' || prefix === 'I' || prefix === 'D') {
    return true;
  }

  // Known standard simulation libraries
  if (libId.startsWith('simulation_spice:') || libId.startsWith('device:r') || libId.startsWith('device:c') || libId.startsWith('device:l')) {
    return true;
  }

  return false;
}

// Inspects schematic for symbols that lack SPICE models
export function checkMissingSpiceModels(symbols: KicadPlacedSymbol[]): string[] {
  const missing: string[] = [];
  for (const sym of symbols) {
    if (!isSpiceModelSupported(sym)) {
      const name = sym.ref ? `${sym.ref} (${sym.value || sym.libId})` : sym.libId;
      missing.push(name);
    }
  }
  return missing;
}

export async function simulateKicadSchematic(options: KicadSimOptions): Promise<KicadSimResult> {
  let schPath = options.schPath;
  let tempSchDir: string | undefined;

  try {
    let schContent = options.schContent;
    if (schContent === undefined && schPath) {
      schContent = fs.readFileSync(schPath, 'utf8');
    }
    if (schContent === undefined) {
      throw new Error('Either schPath or schContent must be provided');
    }

    const sch = parseKicadSch(schContent);

    // Check for symbols with missing SPICE models
    const missingModels = checkMissingSpiceModels(sch.symbols);
    if (missingModels.length > 0) {
      return {
        success: false,
        missingModels,
        error: `Symbols missing SPICE models: ${missingModels.join(', ')}`,
      };
    }

    // If unsaved content was provided, write to a temp file for kicad-cli
    if (!schPath || options.schContent !== undefined) {
      tempSchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eide-kicad-sim-'));
      schPath = path.join(tempSchDir, 'schematic.kicad_sch');
      fs.writeFileSync(schPath, schContent, 'utf8');
    }

    // 1. Export netlist via kicad-cli
    const netResult = await exportSpiceNetlist({
      cliPath: options.kicadCliPath,
      schPath,
      timeoutMs: options.timeoutMs,
    });

    if (!netResult.success || !netResult.netlist) {
      return {
        success: false,
        missingModels: [],
        error: `KiCad netlist export failed: ${netResult.error || 'Unknown error'}`,
      };
    }

    let cirContent = netResult.netlist;

    // 2. Ensure simulation directives from schematic text are present
    const directives = sch.texts.filter((t) => t.directive).map((t) => t.text.trim());
    for (const d of directives) {
      if (!cirContent.includes(d)) {
        // Insert directive before .end or at end
        if (cirContent.includes('.end')) {
          cirContent = cirContent.replace('.end', `${d}\n.end`);
        } else {
          cirContent += `\n${d}\n`;
        }
      }
    }

    // Clean up common KiCad netlist exporter artifacts (e.g. "DC SINE" -> "SINE")
    cirContent = cirContent.replace(/\bDC\s+SINE\b/gi, 'SINE');
    cirContent = cirContent.replace(/\bDC\s+PULSE\b/gi, 'PULSE');

    // 3. Run LTspice batch simulation
    const runResult = await runLtspiceSimulation({
      executablePath: options.ltspicePath,
      cirContent,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    return {
      success: runResult.success,
      missingModels: [],
      runResult,
      error: runResult.error,
    };
  } finally {
    if (tempSchDir && fs.existsSync(tempSchDir)) {
      try { fs.rmSync(tempSchDir, { recursive: true, force: true }); } catch {}
    }
  }
}
