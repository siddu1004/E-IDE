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

describe('LTspice Integration Flows', () => {
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

  it('opens rc_lowpass.asc, receives update, simulates, and auto-simulates on setAttr', async function () {
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

    // 1. Initial update received
    const initialUpdate = await handle.waitForMessage((m) => m.type === 'update');
    assert.ok(initialUpdate.schematic);
    assert.equal(initialUpdate.fileName, 'rc_lowpass.asc');

    // Send ready to trigger simulation or run simulation directly
    await handle.sendWebviewMessage({ type: 'runSimulation' });
    const simRes1 = await handle.waitForMessage((m) => m.type === 'simulationResult');
    assert.equal(simRes1.success, true);
    assert.ok(simRes1.current);
    assert.ok(simRes1.current.series['V(out)']);

    // 2. Change R1 value via setAttr message
    await handle.sendWebviewMessage({
      type: 'setAttr',
      id: 'R1',
      key: 'Value',
      value: '20k',
    });

    // Verify document text changed
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.match(doc.getText(), /SYMATTR InstName R1[\s\S]*?SYMATTR Value 20k/);

    // Verify update message lists R1 in changes.symbols
    const changeUpdate = await handle.waitForMessage(
      (m) => m.type === 'update' && m.changes?.symbols?.includes('R1')
    );
    assert.ok(changeUpdate);

    // Verify auto-run simulation posts second result with previous result
    const simRes2 = await handle.waitForMessage(
      (m) => m.type === 'simulationResult' && m.previous !== undefined
    );
    assert.equal(simRes2.success, true);
    assert.ok(simRes2.previous);
    assert.ok(simRes2.current.series['V(out)']);
  });
});
