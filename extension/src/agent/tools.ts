// Agent tool surface for E-IDE.
// Exposes programmatic functions an AI agent can call directly or via an MCP server.
// All edits flow through VS Code's WorkspaceEdit or bridge, with live banners,
// turn grouping, and instant Undo restoration.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ErcRunResult, findKicadCli, runErc as cliRunErc } from '../kicad/kicadCli';
import { KicadSimResult, simulateKicadSchematic } from '../kicad/kicadSimulation';
import { KicadNet, parseKicadSch, propertyEdit } from '../kicad/schParser';
import { AscSchematic, parseAsc, symbolAttrEdit } from '../ltspice/ascParser';
import { findLtspice, runLtspiceSimulation, SimulationRunResult } from '../ltspice/ltspiceRunner';
import { BridgeStatus, MatlabBridge, ScriptRunResult, SimulateResult } from '../matlab/matlabBridge';
import { parseSlx, SlxModel } from '../simulink/slxParser';
import { AgentHistoryManager } from './agentHistory';
import { TestHook } from '../testHook';
import {
  CompactSimulationSummary,
  downsampleSeries,
  summarizeSimulationData,
} from './waveformSummary';

// Active editor listeners map to post simulation results directly into open webviews
export const activeSimulationWebviews = new Map<string, vscode.Webview>();

// Register webview with AgentHistoryManager whenever updated
export function registerEditorWebview(filePath: string, webview: vscode.Webview): vscode.Disposable {
  const normPath = path.resolve(filePath).toLowerCase();
  activeSimulationWebviews.set(normPath, webview);
  const historyDisp = AgentHistoryManager.getInstance().registerWebview(normPath, webview);

  return {
    dispose: () => {
      activeSimulationWebviews.delete(normPath);
      historyDisp.dispose();
    },
  };
}

export function postToEditorWebview(filePath: string, msg: any) {
  const normPath = path.resolve(filePath).toLowerCase();
  const webview = activeSimulationWebviews.get(normPath);
  if (webview) {
    TestHook.recordPostMessageForUri(filePath, msg);
    try {
      webview.postMessage(msg);
    } catch {}
  }
}

async function readFileWithRetry(filePath: string, maxAttempts = 15, delayMs = 150): Promise<Buffer> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return fs.readFileSync(filePath);
    } catch (err: any) {
      if ((err.code === 'EBUSY' || err.code === 'EACCES') && attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  return fs.readFileSync(filePath);
}

export function assertPathInWorkspace(filePath: string): string {
  const resolved = path.resolve(filePath);
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    throw new Error(`Security violation: No workspace folder is open. Cannot access '${filePath}'.`);
  }
  // Resolve symlinks/junctions so a link inside the workspace cannot point outside it.
  const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return p; } };
  const normResolved = path.normalize(real(resolved)).toLowerCase();
  const isInWorkspace = workspaceFolders.some((wf) => {
    const root = path.normalize(real(wf.uri.fsPath)).toLowerCase();
    const rel = path.relative(root, normResolved);
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  });
  if (!isInWorkspace) {
    throw new Error(`Security violation: file path '${filePath}' is outside the open workspace folders.`);
  }
  return resolved;
}

export async function checkAgentApproval(filePath: string, actionDesc: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('eide.agent');
  const requireApproval = config.get<boolean>('requireApproval', false);
  if (requireApproval) {
    const choice = await vscode.window.showInformationMessage(
      `Allow agent change to ${path.basename(filePath)}: ${actionDesc}?`,
      { modal: true },
      'Allow',
      'Reject'
    );
    if (choice !== 'Allow') {
      throw new Error(`Agent change rejected by user: ${actionDesc}`);
    }
  }
}

export async function revealEditorForFile(filePath: string): Promise<void> {
  const uri = vscode.Uri.file(path.resolve(filePath));
  const ext = path.extname(filePath).toLowerCase();
  let viewType: string | undefined;
  if (ext === '.asc') viewType = 'eide.ltspiceSchematic';
  else if (ext === '.kicad_sch') viewType = 'eide.kicadSchematic';
  else if (ext === '.slx') viewType = 'eide.simulinkModel';

  if (!viewType) return;

  const openTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
  const alreadyOpen = openTabs.some((t) => {
    const input = t.input as any;
    return input?.uri?.fsPath?.toLowerCase() === uri.fsPath.toLowerCase();
  });

  if (!alreadyOpen) {
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, viewType, vscode.ViewColumn.Beside);
    } catch {}
  }
}

export interface OpenDesignItem {
  path: string;
  name: string;
  type: 'ltspice' | 'kicad' | 'simulink';
}

export function listOpenDesigns(): OpenDesignItem[] {
  const designs: OpenDesignItem[] = [];
  const seen = new Set<string>();

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as any;
      if (input && input.viewType && input.uri) {
        const fsPath = input.uri.fsPath;
        const key = fsPath.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        if (input.viewType === 'eide.ltspiceSchematic' || fsPath.endsWith('.asc')) {
          designs.push({ path: fsPath, name: path.basename(fsPath), type: 'ltspice' });
        } else if (input.viewType === 'eide.kicadSchematic' || fsPath.endsWith('.kicad_sch')) {
          designs.push({ path: fsPath, name: path.basename(fsPath), type: 'kicad' });
        } else if (input.viewType === 'eide.simulinkModel' || fsPath.endsWith('.slx')) {
          designs.push({ path: fsPath, name: path.basename(fsPath), type: 'simulink' });
        }
      }
    }
  }

  for (const fsPath of activeSimulationWebviews.keys()) {
    if (!seen.has(fsPath)) {
      seen.add(fsPath);
      const ext = path.extname(fsPath).toLowerCase();
      if (ext === '.asc') {
        designs.push({ path: fsPath, name: path.basename(fsPath), type: 'ltspice' });
      } else if (ext === '.kicad_sch') {
        designs.push({ path: fsPath, name: path.basename(fsPath), type: 'kicad' });
      } else if (ext === '.slx') {
        designs.push({ path: fsPath, name: path.basename(fsPath), type: 'simulink' });
      }
    }
  }

  return designs;
}

async function getDocument(filePath: string): Promise<vscode.TextDocument> {
  const resolved = assertPathInWorkspace(filePath);
  const uri = vscode.Uri.file(resolved);
  const openDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath.toLowerCase() === uri.fsPath.toLowerCase()
  );
  if (openDoc) return openDoc;
  return await vscode.workspace.openTextDocument(uri);
}

// --- LTspice Agent Tools ---

export async function getSchematic(filePath: string): Promise<AscSchematic> {
  const doc = await getDocument(filePath);
  return parseAsc(doc.getText());
}

export async function setComponentValue(
  filePath: string,
  id: string,
  value: string
): Promise<{ success: boolean; summary?: CompactSimulationSummary }> {
  const resolved = assertPathInWorkspace(filePath);
  await checkAgentApproval(resolved, `Set ${id} to ${value}`);
  await revealEditorForFile(resolved);

  const doc = await getDocument(resolved);
  const schematic = parseAsc(doc.getText());
  const oldSymbol = schematic.symbols.find((s) => s.id === id);
  const oldValue = oldSymbol?.attrs['Value']?.value || '';

  const edit = symbolAttrEdit(schematic, id, 'Value', value);
  if (!edit) {
    throw new Error(`Symbol '${id}' not found in ${resolved} or invalid attribute`);
  }

  // Record history snapshot before edit
  const historyMgr = AgentHistoryManager.getInstance();
  await historyMgr.recordBeforeChange(resolved, `${id} ${oldValue} -> ${value}`);

  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const we = new vscode.WorkspaceEdit();

  if (!edit.insert) {
    we.replace(doc.uri, doc.lineAt(edit.line).range, edit.text);
  } else if (edit.line < doc.lineCount) {
    we.insert(doc.uri, new vscode.Position(edit.line, 0), edit.text + eol);
  } else {
    we.insert(doc.uri, doc.lineAt(doc.lineCount - 1).range.end, eol + edit.text);
  }

  const success = await vscode.workspace.applyEdit(we);
  if (!success) {
    return { success: false };
  }

  await doc.save();

  // Re-simulate after edit and post banner
  const simStartTime = Date.now();
  let simResult: SimulationRunResult | undefined;
  let summary: CompactSimulationSummary | undefined;

  try {
    simResult = await runSimulationRaw(resolved);
    if (simResult?.raw) {
      summary = summarizeSimulationData({
        plotName: simResult.raw.plotName,
        x: Array.from(simResult.raw.x),
        series: simResult.raw.series,
        measurements: simResult.log.measurements,
      });
    }
  } catch {}

  const durationSec = (Date.now() - simStartTime) / 1000;
  historyMgr.postAgentBanner(
    resolved,
    `Agent: ${id} ${oldValue} -> ${value}`,
    durationSec
  );

  return { success: true, summary };
}

async function runSimulationRaw(filePath: string): Promise<SimulationRunResult> {
  const resolved = assertPathInWorkspace(filePath);
  const config = vscode.workspace.getConfiguration('eide.ltspice');
  const customPath = config.get<string>('path');
  const timeoutSec = config.get<number>('timeout', 60);

  const exe = findLtspice(customPath);
  if (!exe) {
    throw new Error('LTspice executable not found. Please set eide.ltspice.path in settings.');
  }

  const doc = await getDocument(resolved);
  const ascContent = doc.getText();

  const result = await runLtspiceSimulation({
    executablePath: exe,
    ascPath: doc.uri.fsPath,
    ascContent,
    timeoutMs: timeoutSec * 1000,
  });

  if (result.raw) {
    postToEditorWebview(doc.uri.fsPath, {
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
          ])
        ),
      },
      bannerText: `Simulation finished in ${(result.durationMs / 1000).toFixed(1)} s`,
    });
  }

  return result;
}

export async function runSimulation(filePath: string): Promise<CompactSimulationSummary> {
  const result = await runSimulationRaw(filePath);
  if (!result.raw) {
    throw new Error(`Simulation failed: ${result.error || 'No waveform data produced'}`);
  }

  return summarizeSimulationData({
    plotName: result.raw.plotName,
    x: Array.from(result.raw.x),
    series: result.raw.series,
    measurements: result.log.measurements,
  });
}

export async function getMeasurements(filePath: string): Promise<Record<string, number>> {
  const result = await runSimulationRaw(filePath);
  return result.log.measurements;
}

// --- KiCad Agent Tools ---

export interface KicadSchematicSummary {
  components: Array<{ ref: string; value: string; footprint: string; libId: string }>;
  nets: KicadNet[];
  labels: Array<{ name: string; type: string }>;
}

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

export async function setKicadProperty(
  filePath: string,
  ref: string,
  key: string,
  value: string
): Promise<{ success: boolean; summary?: CompactSimulationSummary }> {
  const resolved = assertPathInWorkspace(filePath);
  await checkAgentApproval(resolved, `Set ${ref} ${key} to ${value}`);
  await revealEditorForFile(resolved);

  const doc = await getDocument(resolved);
  const sch = parseKicadSch(doc.getText());
  const oldSymbol = sch.symbols.find((s) => s.ref === ref);
  const oldValue = oldSymbol ? (oldSymbol as any)[key.toLowerCase()] || '' : '';

  const edit = propertyEdit(sch, ref, key, value, doc.getText());
  if (!edit) {
    throw new Error(`Symbol '${ref}' or property '${key}' not found in ${resolved}`);
  }

  const historyMgr = AgentHistoryManager.getInstance();
  await historyMgr.recordBeforeChange(resolved, `${ref} ${key}: ${oldValue} -> ${value}`);

  const startPos = doc.positionAt(edit.start);
  const endPos = doc.positionAt(edit.end);

  const we = new vscode.WorkspaceEdit();
  we.replace(doc.uri, new vscode.Range(startPos, endPos), edit.text);
  const success = await vscode.workspace.applyEdit(we);

  if (!success) {
    return { success: false };
  }

  await doc.save();

  // Re-simulate if possible
  const simStartTime = Date.now();
  let summary: CompactSimulationSummary | undefined;
  try {
    const res = await simulateKicadRaw(resolved);
    if (res.runResult?.raw) {
      summary = summarizeSimulationData({
        plotName: res.runResult.raw.plotName,
        x: Array.from(res.runResult.raw.x),
        series: res.runResult.raw.series,
        measurements: res.runResult.log.measurements,
      });
    }
  } catch {}

  const durationSec = (Date.now() - simStartTime) / 1000;
  historyMgr.postAgentBanner(
    resolved,
    `Agent: ${ref} ${key} -> ${value}`,
    durationSec
  );

  return { success: true, summary };
}

export async function runErc(filePath: string): Promise<ErcRunResult> {
  const resolved = assertPathInWorkspace(filePath);
  const config = vscode.workspace.getConfiguration('eide.kicad');
  const cliPath = findKicadCli(config.get<string>('cliPath'));
  if (!cliPath) {
    throw new Error('kicad-cli not found. Please set eide.kicad.cliPath in settings.');
  }

  const doc = await getDocument(resolved);
  if (doc.isDirty) {
    await doc.save();
  }

  return await cliRunErc({
    cliPath,
    schPath: doc.uri.fsPath,
  });
}

async function simulateKicadRaw(filePath: string): Promise<KicadSimResult> {
  const resolved = assertPathInWorkspace(filePath);
  const config = vscode.workspace.getConfiguration('eide');
  const ltspicePath = findLtspice(config.get<string>('ltspice.path'));
  const kicadCliPath = findKicadCli(config.get<string>('kicad.cliPath'));

  if (!ltspicePath) {
    throw new Error('LTspice executable not found. Please set eide.ltspice.path in settings.');
  }
  if (!kicadCliPath) {
    throw new Error('kicad-cli not found. Please set eide.kicad.cliPath in settings.');
  }

  const doc = await getDocument(resolved);
  const result = await simulateKicadSchematic({
    kicadCliPath,
    ltspicePath,
    schPath: doc.uri.fsPath,
    schContent: doc.getText(),
  });

  if (result.runResult?.raw) {
    const raw = result.runResult.raw;
    postToEditorWebview(doc.uri.fsPath, {
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
          ])
        ),
      },
      bannerText: `Simulation finished in ${(result.runResult.durationMs / 1000).toFixed(1)} s`,
    });
  }

  return result;
}

export async function simulateKicad(filePath: string): Promise<CompactSimulationSummary> {
  const res = await simulateKicadRaw(filePath);
  if (!res.runResult?.raw) {
    throw new Error(`KiCad simulation failed: ${res.error || 'No waveforms generated'}`);
  }

  return summarizeSimulationData({
    plotName: res.runResult.raw.plotName,
    x: Array.from(res.runResult.raw.x),
    series: res.runResult.raw.series,
    measurements: res.runResult.log.measurements,
  });
}

// --- MATLAB & Simulink Agent Tools ---

let activeMatlabBridge: MatlabBridge | undefined;

export function setMatlabBridge(bridge: MatlabBridge) {
  activeMatlabBridge = bridge;
}

export function getMatlabBridge(): MatlabBridge {
  if (!activeMatlabBridge) {
    throw new Error('MATLAB bridge is not initialized.');
  }
  return activeMatlabBridge;
}

export async function runMatlabScript(filePath: string): Promise<ScriptRunResult> {
  const resolved = assertPathInWorkspace(filePath);
  if (!resolved.toLowerCase().endsWith('.m')) {
    throw new Error('runMatlabScript can only execute .m script files inside the workspace.');
  }

  const bridge = getMatlabBridge();
  if (bridge.getStatus() === 'off') {
    await bridge.start();
  }
  const exportDir = path.join(os.tmpdir(), 'eide_figures');
  return await bridge.runScript(resolved, exportDir);
}

export async function getSimulinkModel(filePath: string): Promise<SlxModel> {
  const resolved = assertPathInWorkspace(filePath);
  const buf = fs.readFileSync(resolved);
  const modelName = path.basename(resolved, '.slx');
  return parseSlx(buf, modelName);
}

export async function setBlockParam(
  filePath: string,
  block: string,
  param: string,
  value: string | number
): Promise<{ saved: boolean; summary?: CompactSimulationSummary }> {
  const resolved = assertPathInWorkspace(filePath);
  await checkAgentApproval(resolved, `Set block ${block} ${param} to ${value}`);
  await revealEditorForFile(resolved);

  const historyMgr = AgentHistoryManager.getInstance();
  await historyMgr.recordBeforeChange(resolved, `${block}.${param} = ${value}`);

  const bridge = getMatlabBridge();
  if (bridge.getStatus() === 'off') {
    await bridge.start();
  }

  const res = await bridge.setParam(resolved, block, param, value);

  // Update open webview
  const buf = await readFileWithRetry(resolved);
  const model = parseSlx(buf, path.basename(resolved, '.slx'));
  postToEditorWebview(resolved, {
    type: 'update',
    model,
    fileName: path.basename(resolved),
  });

  // Re-simulate
  const simStartTime = Date.now();
  let summary: CompactSimulationSummary | undefined;
  try {
    summary = await simulateModel(resolved);
  } catch {}

  const durationSec = (Date.now() - simStartTime) / 1000;
  historyMgr.postAgentBanner(
    resolved,
    `Agent: ${block}.${param} = ${value}`,
    durationSec
  );

  return { saved: res.saved, summary };
}

export async function connectBlocks(
  filePath: string,
  src: string,
  dst: string
): Promise<{ lineHandle: number }> {
  const resolved = assertPathInWorkspace(filePath);
  await checkAgentApproval(resolved, `Connect ${src} -> ${dst}`);
  await revealEditorForFile(resolved);

  const historyMgr = AgentHistoryManager.getInstance();
  await historyMgr.recordBeforeChange(resolved, `Connect ${src} -> ${dst}`);

  const bridge = getMatlabBridge();
  if (bridge.getStatus() === 'off') {
    await bridge.start();
  }

  const res = await bridge.addLine(resolved, src, dst);

  const buf = await readFileWithRetry(resolved);
  const model = parseSlx(buf, path.basename(resolved, '.slx'));
  postToEditorWebview(resolved, {
    type: 'update',
    model,
    fileName: path.basename(resolved),
  });

  historyMgr.postAgentBanner(resolved, `Agent: connected ${src} -> ${dst}`);
  return res;
}

export async function simulateModel(
  filePath: string,
  stopTime?: number | string
): Promise<CompactSimulationSummary> {
  const resolved = assertPathInWorkspace(filePath);
  const bridge = getMatlabBridge();
  if (bridge.getStatus() === 'off') {
    await bridge.start();
  }

  const res = await bridge.simulate(resolved, stopTime);

  const seriesObj: Record<string, number[]> = {};
  let xTime: number[] = [];

  if (res.signals.length > 0) {
    xTime = res.signals[0].time;
    for (const s of res.signals) {
      seriesObj[s.name] = s.values;
    }
  }

  if (res.signals.length > 0) {
    const variables = ['time', ...res.signals.map((s) => s.name)];
    postToEditorWebview(resolved, {
      type: 'simulationResult',
      current: {
        plotName: 'Simulink Simulation',
        variables,
        x: xTime,
        series: seriesObj,
      },
      success: true,
      durationMs: 0,
      bannerText: 'Simulation finished',
    });
  }

  return summarizeSimulationData({
    plotName: 'Simulink Simulation',
    x: xTime,
    series: seriesObj,
  });
}

// --- Waveform Downsampling Tool ---

export async function getWaveform(
  filePath: string,
  signal: string,
  maxPoints: number = 200
): Promise<{
  file: string;
  signal: string;
  totalPoints: number;
  returnedPoints: number;
  x: number[];
  y: number[];
}> {
  const resolved = assertPathInWorkspace(filePath);
  const ext = path.extname(resolved).toLowerCase();

  let x: number[] = [];
  let y: number[] = [];

  if (ext === '.asc') {
    const simRes = await runSimulationRaw(resolved);
    if (!simRes.raw) throw new Error('No simulation data available');
    x = Array.from(simRes.raw.x);
    const data = simRes.raw.series[signal];
    if (!data) {
      throw new Error(`Signal '${signal}' not found in simulation. Available: ${Object.keys(simRes.raw.series).join(', ')}`);
    }
    if (Array.isArray(data) || data instanceof Float64Array) {
      y = Array.from(data);
    } else {
      // Complex: return magnitude in dB
      y = Array.from(data.re).map((re, i) => 20 * Math.log10(Math.hypot(re, data.im[i]) || 1e-15));
    }
  } else if (ext === '.kicad_sch') {
    const simRes = await simulateKicadRaw(resolved);
    const raw = simRes.runResult?.raw;
    if (!raw) throw new Error('No simulation data available');
    x = Array.from(raw.x);
    const data = raw.series[signal];
    if (!data) {
      throw new Error(`Signal '${signal}' not found in simulation. Available: ${Object.keys(raw.series).join(', ')}`);
    }
    if (Array.isArray(data) || data instanceof Float64Array) {
      y = Array.from(data);
    } else {
      y = Array.from(data.re).map((re, i) => 20 * Math.log10(Math.hypot(re, data.im[i]) || 1e-15));
    }
  } else if (ext === '.slx') {
    const bridge = getMatlabBridge();
    const simRes = await bridge.simulate(resolved);
    const foundSig = simRes.signals.find((s) => s.name === signal);
    if (!foundSig) {
      throw new Error(`Signal '${signal}' not found. Available: ${simRes.signals.map((s) => s.name).join(', ')}`);
    }
    x = foundSig.time;
    y = foundSig.values;
  } else {
    throw new Error(`Unsupported file type '${ext}' for getWaveform`);
  }

  const downsampled = downsampleSeries(x, y, maxPoints);
  return {
    file: path.basename(resolved),
    signal,
    totalPoints: x.length,
    returnedPoints: downsampled.x.length,
    x: downsampled.x,
    y: downsampled.y,
  };
}

export async function undoAgentChange(filePath: string): Promise<boolean> {
  const resolved = assertPathInWorkspace(filePath);
  const ext = path.extname(resolved).toLowerCase();

  if (ext === '.slx') {
    try {
      const bridge = getMatlabBridge();
      if (bridge.getStatus() === 'ready') {
        await bridge.closeModel(resolved);
      }
    } catch {}
  }

  return await AgentHistoryManager.getInstance().undoLastChange(resolved, async () => {
    const startTime = Date.now();
    if (ext === '.asc') {
      await runSimulationRaw(resolved);
    } else if (ext === '.kicad_sch') {
      await simulateKicadRaw(resolved);
    } else if (ext === '.slx') {
      await simulateModel(resolved);
    }
    return (Date.now() - startTime) / 1000;
  });
}
