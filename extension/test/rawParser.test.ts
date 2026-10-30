import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { ComplexSeries, parseRaw } from '../src/ltspice/rawParser';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

test('parses binary transient raw file with UTF-16LE header', () => {
  const buf = fs.readFileSync(path.join(FIXTURES, 'tran_simple.raw'));
  const parsed = parseRaw(buf);

  assert.equal(parsed.plotName, 'Transient Analysis');
  assert.ok(parsed.flags.includes('real'));
  assert.equal(parsed.variables.length, 3);
  assert.equal(parsed.variables[0].name, 'time');
  assert.equal(parsed.variables[1].name, 'V(out)');
  assert.equal(parsed.variables[2].name, 'I(R1)');

  assert.equal(parsed.x.length, 4);
  assert.ok(Math.abs(parsed.x[0] - 0.0) < 1e-9);
  assert.ok(Math.abs(parsed.x[1] - 0.001) < 1e-9);
  assert.ok(Math.abs(parsed.x[2] - 0.002) < 1e-9);
  assert.ok(Math.abs(parsed.x[3] - 0.003) < 1e-9);

  const vout = parsed.series['V(out)'] as Float64Array;
  assert.ok(vout instanceof Float64Array);
  assert.equal(vout.length, 4);
  assert.ok(Math.abs(vout[0] - 0.0) < 1e-6);
  assert.ok(Math.abs(vout[1] - 1.5) < 1e-4);
  assert.ok(Math.abs(vout[2] - 3.0) < 1e-4);
  assert.ok(Math.abs(vout[3] - 2.5) < 1e-4);

  const ir1 = parsed.series['I(R1)'] as Float64Array;
  assert.ok(Math.abs(ir1[1] - 0.015) < 1e-4);
});

test('parses binary AC raw file with complex values', () => {
  const buf = fs.readFileSync(path.join(FIXTURES, 'ac_simple.raw'));
  const parsed = parseRaw(buf);

  assert.equal(parsed.plotName, 'AC Analysis');
  assert.ok(parsed.flags.includes('complex'));
  assert.equal(parsed.variables.length, 2);
  assert.equal(parsed.variables[0].name, 'frequency');
  assert.equal(parsed.variables[1].name, 'V(out)');

  assert.equal(parsed.x.length, 3);
  assert.equal(parsed.x[0], 100);
  assert.equal(parsed.x[1], 1000);
  assert.equal(parsed.x[2], 10000);

  const vout = parsed.series['V(out)'] as ComplexSeries;
  assert.ok(vout.re && vout.im);
  assert.equal(vout.re.length, 3);
  assert.ok(Math.abs(vout.re[0] - 1.0) < 1e-6);
  assert.ok(Math.abs(vout.im[0] - 0.0) < 1e-6);
  assert.ok(Math.abs(vout.re[1] - 0.707) < 1e-3);
  assert.ok(Math.abs(vout.im[1] - (-0.707)) < 1e-3);
});

test('parses ASCII transient raw file', () => {
  const buf = fs.readFileSync(path.join(FIXTURES, 'ascii_tran.raw'));
  const parsed = parseRaw(buf);

  assert.equal(parsed.plotName, 'Transient Analysis');
  assert.equal(parsed.variables.length, 2);
  assert.equal(parsed.x.length, 3);
  assert.ok(Math.abs(parsed.x[1] - 0.001) < 1e-6);

  const vout = parsed.series['V(out)'] as Float64Array;
  assert.equal(vout.length, 3);
  assert.ok(Math.abs(vout[1] - 2.5) < 1e-6);
  assert.ok(Math.abs(vout[2] - 5.0) < 1e-6);
});

test('parses real LTspice 26 transient raw file', () => {
  const buf = fs.readFileSync(path.join(FIXTURES, 'real_tran.raw'));
  const parsed = parseRaw(buf);

  assert.equal(parsed.plotName, 'Transient Analysis');
  assert.equal(parsed.variables.length, 6);
  assert.equal(parsed.x.length, 1042);
  assert.equal(parsed.x[0], 0);
  assert.ok(parsed.x[1041] > 0.0049); // simulated up to 5ms

  const vout = parsed.series['V(out)'] as Float64Array;
  assert.equal(vout.length, 1042);
  const ir1 = parsed.series['I(R1)'] as Float64Array;
  assert.equal(ir1.length, 1042);
});

test('parses real LTspice 26 AC raw file', () => {
  const buf = fs.readFileSync(path.join(FIXTURES, 'real_ac.raw'));
  const parsed = parseRaw(buf);

  assert.equal(parsed.plotName, 'AC Analysis');
  assert.equal(parsed.variables.length, 6);
  assert.equal(parsed.x.length, 251);
  assert.equal(parsed.x[0], 10); // started at 10 Hz
  assert.ok(parsed.x[250] >= 1e6); // up to 1 MHz

  const vout = parsed.series['V(out)'] as ComplexSeries;
  assert.equal(vout.re.length, 251);
  assert.equal(vout.im.length, 251);
});

