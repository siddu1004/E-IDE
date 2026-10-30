import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { findLtspice } from '../src/ltspice/ltspiceRunner';
import { findKicadCli } from '../src/kicad/kicadCli';
import {
  checkMissingSpiceModels,
  simulateKicadSchematic,
} from '../src/kicad/kicadSimulation';
import { parseKicadSch } from '../src/kicad/schParser';

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'test', 'fixtures', 'kicad');

test('checkMissingSpiceModels identifies components without SPICE models', () => {
  const ldoSch = parseKicadSch(fs.readFileSync(path.join(FIXTURES_DIR, 'ldo_3v3.kicad_sch'), 'utf8'));
  const missing = checkMissingSpiceModels(ldoSch.symbols);

  assert.ok(missing.length >= 1, 'Should find components missing SPICE models');
  assert.ok(missing.some((m) => m.includes('U1')), 'U1 should be flagged as missing model');

  const rcSch = parseKicadSch(fs.readFileSync(path.join(FIXTURES_DIR, 'rc_filter.kicad_sch'), 'utf8'));
  const rcMissing = checkMissingSpiceModels(rcSch.symbols);
  assert.equal(rcMissing.length, 0, 'rc_filter has all standard SPICE primitives');
});

test('simulateKicadSchematic exports netlist and runs in LTspice', async () => {
  const cli = findKicadCli();
  const ltspice = findLtspice();
  if (!cli || !ltspice) return;

  const schPath = path.join(FIXTURES_DIR, 'rc_filter.kicad_sch');
  const result = await simulateKicadSchematic({
    kicadCliPath: cli,
    ltspicePath: ltspice,
    schPath,
  });

  assert.ok(result.success, `Simulation failed: ${result.error}`);
  assert.equal(result.missingModels.length, 0);
  assert.ok(result.runResult !== undefined);
  assert.ok(result.runResult?.raw !== undefined);
  assert.ok(result.runResult?.raw?.x.length! > 10);
  assert.ok(result.runResult?.raw?.series['V(/out)'] !== undefined || result.runResult?.raw?.series['V(out)'] !== undefined);
});
