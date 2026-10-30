import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getMatlabBridge } from '../../src/agent/tools';
import {
  checkTools,
  cleanupTestWorkspace,
  closeAllEditors,
  setupTestWorkspace,
  waitForTestHandle,
} from './testHelpers';

describe('Visual Inspection and Theme Screenshots', function () {
  this.timeout(120000);

  let tempDir: string;
  let samplesDir: string;

  before(async () => {
    const ws = await setupTestWorkspace();
    tempDir = ws.tempDir;
    samplesDir = ws.samplesDir;
  });

  after(async () => {
    await closeAllEditors();
    cleanupTestWorkspace(tempDir);
  });

  afterEach(async () => {
    await closeAllEditors();
  });

  async function setTheme(themeName: string) {
    await vscode.workspace
      .getConfiguration('workbench')
      .update('colorTheme', themeName, vscode.ConfigurationTarget.Global);
    await new Promise((r) => setTimeout(r, 1000));
  }

  it('captures LTspice editor screenshots after simulation in light and dark themes', async function () {
    const tools = checkTools();
    if (!tools.hasLtspice) {
      this.skip();
      return;
    }

    const ascPath = path.join(tempDir, 'rc_lowpass_vis.asc');
    fs.copyFileSync(path.join(samplesDir, 'rc_lowpass.asc'), ascPath);
    const uri = vscode.Uri.file(ascPath);

    await vscode.commands.executeCommand('vscode.openWith', uri, 'eide.ltspiceSchematic');
    const handle = await waitForTestHandle(uri);

    // Run simulation
    await handle.sendWebviewMessage({ type: 'runSimulation' });
    await handle.waitForMessage((m) => m.type === 'simulationResult' && m.success, 30000);

    // Dark theme
    await setTheme('Default Dark Modern');
    await handle.postMessage({ type: 'captureSnapshot', name: 'ltspice_rc_lowpass_dark' });
    await handle.waitForMessage((m) => m.type === 'snapshotSaved' && m.name === 'ltspice_rc_lowpass_dark', 15000);

    // Light theme
    await setTheme('Default Light Modern');
    await handle.postMessage({ type: 'captureSnapshot', name: 'ltspice_rc_lowpass_light' });
    await handle.waitForMessage((m) => m.type === 'snapshotSaved' && m.name === 'ltspice_rc_lowpass_light', 15000);
  });

  it('captures KiCad editor screenshots after simulation in light and dark themes', async function () {
    const tools = checkTools();
    if (!tools.hasLtspice) {
      this.skip();
      return;
    }

    const schPath = path.join(tempDir, 'rc_filter_vis.kicad_sch');
    fs.copyFileSync(path.join(samplesDir, 'rc_filter.kicad_sch'), schPath);
    const uri = vscode.Uri.file(schPath);

    await vscode.commands.executeCommand('vscode.openWith', uri, 'eide.kicadSchematic');
    const handle = await waitForTestHandle(uri);

    // Run simulation
    await handle.sendWebviewMessage({ type: 'runSimulation' });
    await handle.waitForMessage((m) => m.type === 'simulationResult' && m.success, 30000);

    // Dark theme
    await setTheme('Default Dark Modern');
    await handle.postMessage({ type: 'captureSnapshot', name: 'kicad_rc_filter_dark' });
    await handle.waitForMessage((m) => m.type === 'snapshotSaved' && m.name === 'kicad_rc_filter_dark', 15000);

    // Light theme
    await setTheme('Default Light Modern');
    await handle.postMessage({ type: 'captureSnapshot', name: 'kicad_rc_filter_light' });
    await handle.waitForMessage((m) => m.type === 'snapshotSaved' && m.name === 'kicad_rc_filter_light', 15000);
  });

  it('captures Simulink editor screenshots after simulation in light and dark themes', async function () {
    const tools = checkTools();
    if (!tools.hasMatlab) {
      this.skip();
      return;
    }

    const bridge = getMatlabBridge();
    if (bridge.getStatus() === 'off') {
      await bridge.start();
    }

    const slxPath = path.join(tempDir, 'rc_circuit_vis.slx');
    fs.copyFileSync(path.join(samplesDir, 'rc_circuit.slx'), slxPath);
    const uri = vscode.Uri.file(slxPath);

    await vscode.commands.executeCommand('vscode.openWith', uri, 'eide.simulinkModel');
    const handle = await waitForTestHandle(uri);

    await handle.waitForMessage((m) => m.type === 'update');

    // Simulate model
    await handle.sendWebviewMessage({ type: 'simulate', stopTime: 10 });
    await handle.waitForMessage((m) => m.type === 'simulationResult', 60000);

    // Dark theme
    await setTheme('Default Dark Modern');
    await handle.postMessage({ type: 'captureSnapshot', name: 'simulink_rc_circuit_dark' });
    await handle.waitForMessage((m) => m.type === 'snapshotSaved' && m.name === 'simulink_rc_circuit_dark', 15000);

    // Light theme
    await setTheme('Default Light Modern');
    await handle.postMessage({ type: 'captureSnapshot', name: 'simulink_rc_circuit_light' });
    await handle.waitForMessage((m) => m.type === 'snapshotSaved' && m.name === 'simulink_rc_circuit_light', 15000);
  });
});
