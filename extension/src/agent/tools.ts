// Agent tool surface for E-IDE.
// Exposes programmatic functions an AI agent can call directly or via an MCP server.
// All edits flow through VS Code's WorkspaceEdit so that they are live,
// undoable, and immediately visible in the open schematic editor.

import * as path from 'path';
import * as vscode from 'vscode';
import { AscSchematic, parseAsc, symbolAttrEdit } from '../ltspice/ascParser';
import { findLtspice, runLtspiceSimulation, SimulationRunResult } from '../ltspice/ltspiceRunner';
import { ErcRunResult, findKicadCli, runErc as cliRunErc } from '../kicad/kicadCli';
import { KicadSimResult, simulateKicadSchematic } from '../kicad/kicadSimulation';
import { KicadLabel, KicadNet, KicadPlacedSymbol, parseKicadSch, propertyEdit } from '../kicad/schParser';

async function getDocument(filePath: string): Promise<vscode.TextDocument> {
  const uri = vscode.Uri.file(path.resolve(filePath));
  const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.toLowerCase() === uri.fsPath.toLowerCase());
  if (openDoc) return openDoc;
  return await vscode.workspace.openTextDocument(uri);
}

// Active editor listeners map to post simulation results directly into open webviews
export const activeSimulationWebviews = new Map<string, vscode.Webview>();

// --- LTspice Agent Tools ---

// 1. Get parsed LTspice schematic
export async function getSchematic(filePath: string): Promise<AscSchematic> {
  const doc = await getDocument(filePath);
  return parseAsc(doc.getText());
}

// 2. Set LTspice component value
export async function setComponentValue(filePath: string, id: string, value: string): Promise<boolean> {
  const doc = await getDocument(filePath);
  const schematic = parseAsc(doc.getText());
  const edit = symbolAttrEdit(schematic, id, 'Value', value);
  if (!edit) {
    throw new Error(`Symbol '${id}' not found in ${filePath} or invalid attribute`);
  }

  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const we = new vscode.WorkspaceEdit();

  if (!edit.insert) {
    we.replace(doc.uri, doc.lineAt(edit.line).range, edit.text);
  } else if (edit.line < doc.lineCount) {
    we.insert(doc.uri, new vscode.Position(edit.line, 0), edit.text + eol);
  } else {
    we.insert(doc.uri, doc.lineAt(doc.lineCount - 1).range.end, eol + edit.text);
  }

  return await vscode.workspace.applyEdit(we);
}

// 3. Run LTspice simulation
export async function runSimulation(filePath: string): Promise<SimulationRunResult> {
  const config = vscode.workspace.getConfiguration('eide.ltspice');
  const customPath = config.get<string>('path');
  const timeoutSec = config.get<number>('timeout', 60);

  const exe = findLtspice(customPath);
  if (!exe) {
    throw new Error('LTspice executable not found. Please set eide.ltspice.path in settings.');
  }

  const doc = await getDocument(filePath);
  const ascContent = doc.getText();

  const result = await runLtspiceSimulation({
    executablePath: exe,
    ascPath: doc.uri.fsPath,
    ascContent,
    timeoutMs: timeoutSec * 1000,
  });

  // If a webview is open for this file, post results so waveforms appear live
  const webview = activeSimulationWebviews.get(doc.uri.fsPath.toLowerCase());
  if (webview && result.raw) {
    webview.postMessage({
      type: 'simulationResult',
      success: result.success,
      durationMs: result.durationMs,
      current: {
        plotName: result.raw.plotName,
        variables: result.raw.variables,
        x: Array.from(result.raw.x),
        series: Object.fromEntries(
          Object.entries(result.raw.series).map(([k, v]) => [
            k,
            v instanceof Float64Array ? Array.from(v) : { re: Array.from(v.re), im: Array.from(v.im) },
          ]),
        ),
      },
      bannerText: `Simulation finished in ${(result.durationMs / 1000).toFixed(1)} s`,
    });
  }

  return result;
}

// 4. Get simulation measurements
export async function getMeasurements(filePath: string): Promise<Record<string, number>> {
  const result = await runSimulation(filePath);
  return result.log.measurements;
}

// --- KiCad Agent Tools ---

export interface KicadSchematicSummary {
  components: Array<{ ref: string; value: string; footprint: string; libId: string }>;
  nets: KicadNet[];
  labels: Array<{ name: string; type: string }>;
}

// 5. Get KiCad schematic summary (components, nets, labels)
export async function getKicadSchematic(filePath: string): Promise<KicadSchematicSummary> {
  const doc = await getDocument(filePath);
  const sch = parseKicadSch(doc.getText());

  return {
    components: sch.symbols.map((s) => ({
      ref: s.ref,
      value: s.value,
      footprint: s.footprint,
      libId: s.libId,
    })),
    nets: sch.nets,
    labels: sch.labels.map((l) => ({ name: l.name, type: l.type })),
  };
}

// 6. Set KiCad symbol property (Reference, Value, Footprint, etc.)
export async function setKicadProperty(
  filePath: string,
  ref: string,
  key: string,
  value: string,
): Promise<boolean> {
  const doc = await getDocument(filePath);
  const sch = parseKicadSch(doc.getText());
  const edit = propertyEdit(sch, ref, key, value, doc.getText());
  if (!edit) {
    throw new Error(`Symbol '${ref}' or property '${key}' not found in ${filePath}`);
  }

  const startPos = doc.positionAt(edit.start);
  const endPos = doc.positionAt(edit.end);

  const we = new vscode.WorkspaceEdit();
  we.replace(doc.uri, new vscode.Range(startPos, endPos), edit.text);
  return await vscode.workspace.applyEdit(we);
}

// 7. Run KiCad Electrical Rules Check (ERC)
export async function runErc(filePath: string): Promise<ErcRunResult> {
  const config = vscode.workspace.getConfiguration('eide.kicad');
  const cliPath = findKicadCli(config.get<string>('cliPath'));
  if (!cliPath) {
    throw new Error('kicad-cli not found. Please set eide.kicad.cliPath in settings.');
  }

  const doc = await getDocument(filePath);
  if (doc.isDirty) {
    await doc.save();
  }

  return await cliRunErc({
    cliPath,
    schPath: doc.uri.fsPath,
  });
}

// 8. Simulate KiCad schematic in LTspice
export async function simulateKicad(filePath: string): Promise<KicadSimResult> {
  const config = vscode.workspace.getConfiguration('eide');
  const ltspicePath = findLtspice(config.get<string>('ltspice.path'));
  const kicadCliPath = findKicadCli(config.get<string>('kicad.cliPath'));

  if (!ltspicePath) {
    throw new Error('LTspice executable not found. Please set eide.ltspice.path in settings.');
  }
  if (!kicadCliPath) {
    throw new Error('kicad-cli not found. Please set eide.kicad.cliPath in settings.');
  }

  const doc = await getDocument(filePath);
  const result = await simulateKicadSchematic({
    kicadCliPath,
    ltspicePath,
    schPath: doc.uri.fsPath,
    schContent: doc.getText(),
  });

  // Post to open webview if present
  const webview = activeSimulationWebviews.get(doc.uri.fsPath.toLowerCase());
  if (webview && result.runResult?.raw) {
    const raw = result.runResult.raw;
    webview.postMessage({
      type: 'simulationResult',
      success: result.success,
      durationMs: result.runResult.durationMs,
      current: {
        plotName: raw.plotName,
        variables: raw.variables,
        x: Array.from(raw.x),
        series: Object.fromEntries(
          Object.entries(raw.series).map(([k, v]) => [
            k,
            v instanceof Float64Array ? Array.from(v) : { re: Array.from(v.re), im: Array.from(v.im) },
          ]),
        ),
      },
      bannerText: `Simulation finished in ${(result.runResult.durationMs / 1000).toFixed(1)} s`,
    });
  }

  return result;
}
