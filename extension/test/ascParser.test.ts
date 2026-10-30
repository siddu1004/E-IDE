import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { applyLineEdit, diffSchematics, parseAsc, symbolAttrEdit } from '../src/ltspice/ascParser';

const samplePath = path.join(__dirname, '..', '..', '..', 'samples', 'rc_lowpass.asc');
const sample = readFileSync(samplePath, 'utf8');

test('parses wires, flags, symbols, and directives', () => {
  const s = parseAsc(sample);
  assert.equal(s.version, '4');
  assert.equal(s.wires.length, 7);
  assert.equal(s.flags.length, 3);
  assert.deepEqual(s.symbols.map((x) => x.id), ['V1', 'R1', 'C1']);
  assert.equal(s.symbols[0].attrs.Value.value, 'SINE(0 1 1k) AC 1');
  assert.equal(s.symbols[1].rotation, 'R90');
  assert.deepEqual(s.texts.filter((t) => t.directive).map((t) => t.text), ['.tran 5m', '.ac dec 50 10 1meg']);
});

test('replaces an existing attribute line', () => {
  const s = parseAsc(sample);
  const edit = symbolAttrEdit(s, 'R1', 'Value', '2.2k');
  assert.ok(edit && !edit.insert);
  const next = parseAsc(applyLineEdit(sample, edit));
  assert.equal(next.symbols.find((x) => x.id === 'R1')?.attrs.Value.value, '2.2k');
  assert.equal(next.symbols.length, 3);
});

test('inserts a missing attribute after the symbol block', () => {
  const s = parseAsc(sample);
  const edit = symbolAttrEdit(s, 'C1', 'SpiceLine', 'V=16');
  assert.ok(edit?.insert);
  const next = parseAsc(applyLineEdit(sample, edit));
  assert.equal(next.symbols.find((x) => x.id === 'C1')?.attrs.SpiceLine.value, 'V=16');
});

test('rejects unknown symbols and unsafe keys', () => {
  const s = parseAsc(sample);
  assert.equal(symbolAttrEdit(s, 'R99', 'Value', '1k'), undefined);
  assert.equal(symbolAttrEdit(s, 'R1', 'Value\nWIRE', '1k'), undefined);
});

test('diff flags changed symbols, new wires, and new directives', () => {
  const before = parseAsc(sample);
  const edited = applyLineEdit(sample, symbolAttrEdit(before, 'C1', 'Value', '220n')!)
    .concat('\nWIRE 304 96 400 96\nTEXT 32 344 Left 2 !.op');
  const changes = diffSchematics(before, parseAsc(edited));
  assert.deepEqual(changes.symbols, ['C1']);
  assert.deepEqual(changes.removedSymbols, []);
  assert.equal(changes.wires.length, 1);
  assert.equal(changes.texts.length, 1);
  assert.deepEqual(diffSchematics(undefined, before).symbols, []);
});
