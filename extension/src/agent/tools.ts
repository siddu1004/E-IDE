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
import { AppFileWatcher } from '../mirror/appWatcher';
import { TestHook } from '../testHook';
import {
  CompactSimulationSummary,
  downsampleSeries,
  summarizeSimulationData,
} from './waveformSummary';
import {
  addComponentToAsc,
  addDirectiveToAsc,
  connectPinsInAsc,
  createEmptySchematic,
  removeComponentFromAsc,
} from './schematicBuilder';
import { DesignSpec, evaluateSpec, SpecCheckResult } from './specChecker';
import { runTuner, TuneParamConfig, TuneResult } from './tuner';
import { validateSimulinkLibraryPath } from '../matlab/matlabBridge';
import { findArduinoCli } from '../arduino/arduinoFinder';
import {
  BoardInfo,
  ConnectedBoardPort,
  CompileResult,
  UploadResult,
  listBoards as runnerListBoards,
  compileSketch as runnerCompileSketch,
  uploadSketch as runnerUploadSketch,
} from '../arduino/arduinoRunner';
import {
  CompactSerialSummary,
  readSerialSummary,
  SerialPortCoordinator,
} from '../arduino/serialMonitor';

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
  const m9Root = path.normalize(real(path.join(os.tmpdir(), 'eide-m9'))).toLowerCase();
  const relM9 = path.relative(m9Root, normResolved);
  const isInM9Temp = relM9 !== '..' && !relM9.startsWith('..' + path.sep) && !path.isAbsolute(relM9);
  const isWatched = AppFileWatcher.getInstance()?.isWatching(resolved) ?? false;
  if (!isInWorkspace && !isInM9Temp && !isWatched) {
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
  value: string,
  skipResimulate?: boolean
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
  historyMgr.markAgentEditing(resolved);
  AppFileWatcher.getInstance()?.handleFileChange(resolved).catch(() => {});

  if (skipResimulate) {
    return { success: true };
  }

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
  value: string,
  skipResimulate?: boolean
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
  historyMgr.markAgentEditing(resolved);
  AppFileWatcher.getInstance()?.handleFileChange(resolved).catch(() => {});

  if (skipResimulate) {
    return { success: true };
  }

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
  historyMgr.markAgentEditing(resolved);
  AppFileWatcher.getInstance()?.handleFileChange(resolved).catch(() => {});

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


// --- Milestone 6: Design Synthesis & Tuning Tools ---

export async function createSchematic(filePath: string): Promise<{ created: boolean; filePath: string }> {
  const resolved = assertPathInWorkspace(filePath);
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== '.asc' && ext !== '.kicad_sch') {
    throw new Error('createSchematic only supports .asc and .kicad_sch files');
  }

  await checkAgentApproval(resolved, `Create schematic ${path.basename(resolved)}`);
  const initialText = createEmptySchematic(ext as '.asc' | '.kicad_sch');
  fs.writeFileSync(resolved, initialText, 'utf8');

  const uri = vscode.Uri.file(resolved);
  const viewType = ext === '.asc' ? 'eide.ltspiceSchematic' : 'eide.kicadSchematic';
  await vscode.commands.executeCommand('vscode.openWith', uri, viewType);

  AgentHistoryManager.getInstance().postAgentBanner(resolved, `Agent: created empty schematic ${path.basename(resolved)}`);
  return { created: true, filePath: resolved };
}

export async function addComponent(
  filePath: string,
  type: string,
  value: string,
  near?: string,
  orientation?: string
): Promise<{ ref: string; filePath: string }> {
  const resolved = assertPathInWorkspace(filePath);
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== '.asc') {
    throw new Error('addComponent currently supports .asc files');
  }

  await checkAgentApproval(resolved, `Add ${type} (${value})`);
  await revealEditorForFile(resolved);

  const historyMgr = AgentHistoryManager.getInstance();
  await historyMgr.recordBeforeChange(resolved, `Add ${type} (${value})`);

  const uri = vscode.Uri.file(resolved);
  const doc = await vscode.workspace.openTextDocument(uri);
  const currentText = doc.getText();

  const res = addComponentToAsc(currentText, type, value, near, orientation);

  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(currentText.length));
  edit.replace(uri, fullRange, res.newContent);
  await vscode.workspace.applyEdit(edit);
  await doc.save();

  historyMgr.postAgentBanner(resolved, `Agent: added ${res.ref} (${type} ${value})`);
  return { ref: res.ref, filePath: resolved };
}

export async function connect(
  filePath: string,
  pinA: string,
  pinB: string
): Promise<{ connected: boolean; pinA: string; pinB: string }> {
  const resolved = assertPathInWorkspace(filePath);
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== '.asc') {
    throw new Error('connect currently supports .asc files');
  }

  await checkAgentApproval(resolved, `Connect ${pinA} -> ${pinB}`);
  await revealEditorForFile(resolved);

  const historyMgr = AgentHistoryManager.getInstance();
  await historyMgr.recordBeforeChange(resolved, `Connect ${pinA} -> ${pinB}`);

  const uri = vscode.Uri.file(resolved);
  const doc = await vscode.workspace.openTextDocument(uri);
  const currentText = doc.getText();

  const newContent = connectPinsInAsc(currentText, pinA, pinB);

  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(currentText.length));
  edit.replace(uri, fullRange, newContent);
  await vscode.workspace.applyEdit(edit);
  await doc.save();

  historyMgr.postAgentBanner(resolved, `Agent: connected ${pinA} -> ${pinB}`);
  return { connected: true, pinA, pinB };
}

export async function removeComponent(
  filePath: string,
  ref: string
): Promise<{ removed: boolean; ref: string }> {
  const resolved = assertPathInWorkspace(filePath);
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== '.asc') {
    throw new Error('removeComponent currently supports .asc files');
  }

  await checkAgentApproval(resolved, `Remove component ${ref}`);
  await revealEditorForFile(resolved);

  const historyMgr = AgentHistoryManager.getInstance();
  await historyMgr.recordBeforeChange(resolved, `Remove component ${ref}`);

  const uri = vscode.Uri.file(resolved);
  const doc = await vscode.workspace.openTextDocument(uri);
  const currentText = doc.getText();

  const newContent = removeComponentFromAsc(currentText, ref);

  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(currentText.length));
  edit.replace(uri, fullRange, newContent);
  await vscode.workspace.applyEdit(edit);
  await doc.save();

  historyMgr.postAgentBanner(resolved, `Agent: removed ${ref}`);
  return { removed: true, ref };
}

export async function addDirective(
  filePath: string,
  text: string
): Promise<{ added: boolean; text: string }> {
  const resolved = assertPathInWorkspace(filePath);
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== '.asc') {
    throw new Error('addDirective currently supports .asc files');
  }

  await checkAgentApproval(resolved, `Add directive ${text}`);
  await revealEditorForFile(resolved);

  const historyMgr = AgentHistoryManager.getInstance();
  await historyMgr.recordBeforeChange(resolved, `Add directive ${text}`);

  const uri = vscode.Uri.file(resolved);
  const doc = await vscode.workspace.openTextDocument(uri);
  const currentText = doc.getText();

  const newContent = addDirectiveToAsc(currentText, text);

  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(currentText.length));
  edit.replace(uri, fullRange, newContent);
  await vscode.workspace.applyEdit(edit);
  await doc.save();

  historyMgr.postAgentBanner(resolved, `Agent: added directive '${text}'`);
  return { added: true, text };
}

export async function createModel(filePath: string): Promise<{ created: boolean; model: string }> {
  const resolved = assertPathInWorkspace(filePath);
  if (!resolved.toLowerCase().endsWith('.slx')) {
    throw new Error('createModel only supports .slx models');
  }

  await checkAgentApproval(resolved, `Create model ${path.basename(resolved)}`);
  const bridge = getMatlabBridge();
  if (bridge.getStatus() === 'off') {
    await bridge.start();
  }

  const res = await bridge.createModel(resolved);
  const uri = vscode.Uri.file(resolved);
  await vscode.commands.executeCommand('vscode.openWith', uri, 'eide.simulinkModel');

  AgentHistoryManager.getInstance().postAgentBanner(resolved, `Agent: created model ${path.basename(resolved)}`);
  return { created: true, model: res.model };
}

export async function addBlock(
  filePath: string,
  libraryPath: string,
  name: string,
  params?: Record<string, string>
): Promise<{ added: boolean; block: string }> {
  const resolved = assertPathInWorkspace(filePath);
  validateSimulinkLibraryPath(libraryPath);

  await checkAgentApproval(resolved, `Add block ${name} (${libraryPath})`);
  await revealEditorForFile(resolved);

  const historyMgr = AgentHistoryManager.getInstance();
  await historyMgr.recordBeforeChange(resolved, `Add block ${name}`);

  const bridge = getMatlabBridge();
  if (bridge.getStatus() === 'off') {
    await bridge.start();
  }

  const res = await bridge.addBlock(resolved, libraryPath, name, params);

  const buf = await readFileWithRetry(resolved);
  const model = parseSlx(buf, path.basename(resolved, '.slx'));
  postToEditorWebview(resolved, {
    type: 'update',
    model,
    fileName: path.basename(resolved),
  });

  historyMgr.postAgentBanner(resolved, `Agent: added block ${name}`);
  return res;
}

export async function removeBlock(
  filePath: string,
  name: string
): Promise<{ removed: boolean; block: string }> {
  const resolved = assertPathInWorkspace(filePath);
  await checkAgentApproval(resolved, `Remove block ${name}`);
  await revealEditorForFile(resolved);

  const historyMgr = AgentHistoryManager.getInstance();
  await historyMgr.recordBeforeChange(resolved, `Remove block ${name}`);

  const bridge = getMatlabBridge();
  if (bridge.getStatus() === 'off') {
    await bridge.start();
  }

  const res = await bridge.removeBlock(resolved, name);

  const buf = await readFileWithRetry(resolved);
  const model = parseSlx(buf, path.basename(resolved, '.slx'));
  postToEditorWebview(resolved, {
    type: 'update',
    model,
    fileName: path.basename(resolved),
  });

  historyMgr.postAgentBanner(resolved, `Agent: removed block ${name}`);
  return res;
}

export async function autoLayout(
  filePath: string
): Promise<{ arranged: boolean; model: string }> {
  const resolved = assertPathInWorkspace(filePath);
  await revealEditorForFile(resolved);

  const bridge = getMatlabBridge();
  if (bridge.getStatus() === 'off') {
    await bridge.start();
  }

  const res = await bridge.autoLayout(resolved);

  const buf = await readFileWithRetry(resolved);
  const model = parseSlx(buf, path.basename(resolved, '.slx'));
  postToEditorWebview(resolved, {
    type: 'update',
    model,
    fileName: path.basename(resolved),
  });

  AgentHistoryManager.getInstance().postAgentBanner(resolved, 'Agent: auto-arranged layout');
  return res;
}

export async function checkSpec(
  filePath: string,
  spec: DesignSpec
): Promise<SpecCheckResult> {
  const resolved = assertPathInWorkspace(filePath);
  const ext = path.extname(resolved).toLowerCase();

  let summary: CompactSimulationSummary;
  let rawWaveform: { x: number[]; y: number[] } | undefined;

  if (ext === '.asc') {
    const rawRes = await runSimulationRaw(resolved);
    if (!rawRes.raw) {
      throw new Error(`Simulation failed: ${rawRes.error || 'No raw output'}`);
    }
    const raw = rawRes.raw;
    summary = summarizeSimulationData({
      plotName: raw.plotName,
      x: Array.from(raw.x),
      series: raw.series,
      measurements: rawRes.log.measurements,
    });

    const targetSig = spec.signal || 'V(out)';
    let foundSeries = raw.series[targetSig];
    if (!foundSeries) {
      const matchKey = Object.keys(raw.series).find(
        (k) => k.toLowerCase() === targetSig.toLowerCase() ||
               k.toLowerCase() === 'v(' + targetSig.toLowerCase() + ')'
      );
      if (matchKey) foundSeries = raw.series[matchKey];
    }
    if (foundSeries) {
      rawWaveform = {
        x: Array.from(raw.x),
        y: foundSeries instanceof Float64Array ? Array.from(foundSeries) : Array.from(foundSeries.re),
      };
    }
  } else if (ext === '.slx') {
    const bridge = getMatlabBridge();
    const simRes = await bridge.simulate(resolved);
    const primary = simRes.signals.find((s) => s.name === spec.signal) || simRes.signals[0];
    if (!primary) {
      throw new Error('No simulation signals found in Simulink output');
    }
    rawWaveform = { x: primary.time, y: primary.values };
    summary = summarizeSimulationData({
      plotName: 'Simulink Simulation',
      x: primary.time,
      series: Object.fromEntries(simRes.signals.map((s) => [s.name, s.values])),
    });
  } else {
    throw new Error(`Unsupported file type ${ext} for checkSpec`);
  }

  return evaluateSpec(summary, spec, rawWaveform);
}

export async function tune(
  filePath: string,
  params: TuneParamConfig[],
  spec: DesignSpec,
  maxIterations: number = 20
): Promise<TuneResult> {
  const resolved = assertPathInWorkspace(filePath);
  const ext = path.extname(resolved).toLowerCase();

  await checkAgentApproval(resolved, `Tune ${params.map((p) => p.name).join(', ')} to spec`);
  await revealEditorForFile(resolved);

  const historyMgr = AgentHistoryManager.getInstance();
  // Finalize any previous pending turn so tune is an independent single undo step
  historyMgr.commitActiveTurn(resolved);
  await historyMgr.recordBeforeChange(resolved, `Tune ${params.map((p) => p.name).join(', ')}`);

  const res = await runTuner(
    params,
    async (values, iter) => {
      // 1. Apply candidate parameter values
      if (ext === '.asc') {
        for (const [name, val] of Object.entries(values)) {
          await setComponentValue(resolved, name, String(val), true);
        }
      } else if (ext === '.slx') {
        const bridge = getMatlabBridge();
        for (const [name, val] of Object.entries(values)) {
          await bridge.setParam(resolved, name, 'Value', String(val)).catch(async () => {
            await bridge.setParam(resolved, name, 'Gain', String(val)).catch(async () => {
              await bridge.setParam(resolved, name, 'Denominator', String(val));
            });
          });
        }
      }

      // 2. Evaluate spec
      const checkRes = await checkSpec(resolved, spec);
      return { pass: checkRes.pass, errorScore: checkRes.errorScore };
    },
    maxIterations,
    (progress) => {
      historyMgr.postAgentBanner(
        resolved,
        `Agent: tuning iteration ${progress.iteration}/${maxIterations} · error: ${progress.errorScore}%`
      );
    }
  );

  historyMgr.postAgentBanner(
    resolved,
    `Agent: ${res.success ? 'Successfully tuned' : 'Tuning finished'} in ${res.iterations} iterations · final error: ${res.finalError.toFixed(1)}%`
  );

  historyMgr.commitActiveTurn(resolved);
  return res;
}

// -------------------------------------------------------------
// Arduino Agent Tools
// -------------------------------------------------------------

export interface AgentListBoardsResult {
  connectedPorts: ConnectedBoardPort[];
  installedBoards: BoardInfo[];
}

/**
 * Lists connected boards and serial ports as well as installed board platforms.
 */
export async function listBoards(): Promise<AgentListBoardsResult> {
  const config = vscode.workspace.getConfiguration('eide.arduino');
  const customPath = config.get<string>('cliPath');
  const cliPath = findArduinoCli(customPath);
  if (!cliPath) {
    throw new Error('arduino-cli is not installed or not found on PATH. Configure eide.arduino.cliPath.');
  }

  const { detected, allBoards } = await runnerListBoards(cliPath);
  return { connectedPorts: detected, installedBoards: allBoards };
}

/**
 * Compiles an Arduino sketch for a specific FQBN (e.g. "arduino:avr:uno").
 */
// Agent-supplied values become arduino-cli arguments; a leading '-' would be read as a flag
// (e.g. --build-property can run commands at compile time), so only accept real-looking values.
function assertFqbn(fqbn: string): void {
  if (!/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+(:[A-Za-z0-9_.,=-]+)?$/.test(fqbn) || fqbn.startsWith('-')) {
    throw new Error(`Invalid board FQBN: ${fqbn}`);
  }
}

function assertPort(port: string): void {
  if (!/^[A-Za-z0-9_./:\-]+$/.test(port) || port.startsWith('-')) {
    throw new Error(`Invalid serial port: ${port}`);
  }
}

export async function compileSketch(sketchPath: string, fqbn: string): Promise<CompileResult> {
  assertFqbn(fqbn);
  const resolved = assertPathInWorkspace(sketchPath);
  const config = vscode.workspace.getConfiguration('eide.arduino');
  const customPath = config.get<string>('cliPath');
  const cliPath = findArduinoCli(customPath);
  if (!cliPath) {
    throw new Error('arduino-cli is not installed or not found on PATH. Configure eide.arduino.cliPath.');
  }

  const historyMgr = AgentHistoryManager.getInstance();
  historyMgr.postAgentBanner(resolved, `Agent: Compiling sketch for ${fqbn}...`);

  const controller = new AbortController();
  const res = await runnerCompileSketch(cliPath, resolved, fqbn, {
    signal: controller.signal,
  });

  if (res.success) {
    historyMgr.postAgentBanner(resolved, `Agent: Compilation succeeded (${res.durationMs}ms)`);
  } else {
    historyMgr.postAgentBanner(resolved, `Agent: Compilation failed - ${res.error || 'check errors'}`);
  }

  return res;
}

/**
 * Uploads an Arduino sketch to target board and serial port.
 * Always prompts user confirmation before flashing real hardware, regardless of requireApproval.
 */
export async function uploadSketch(sketchPath: string, fqbn: string, port: string): Promise<UploadResult> {
  assertFqbn(fqbn);
  assertPort(port);
  const resolved = assertPathInWorkspace(sketchPath);
  const config = vscode.workspace.getConfiguration('eide.arduino');
  const customPath = config.get<string>('cliPath');
  const cliPath = findArduinoCli(customPath);
  if (!cliPath) {
    throw new Error('arduino-cli is not installed or not found on PATH. Configure eide.arduino.cliPath.');
  }

  // Uploading changes physical hardware: always require explicit user confirmation
  const choice = await vscode.window.showWarningMessage(
    `Confirm upload to hardware port ${port} (${fqbn}) for sketch ${path.basename(resolved)}?`,
    { modal: true },
    'Upload',
    'Cancel'
  );
  if (choice !== 'Upload') {
    throw new Error(`Upload to ${port} rejected by user`);
  }

  const historyMgr = AgentHistoryManager.getInstance();
  historyMgr.postAgentBanner(resolved, `Agent: Uploading sketch to ${port} (${fqbn})...`);

  // First compile sketch
  const comp = await runnerCompileSketch(cliPath, resolved, fqbn);
  if (!comp.success) {
    historyMgr.postAgentBanner(resolved, `Agent: Upload aborted, compilation failed`);
    throw new Error(`Compilation failed prior to upload: ${comp.error}`);
  }

  // Release serial port if open in monitor, upload, and automatically reconnect
  const controller = new AbortController();
  const res = await SerialPortCoordinator.getInstance().withPortReleased(port, async () => {
    return await runnerUploadSketch(cliPath, resolved, fqbn, port, {
      signal: controller.signal,
    });
  });

  if (res.success) {
    historyMgr.postAgentBanner(resolved, `Agent: Upload successful to ${port}! (${res.durationMs}ms)`);
  } else {
    historyMgr.postAgentBanner(resolved, `Agent: Upload failed: ${res.error}`);
  }

  return res;
}

/**
 * Reads streaming data from serial port for given duration and returns a compact summary.
 */
export async function readSerial(
  port: string,
  baud: number = 115200,
  seconds: number = 2
): Promise<CompactSerialSummary> {
  assertPort(port);
  if (!Number.isInteger(baud) || baud < 300 || baud > 4000000) throw new Error(`Invalid baud rate: ${baud}`);
  seconds = Math.min(Math.max(Number(seconds) || 2, 0.5), 30);
  const config = vscode.workspace.getConfiguration('eide.arduino');
  const customPath = config.get<string>('cliPath');
  const cliPath = findArduinoCli(customPath);
  if (!cliPath) {
    throw new Error('arduino-cli is not installed or not found on PATH. Configure eide.arduino.cliPath.');
  }

  const controller = new AbortController();
  return await readSerialSummary(cliPath, port, baud, seconds, {
    signal: controller.signal,
  });
}

