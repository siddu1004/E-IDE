// Unit tests for pure Arduino modules (finder, diagnostics parser, serial parser, coordinator).
// Pure node --test runner with zero vscode dependencies.

import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, describe } from 'node:test';

import { findArduinoCli } from '../src/arduino/arduinoFinder';
import { parseArduinoDiagnostics } from '../src/arduino/arduinoDiagnostics';
import {
  parseSerialDataLine,
  SerialMonitorSession,
  SerialPortCoordinator,
} from '../src/arduino/serialMonitor';
import { compileSketch, listBoards } from '../src/arduino/arduinoRunner';

describe('Arduino Finder', () => {
  test('honors valid custom path', () => {
    const tmpExe = path.join(os.tmpdir(), `fake-arduino-cli-${Date.now()}.exe`);
    fs.writeFileSync(tmpExe, 'fake');
    try {
      const found = findArduinoCli(tmpExe);
      assert.equal(found, tmpExe);
    } finally {
      try { fs.unlinkSync(tmpExe); } catch {}
    }
  });

  test('ignores non-existent custom path and falls back', () => {
    const bogus = 'C:\\does_not_exist_xyz_123\\arduino-cli.exe';
    const found = findArduinoCli(bogus);
    // Either finds system installation or returns undefined, but NOT the bogus path
    assert.notEqual(found, bogus);
  });

  test('locates system or Arduino IDE bundled arduino-cli if installed', () => {
    const found = findArduinoCli();
    if (found) {
      assert.ok(fs.existsSync(found));
      assert.ok(found.toLowerCase().includes('arduino-cli'));
    }
  });
});

describe('Arduino Diagnostics Parser', () => {
  test('parses standard GCC compiler error lines', () => {
    const output = `
C:\\Users\\test\\sketch.ino:14:5: error: 'sensorValue' was not declared in this scope
   14 |     sensorValue = analogRead(A0);
      |     ^~~~~~~~~~~
C:\\Users\\test\\sketch.ino:22:11: warning: unused variable 'temp' [-Wunused-variable]
   22 |   float temp = 25.0;
      |         ^~~~
`;
    const diags = parseArduinoDiagnostics(output);
    assert.equal(diags.length, 2);

    assert.equal(diags[0].line, 14);
    assert.equal(diags[0].column, 5);
    assert.equal(diags[0].severity, 'error');
    assert.ok(diags[0].message.includes('sensorValue'));

    assert.equal(diags[1].line, 22);
    assert.equal(diags[1].column, 11);
    assert.equal(diags[1].severity, 'warning');
    assert.ok(diags[1].message.includes('unused variable'));
  });

  test('parses structured JSON diagnostics from builder_result', () => {
    const jsonOutput = JSON.stringify({
      builder_result: {
        diagnostics: [
          {
            file: 'blink.ino',
            line: 42,
            column: 1,
            msg: 'expected primary-expression before token',
            severity: 'ERROR',
          },
        ],
      },
    });

    const diags = parseArduinoDiagnostics(jsonOutput);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].line, 42);
    assert.equal(diags[0].severity, 'error');
    assert.ok(diags[0].message.includes('expected primary-expression'));
  });

  test('returns empty array when output contains no compiler errors', () => {
    const cleanOutput = 'Sketch uses 4406 bytes (13%) of program storage space. Maximum is 32256 bytes.';
    const diags = parseArduinoDiagnostics(cleanOutput);
    assert.equal(diags.length, 0);
  });
});

describe('Serial Monitor Data Parsing', () => {
  test('parses comma-separated numeric series', () => {
    const res = parseSerialDataLine('1.23, 4.56, -7.89');
    assert.deepEqual(res, [1.23, 4.56, -7.89]);
  });

  test('parses space/tab-separated numbers', () => {
    const res = parseSerialDataLine('100\t200   300.5');
    assert.deepEqual(res, [100, 200, 300.5]);
  });

  test('returns null for non-numeric lines and telemetry messages', () => {
    assert.equal(parseSerialDataLine(''), null);
    assert.equal(parseSerialDataLine('System initialized @ 115200 baud'), null);
    assert.equal(parseSerialDataLine('Vout=4.95V, Error=0.01'), null);
  });
});

describe('Serial Port Coordinator', () => {
  test('pauses active session, performs exclusive task, and resumes automatically', async () => {
    const coordinator = SerialPortCoordinator.getInstance();
    const testPort = 'COM99';

    let started = false;
    let stopped = false;

    // Fake session
    const fakeSession = {
      getPort: () => testPort,
      getBaud: () => 115200,
      isRunning: () => started && !stopped,
      start: async () => {
        started = true;
        stopped = false;
      },
      stop: async () => {
        stopped = true;
      },
    } as any;

    coordinator.register(fakeSession);
    await fakeSession.start();
    assert.equal(fakeSession.isRunning(), true);

    let executedTask = false;
    const result = await coordinator.withPortReleased(testPort, async () => {
      // During execution, session should have been stopped
      assert.equal(stopped, true);
      executedTask = true;
      return 'task_completed';
    });

    assert.equal(result, 'task_completed');
    assert.equal(executedTask, true);
    // After execution, session should be restarted
    assert.equal(fakeSession.isRunning(), true);

    coordinator.unregister(testPort);
  });
});

describe('Live arduino-cli compilation (if tool installed)', () => {
  test('compiles samples/blink_pwm/blink_pwm.ino for Uno', async () => {
    const cliPath = findArduinoCli();
    if (!cliPath) {
      console.log('Skipping live compile test: arduino-cli not found.');
      return;
    }

    const sketchPath = path.resolve(__dirname, '../../../samples/blink_pwm/blink_pwm.ino');
    assert.ok(fs.existsSync(sketchPath), `Sketch file must exist: ${sketchPath}`);

    const res = await compileSketch(cliPath, sketchPath, 'arduino:avr:uno');
    assert.equal(res.success, true, `Compile failed: ${res.error || res.rawOutput}`);
    assert.ok(res.binarySize && res.binarySize > 0, 'Binary size should be positive');
  });

  test('lists boards via arduino-cli', async () => {
    const cliPath = findArduinoCli();
    if (!cliPath) {
      console.log('Skipping live listBoards test: arduino-cli not found.');
      return;
    }

    const { detected, allBoards } = await listBoards(cliPath);
    assert.ok(Array.isArray(detected));
    assert.ok(Array.isArray(allBoards));
    // Check known boards installed
    const hasUno = allBoards.some((b) => b.fqbn.toLowerCase().includes('uno'));
    assert.ok(hasUno, 'Expected Arduino Uno in installed boards catalog');
  });
});
