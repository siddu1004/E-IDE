import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  exportSpiceNetlist,
  findKicadCli,
  parseErcReport,
  runErc,
} from '../src/kicad/kicadCli';

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'test', 'fixtures', 'kicad');

test('findKicadCli discovers installed CLI or honors custom path', () => {
  const found = findKicadCli();
  if (process.platform === 'win32') {
    // If installed on test runner machine
    if (found) {
      assert.ok(found.toLowerCase().includes('kicad-cli'));
      assert.ok(fs.existsSync(found));
    }
  }

  // Fake environment test
  const fakeEnv = {
    ProgramFiles: 'C:\\FakeKiCadRoot',
    PATH: '',
  };
  const fakeRes = findKicadCli(undefined, fakeEnv);
  assert.equal(fakeRes, undefined);
});

test('parseErcReport parses KiCad ERC JSON format', () => {
  const ercJson = fs.readFileSync(path.join(FIXTURES_DIR, 'rc_filter_erc.json'), 'utf8');
  const report = parseErcReport(ercJson);

  assert.ok(report.violations.length > 0, 'Report should contain violations');
  assert.ok(report.errorCount >= 1, 'Should have at least one error');
  assert.ok(report.warningCount >= 1, 'Should have warnings');

  const powerErr = report.violations.find((v) => v.type === 'power_pin_not_driven');
  assert.ok(powerErr, 'Should detect power_pin_not_driven error');
  assert.equal(powerErr.severity, 'error');
  assert.ok(powerErr.items.length > 0);
  assert.ok(powerErr.items[0].pos !== undefined);
});

test('live kicad-cli exports SPICE netlist and runs ERC if available', async () => {
  const cli = findKicadCli();
  if (!cli) return;

  const schPath = path.join(FIXTURES_DIR, 'rc_filter.kicad_sch');

  // Test netlist export
  const netResult = await exportSpiceNetlist({
    cliPath: cli,
    schPath,
  });
  assert.ok(netResult.success, `Netlist export failed: ${netResult.error}`);
  assert.ok(netResult.netlist?.includes('.tran'), 'Netlist should contain .tran directive');
  assert.ok(netResult.netlist?.includes('R1'), 'Netlist should contain R1');

  // Test ERC run
  const ercResult = await runErc({
    cliPath: cli,
    schPath,
  });
  assert.ok(ercResult.success, `ERC run failed: ${ercResult.error}`);
  assert.ok(ercResult.report.violations.length > 0);
});
