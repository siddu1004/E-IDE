import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  checkTools,
  cleanupTestWorkspace,
  closeAllEditors,
  setupTestWorkspace,
  waitForTestHandle,
} from './testHelpers';

describe('Stale-Run Race Condition', () => {
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

  it('drops cancelled run and posts only the newest simulation result', async function () {
    const tools = checkTools();
    if (!tools.hasLtspice) {
      this.skip();
      return;
    }

    const ascPath = path.join(tempDir, 'rc_lowpass.asc');
    fs.copyFileSync(path.join(samplesDir, 'rc_lowpass.asc'), ascPath);
    const uri = vscode.Uri.file(ascPath);

    await vscode.commands.executeCommand('vscode.openWith', uri, 'eide.ltspiceSchematic');
    const handle = await waitForTestHandle(uri);

    await handle.waitForMessage((m) => m.type === 'update');

    // Trigger run 1, then immediately trigger run 2 without awaiting run 1
    handle.sendWebviewMessage({ type: 'runSimulation' });
    // Small 20ms pause so run 1 has started its process
    await new Promise((r) => setTimeout(r, 20));
    handle.sendWebviewMessage({ type: 'runSimulation' });

    // Wait for simulation result
    const simRes = await handle.waitForMessage((m) => m.type === 'simulationResult');
    assert.equal(simRes.success, true);
    assert.ok(simRes.current);

    // Give a moment to confirm only one simulationResult message is posted
    await new Promise((r) => setTimeout(r, 2000));
    const results = handle.postedMessages.filter((m) => m.type === 'simulationResult');
    assert.equal(results.length, 1, 'Only one simulation result should be posted after rapid re-trigger');
  });
});
