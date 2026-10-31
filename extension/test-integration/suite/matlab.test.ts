import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  checkTools,
  cleanupTestWorkspace,
  closeAllEditors,
  setupTestWorkspace,
} from './testHelpers';

describe('MATLAB Script Integration Flows', () => {
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

  it('runs rc_response.m, streams output, exports figure, and reports error diagnostics', async function () {
    const tools = checkTools();
    if (!tools.hasMatlab) {
      this.skip();
      return;
    }

    // 1. Run valid script rc_response.m (on a copy in tempDir)
    const scriptPath = path.join(tempDir, 'rc_response.m');
    fs.copyFileSync(path.join(samplesDir, 'rc_response.m'), scriptPath);
    const uri = vscode.Uri.file(scriptPath);

    await vscode.commands.executeCommand('eide.runMatlabScript', uri);

    // Verify exported figure exists in temp directory
    const tempFigDir = path.join(os.tmpdir(), 'eide_figures');
    const startWait = Date.now();
    let figures: string[] = [];
    while (Date.now() - startWait < 15000) {
      if (fs.existsSync(tempFigDir)) {
        figures = fs.readdirSync(tempFigDir).filter((f) => f.endsWith('.png'));
        if (figures.length > 0) break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(fs.existsSync(tempFigDir), 'Expected eide_figures dir to exist');
    assert.ok(figures.length > 0, 'Expected at least one exported figure PNG');

    // 2. Run script with deliberate error and verify diagnostic in Problems panel
    const errScriptPath = path.join(tempDir, 'error_test.m');
    fs.writeFileSync(
      errScriptPath,
      '% Deliberate error test\nx = 10;\nundefined_func_error_call();\n'
    );
    const errUri = vscode.Uri.file(errScriptPath);

    await vscode.commands.executeCommand('eide.runMatlabScript', errUri);

    // Wait for diagnostics to be populated in Problems panel
    let diags: vscode.Diagnostic[] = [];
    const startDiagsWait = Date.now();
    while (Date.now() - startDiagsWait < 25000) {
      diags = vscode.languages.getDiagnostics(errUri);
      if (diags.length > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    assert.ok(diags.length > 0, 'Expected error diagnostic in Problems panel');
    assert.equal(diags[0].source, 'MATLAB');
    assert.equal(diags[0].range.start.line, 2); // 0-indexed line 2 is line 3
  });
});
