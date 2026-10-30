import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  decodeLog,
  findLtspice,
  parseLtspiceLog,
  prepareSimulationAsc,
  runLtspiceSimulation,
} from '../src/ltspice/ltspiceRunner';

const SAMPLES_DIR = path.join(__dirname, '..', '..', '..', 'samples');

test('findLtspice discovers installed executable or accepts custom path', () => {
  const found = findLtspice();
  // On this system, LTspice is installed
  if (process.platform === 'win32') {
    assert.ok(found, 'Should find LTspice executable on Windows machine');
    assert.ok(found.toLowerCase().endsWith('.exe'));
  }

  // Non-existent custom path should fall back to candidates
  const fallback = findLtspice('C:\\FakeNonExistentPath\\LTspice.exe');
  if (found) {
    assert.equal(fallback, found);
  }
});

test('parseLtspiceLog extracts measurements, errors, warnings, and elapsed time', () => {
  const logSample = `
LTspice 26.0.2 for Windows
Circuit: C:\\Temp\\test.net
Start Time: Fri Oct 30 14:09:10 2026
solver = Normal
Maximum thread count: 16
tnom = 27
temp = 27
method = trap
.OP point found by inspection.
Total elapsed time: 0.042 seconds.

Files loaded:
C:\\Temp\\test.net

v_max: MAX(V(out))=0.862189471722 FROM 0 TO 0.005
v_rms: RMS(V(out) )=0.598670412956 FROM 0.001 TO 0.005
v_p2p: PP(V(out))=1.70890343189 FROM 0 TO 0.005
Warning: Node N002 is floating.
Error: Singular matrix: check nodes N001 and N003
`;

  const parsed = parseLtspiceLog(logSample);
  assert.equal(parsed.elapsedSeconds, 0.042);
  assert.ok(Math.abs(parsed.measurements.v_max - 0.862189) < 1e-4);
  assert.ok(Math.abs(parsed.measurements.v_rms - 0.598670) < 1e-4);
  assert.ok(Math.abs(parsed.measurements.v_p2p - 1.708903) < 1e-4);
  assert.equal(parsed.warnings.length, 1);
  assert.ok(parsed.warnings[0].includes('floating'));
  assert.equal(parsed.errors.length, 1);
  assert.ok(parsed.errors[0].includes('Singular matrix'));
});

test('prepareSimulationAsc de-duplicates active simulation directives', () => {
  const multiDirectiveAsc = [
    'Version 4',
    'SHEET 1 880 680',
    'TEXT 32 296 Left 2 !.tran 5m',
    'TEXT 32 320 Left 2 !.ac dec 50 10 1meg',
    'TEXT 32 340 Left 2 !.op',
  ].join('\n');

  const { content, activeDirective } = prepareSimulationAsc(multiDirectiveAsc);
  assert.equal(activeDirective, '.tran');
  assert.ok(content.includes('!.tran 5m'));
  assert.ok(content.includes(';.ac dec 50 10 1meg'));
  assert.ok(content.includes(';.op'));
});

test('runLtspiceSimulation executes batch mode on sample circuit', async () => {
  const exe = findLtspice();
  if (!exe) {
    // If not installed on a CI machine, skip live execution
    return;
  }

  const sampleAsc = path.join(SAMPLES_DIR, 'rc_lowpass.asc');
  const result = await runLtspiceSimulation({
    executablePath: exe,
    ascPath: sampleAsc,
    timeoutMs: 30000,
  });

  assert.ok(result.success, `Simulation failed: ${result.error}`);
  assert.equal(result.exitCode, 0);
  assert.ok(result.raw !== undefined, 'Should have raw plot');
  assert.equal(result.raw?.plotName, 'Transient Analysis');
  assert.ok(result.raw!.x.length > 10, 'Should have time points');
  assert.ok(result.raw!.series['V(out)'] !== undefined, 'Should have V(out) series');
});

test('runLtspiceSimulation executes SPICE netlist (.cir) input mode', async () => {
  const exe = findLtspice();
  if (!exe) return;

  const cirContent = [
    '* Simple RC circuit',
    '.tran 1u 2m',
    'V1 in 0 SINE(0 1 1k)',
    'R1 in out 1k',
    'C1 out 0 100n',
    '.end',
  ].join('\n');

  const result = await runLtspiceSimulation({
    executablePath: exe,
    cirContent,
    timeoutMs: 30000,
  });

  assert.ok(result.success, `Netlist simulation failed: ${result.error}`);
  assert.equal(result.exitCode, 0);
  assert.ok(result.raw !== undefined);
  assert.ok(result.raw!.series['V(out)'] !== undefined);
});

test('runLtspiceSimulation handles cancellation', async () => {
  const exe = findLtspice();
  if (!exe) return;

  const sampleAsc = path.join(SAMPLES_DIR, 'rc_lowpass.asc');
  const controller = new AbortController();

  // Abort immediately
  controller.abort();

  const result = await runLtspiceSimulation({
    executablePath: exe,
    ascPath: sampleAsc,
    signal: controller.signal,
    timeoutMs: 30000,
  });

  assert.equal(result.success, false);
  assert.equal(result.error, 'Simulation cancelled');
});

test('decodeLog reads UTF-8 and UTF-16LE logs', () => {
  const text = 'vmax: MAX(V(out))=0.86 FROM 0 TO 0.005';
  assert.equal(decodeLog(Buffer.from(text, 'utf8')), text);
  assert.equal(decodeLog(Buffer.from(text, 'utf16le')), text);
  assert.equal(decodeLog(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])), text);
});

