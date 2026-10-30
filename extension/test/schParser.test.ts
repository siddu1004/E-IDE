import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { diffSchematics, parseKicadSch, propertyEdit } from '../src/kicad/schParser';

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'test', 'fixtures', 'kicad');

test('parses rc_filter.kicad_sch and extracts symbols, wires, labels, directives', () => {
  const source = fs.readFileSync(path.join(FIXTURES_DIR, 'rc_filter.kicad_sch'), 'utf8');
  const sch = parseKicadSch(source);

  assert.equal(sch.generator, 'eeschema');
  assert.equal(sch.symbols.length, 4); // V1, R1, C1, #PWR1

  const r1 = sch.symbols.find((s) => s.ref === 'R1');
  assert.ok(r1, 'R1 should be present');
  assert.equal(r1.value, '1k');
  assert.equal(r1.footprint, 'Resistor_SMD:R_0805_2012Metric');

  const c1 = sch.symbols.find((s) => s.ref === 'C1');
  assert.ok(c1, 'C1 should be present');
  assert.equal(c1.value, '100n');

  assert.equal(sch.wires.length, 9);
  assert.equal(sch.junctions.length, 2);
  assert.equal(sch.labels.length, 2);
  assert.equal(sch.texts.length, 1);
  assert.equal(sch.texts[0].text, '.tran 1u 5m');
  assert.equal(sch.texts[0].directive, true);
});

test('builds accurate electrical nets connecting pins and labels', () => {
  const source = fs.readFileSync(path.join(FIXTURES_DIR, 'rc_filter.kicad_sch'), 'utf8');
  const sch = parseKicadSch(source);

  const netIn = sch.nets.find((n) => n.name === 'IN');
  assert.ok(netIn, 'Net IN should exist');
  assert.ok(netIn.pins.some((p) => p.ref === 'V1' && p.pin === '1'));
  assert.ok(netIn.pins.some((p) => p.ref === 'R1'));

  const netOut = sch.nets.find((n) => n.name === 'OUT');
  assert.ok(netOut, 'Net OUT should exist');
  assert.ok(netOut.pins.some((p) => p.ref === 'C1' && p.pin === '1'));
  assert.ok(netOut.pins.some((p) => p.ref === 'R1'));

  const netGnd = sch.nets.find((n) => n.name === 'GND');
  assert.ok(netGnd, 'Net GND should exist');
  assert.ok(netGnd.pins.some((p) => p.ref === 'C1' && p.pin === '2'));
  assert.ok(netGnd.pins.some((p) => p.ref === 'V1' && p.pin === '2'));
});

test('propertyEdit returns precise range edit and updates source cleanly', () => {
  const source = fs.readFileSync(path.join(FIXTURES_DIR, 'rc_filter.kicad_sch'), 'utf8');
  const sch = parseKicadSch(source);

  const edit = propertyEdit(sch, 'R1', 'Value', '2.2k', source);
  assert.ok(edit, 'Edit should be generated');
  assert.equal(edit.oldText, '"1k"');
  assert.equal(edit.text, '"2.2k"');

  const modified = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  const sch2 = parseKicadSch(modified);
  const r1After = sch2.symbols.find((s) => s.ref === 'R1');
  assert.equal(r1After?.value, '2.2k');

  // Verify diffSchematics detects R1 changed
  const changes = diffSchematics(sch, sch2);
  assert.deepEqual(changes.symbols, ['R1']);
});

test('parses ldo_3v3.kicad_sch with IC and multiple power nets', () => {
  const source = fs.readFileSync(path.join(FIXTURES_DIR, 'ldo_3v3.kicad_sch'), 'utf8');
  const sch = parseKicadSch(source);

  const u1 = sch.symbols.find((s) => s.ref === 'U1');
  assert.ok(u1, 'U1 should be present');
  assert.equal(u1.value, 'AP2112K-3.3');

  const pwr5v = sch.nets.find((n) => n.name === '+5V');
  assert.ok(pwr5v, '+5V net should exist');
  assert.ok(pwr5v.pins.some((p) => p.ref === 'C1' && p.pin === '1'));
  assert.ok(pwr5v.pins.some((p) => p.ref === 'U1' && p.pin === '1'));

  const pwr3v3 = sch.nets.find((n) => n.name === '+3V3');
  assert.ok(pwr3v3, '+3V3 net should exist');
  assert.ok(pwr3v3.pins.some((p) => p.ref === 'U1' && p.pin === '5'));
  assert.ok(pwr3v3.pins.some((p) => p.ref === 'C2' && p.pin === '1'));
});
