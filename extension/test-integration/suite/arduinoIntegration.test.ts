// Integration tests for Milestone 7 Arduino support in E-IDE.
// Executes in real VS Code host.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findArduinoCli } from '../../src/arduino/arduinoFinder';
import { listBoards, compileSketch, readSerial } from '../../src/agent/tools';
import { ArduinoController } from '../../src/arduino/arduinoController';
import { TestHook } from '../../src/testHook';
import {
  closeAllEditors,
  setupTestWorkspace,
  cleanupTestWorkspace,
  waitForTestHandle,
} from './testHelpers';

describe('Milestone 7: Arduino Support Integration Tests', function () {
  this.timeout(120000);

  let tempDir: string;
  let samplesDir: string;
  let testSketchPath: string;

  before(async () => {
    const ws = await setupTestWorkspace();
    tempDir = ws.tempDir;
    samplesDir = ws.samplesDir;

    // Create temporary copy of blink_pwm sketch in workspace so no tests modify samples/
    const sketchDir = path.join(tempDir, 'blink_pwm');
    if (!fs.existsSync(sketchDir)) {
      fs.mkdirSync(sketchDir, { recursive: true });
    }
    const sampleSrc = path.resolve(__dirname, '../../../../samples/blink_pwm/blink_pwm.ino');
    testSketchPath = path.join(sketchDir, 'blink_pwm.ino');
    fs.copyFileSync(sampleSrc, testSketchPath);
  });

  after(async () => {
    await closeAllEditors();
    await cleanupTestWorkspace(tempDir);
  });

  it('registers Arduino commands in VS Code', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    assert.ok(allCommands.includes('eide.arduino.verify'), 'eide.arduino.verify must be registered');
    assert.ok(allCommands.includes('eide.arduino.upload'), 'eide.arduino.upload must be registered');
    assert.ok(allCommands.includes('eide.arduino.selectBoard'), 'eide.arduino.selectBoard must be registered');
    assert.ok(allCommands.includes('eide.arduino.selectPort'), 'eide.arduino.selectPort must be registered');
    assert.ok(allCommands.includes('eide.arduino.openSerial'), 'eide.arduino.openSerial must be registered');
  });

  it('locates installed arduino-cli', () => {
    const cliPath = findArduinoCli();
    assert.ok(cliPath, 'arduino-cli must be found on system or bundled');
    assert.ok(fs.existsSync(cliPath), `CLI path must exist on disk: ${cliPath}`);
  });

  it('listBoards returns connected and installed board catalogs', async () => {
    const cliPath = findArduinoCli();
    if (!cliPath) {
      console.log('Skipping listBoards test: arduino-cli missing');
      return;
    }

    const res = await listBoards();
    assert.ok(res, 'listBoards must return result object');
    assert.ok(Array.isArray(res.connectedPorts), 'connectedPorts must be an array');
    assert.ok(Array.isArray(res.installedBoards), 'installedBoards must be an array');
    assert.ok(res.installedBoards.length > 0, 'Must have at least one board installed');
    const hasUno = res.installedBoards.some((b) => b.fqbn.toLowerCase().includes('uno'));
    assert.ok(hasUno, 'Expected Arduino Uno in installed boards catalog');
  });

  it('compileSketch compiles sample sketch for arduino:avr:uno', async () => {
    const cliPath = findArduinoCli();
    if (!cliPath) {
      console.log('Skipping compileSketch test: arduino-cli missing');
      return;
    }

    const res = await compileSketch(testSketchPath, 'arduino:avr:uno');
    assert.ok(res.success, `Compile must succeed. Error: ${res.error || res.rawOutput}`);
    assert.ok(res.durationMs > 0, 'Compile duration must be recorded');
    assert.ok(res.binarySize && res.binarySize > 0, 'Program flash binary size must be reported');
    assert.ok(res.dataSize !== undefined, 'RAM data size should be reported');
  });

  it('openSerial opens Serial Monitor webview and responds to test hook messages', async () => {
    // Trigger command to open serial panel
    await vscode.commands.executeCommand('eide.arduino.openSerial');

    // Wait for test hook handle to become available
    const handle = await waitForTestHandle(vscode.Uri.file('eide-arduino-serial'), 10000);
    assert.ok(handle, 'Serial monitor webview test hook handle must exist');

    // Send ready message from webview simulation
    await handle.sendWebviewMessage({ type: 'ready' });

    // Expect status message from controller
    const statusMsg = await handle.waitForMessage((m) => m.type === 'status', 5000);
    assert.ok(statusMsg, 'Expected status message from serial controller');
    assert.equal(statusMsg.type, 'status');
  });
});
