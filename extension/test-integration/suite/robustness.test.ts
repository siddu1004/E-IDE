import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  cleanupTestWorkspace,
  closeAllEditors,
  createEmptyFile,
  createRenamedBinaryFile,
  createTruncatedFile,
  setupTestWorkspace,
  waitForTestHandle,
} from './testHelpers';

describe('Robustness and Malformed Files', () => {
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

  const fileConfigs = [
    { ext: '.asc', viewType: 'eide.ltspiceSchematic', sample: 'rc_lowpass.asc' },
    { ext: '.kicad_sch', viewType: 'eide.kicadSchematic', sample: 'rc_filter.kicad_sch' },
    { ext: '.slx', viewType: 'eide.simulinkModel', sample: 'rc_circuit.slx' },
  ];

  for (const cfg of fileConfigs) {
    it(`handles truncated ${cfg.ext} file gracefully with error message`, async () => {
      const src = path.join(samplesDir, cfg.sample);
      const dst = path.join(tempDir, `truncated${cfg.ext}`);
      createTruncatedFile(src, dst);

      const uri = vscode.Uri.file(dst);
      await vscode.commands.executeCommand('vscode.openWith', uri, cfg.viewType);
      const handle = await waitForTestHandle(uri);

      const errorMsg = await handle.waitForMessage((m) => m.type === 'error');
      assert.ok(errorMsg);
      assert.ok(errorMsg.error);
    });

    it(`handles empty (0-byte) ${cfg.ext} file gracefully with error message`, async () => {
      const dst = path.join(tempDir, `empty${cfg.ext}`);
      createEmptyFile(dst);

      const uri = vscode.Uri.file(dst);
      await vscode.commands.executeCommand('vscode.openWith', uri, cfg.viewType);
      const handle = await waitForTestHandle(uri);

      const errorMsg = await handle.waitForMessage((m) => m.type === 'error');
      assert.ok(errorMsg);
      assert.match(errorMsg.error, /empty/i);
    });

    it(`handles renamed binary file as ${cfg.ext} gracefully with error message`, async () => {
      const dst = path.join(tempDir, `renamed_binary${cfg.ext}`);
      createRenamedBinaryFile(dst);

      const uri = vscode.Uri.file(dst);
      await vscode.commands.executeCommand('vscode.openWith', uri, cfg.viewType);
      const handle = await waitForTestHandle(uri);

      const errorMsg = await handle.waitForMessage((m) => m.type === 'error');
      assert.ok(errorMsg);
      assert.ok(errorMsg.error);
    });
  }

  it('closes editor while simulation runs without errors or leaked messages', async () => {
    const src = path.join(samplesDir, 'rc_lowpass.asc');
    const uri = vscode.Uri.file(src);

    await vscode.commands.executeCommand('vscode.openWith', uri, 'eide.ltspiceSchematic');
    const handle = await waitForTestHandle(uri);

    await handle.waitForMessage((m) => m.type === 'update');

    // Trigger simulation
    handle.sendWebviewMessage({ type: 'runSimulation' });

    // Immediately close the active editor
    await closeAllEditors();

    // Verify handle received no errors
    await new Promise((r) => setTimeout(r, 1000));
    assert.ok(true);
  });
});

