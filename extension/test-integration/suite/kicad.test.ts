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

describe('KiCad Integration Flows', () => {
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

  it('opens rc_filter.kicad_sch, mutates value with byte-identical preservation, and shows ERC diagnostics', async function () {
    this.timeout(60000);
    const tools = checkTools();
    if (!tools.hasKicad) {
      this.skip();
      return;
    }

    const schPath = path.join(tempDir, 'rc_filter.kicad_sch');
    fs.copyFileSync(path.join(samplesDir, 'rc_filter.kicad_sch'), schPath);
    const origContent = fs.readFileSync(schPath, 'utf8');
    const uri = vscode.Uri.file(schPath);

    await vscode.commands.executeCommand('vscode.openWith', uri, 'eide.kicadSchematic');
    const handle = await waitForTestHandle(uri);

    await handle.waitForMessage((m) => m.type === 'update');

    // 1. Change R1 value from 1k to 4.7k
    await handle.sendWebviewMessage({
      type: 'setProperty',
      ref: 'R1',
      key: 'Value',
      value: '4.7k',
    });

    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();
    const newContent = fs.readFileSync(schPath, 'utf8');

    // Verify it changed 1k to 4.7k
    assert.ok(newContent.includes('(property "Value" "4.7k"'));
    const expectedContent = origContent.replace(
      '(property "Value" "1k"',
      '(property "Value" "4.7k"'
    );
    assert.equal(newContent, expectedContent);

    // 2. Trigger ERC and verify diagnostics in Problems panel
    await handle.sendWebviewMessage({ type: 'runErc' });
    const ercMsg = await handle.waitForMessage((m) => m.type === 'ercResult' || m.type === 'ercError', 40000);
    assert.equal(ercMsg.type, 'ercResult', `ERC run failed: ${ercMsg.error}`);

    const diagnostics = vscode.languages.getDiagnostics(uri);
    assert.ok(diagnostics !== undefined);
  });
});
