import * as assert from 'assert';
import * as child_process from 'child_process';
import * as fs from 'fs';
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

describe('Simulink Integration Flows', () => {
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

  it('opens rc_circuit.slx, modifies parameters, simulates with overlay, and handles external saves', async function () {
    const tools = checkTools();
    if (!tools.hasMatlab) {
      this.skip();
      return;
    }

    const bridge = getMatlabBridge();
    if (bridge.getStatus() === 'off') {
      await bridge.start();
    }

    const slxPath = path.join(tempDir, 'rc_circuit.slx');
    fs.copyFileSync(path.join(samplesDir, 'rc_circuit.slx'), slxPath);
    const uri = vscode.Uri.file(slxPath);

    await vscode.commands.executeCommand('vscode.openWith', uri, 'eide.simulinkModel');
    const handle = await waitForTestHandle(uri);

    // Initial update
    const initUpdate = await handle.waitForMessage((m) => m.type === 'update');
    assert.ok(initUpdate.model);
    assert.equal(initUpdate.fileName, 'rc_circuit.slx');

    // 1. Change parameter via setParam
    await handle.sendWebviewMessage({
      type: 'setParam',
      block: 'RC_Filter',
      param: 'Denominator',
      value: '[0.2 1]',
    });

    // File watcher posts update highlighting changed block
    const updateWithDiff = await handle.waitForMessage(
      (m) => m.type === 'update' && m.changes?.changedBlockSids?.length > 0,
      35000
    );
    assert.ok(updateWithDiff);

    // 2. Simulate and get simulationResult
    await handle.sendWebviewMessage({ type: 'simulate', stopTime: 5 });
    const simRes1 = await handle.waitForMessage((m) => m.type === 'simulationResult', 35000);
    assert.equal(simRes1.success, true);
    assert.ok(simRes1.current);

    // 3. Enable logging on signal line and re-simulate
    await handle.sendWebviewMessage({
      type: 'enableLogging',
      line: { srcBlock: 'Step', srcPort: 1 },
    });
    const simRes2 = await handle.waitForMessage(
      (m) => m.type === 'simulationResult' && m.previous !== undefined,
      35000
    );
    assert.equal(simRes2.success, true);
    assert.ok(simRes2.previous);

    // 4. External save: mutate model via matlab -batch
    const normalizedSlx = slxPath.replace(/\\/g, '/');
    const batchCmd = `load_system('${normalizedSlx}'); set_param('rc_circuit/Step', 'SampleTime', '0.01'); save_system('rc_circuit', '${normalizedSlx}'); close_system('rc_circuit');`;

    child_process.execFileSync(tools.matlabPath!, ['-batch', batchCmd], {
      timeout: 45000,
    });

    // Verify watcher detects disk change and posts highlight update
    const extUpdate = await handle.waitForMessage(
      (m) => m.type === 'update' && m.changes?.changedBlockSids?.length > 0,
      25000
    );
    assert.ok(extUpdate);
  });
});
