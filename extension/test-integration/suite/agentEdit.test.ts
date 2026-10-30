import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  cleanupTestWorkspace,
  closeAllEditors,
  setupTestWorkspace,
  waitForTestHandle,
} from './testHelpers';

describe('Agent Edit While Open', () => {
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

  it('reflects external WorkspaceEdit with highlighted update in open editor', async () => {
    const ascPath = path.join(tempDir, 'rc_lowpass.asc');
    fs.copyFileSync(path.join(samplesDir, 'rc_lowpass.asc'), ascPath);
    const uri = vscode.Uri.file(ascPath);

    await vscode.commands.executeCommand('vscode.openWith', uri, 'eide.ltspiceSchematic');
    const handle = await waitForTestHandle(uri);

    await handle.waitForMessage((m) => m.type === 'update');

    // External WorkspaceEdit: change C1 to 200n
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    const c1Pos = text.indexOf('SYMATTR Value 100n');
    assert.ok(c1Pos >= 0);

    const range = new vscode.Range(
      doc.positionAt(c1Pos),
      doc.positionAt(c1Pos + 'SYMATTR Value 100n'.length)
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, range, 'SYMATTR Value 200n');
    const applied = await vscode.workspace.applyEdit(edit);
    assert.equal(applied, true);

    // Editor should post update highlighting C1
    const updateWithHighlight = await handle.waitForMessage(
      (m) => m.type === 'update' && m.changes?.symbols?.includes('C1')
    );
    assert.ok(updateWithHighlight);
    assert.ok(updateWithHighlight.changes.symbols.includes('C1'));
  });
});
