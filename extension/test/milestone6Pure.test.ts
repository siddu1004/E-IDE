import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  COMPONENT_CATALOG,
  formatEngValue,
  normalizeComponentType,
  parseEngValue,
  snapToE24,
} from '../src/agent/catalog';
import {
  addComponentToAsc,
  connectPinsInAsc,
  createEmptySchematic,
  parseAscComponents,
  removeComponentFromAsc,
} from '../src/agent/schematicBuilder';
import { evaluateSpec, DesignSpec } from '../src/agent/specChecker';
import { runTuner } from '../src/agent/tuner';
import { CompactSimulationSummary } from '../src/agent/waveformSummary';

describe('Milestone 6: Component Catalog & Value Snapping', () => {
  it('snaps numbers to standard E24 series multipliers', () => {
    assert.equal(snapToE24(1050), 1000);
    assert.equal(snapToE24(4800), 4700);
    assert.equal(snapToE24(2150), 2200);
    assert.equal(snapToE24(7.95e-8), 8.2e-8);
  });

  it('formats values into standard engineering units', () => {
    assert.equal(formatEngValue(1000), '1k');
    assert.equal(formatEngValue(4700), '4.7k');
    assert.equal(formatEngValue(100e-9), '100n');
    assert.equal(formatEngValue(10e-6), '10u');
    assert.equal(formatEngValue(1e6), '1meg');
    assert.equal(formatEngValue(12), '12');
  });

  it('parses engineering string values accurately', () => {
    assert.equal(parseEngValue('1k'), 1000);
    assert.equal(parseEngValue('4.7k'), 4700);
    assert.equal(parseEngValue('100n'), 1e-7);
    assert.equal(parseEngValue('10uF'), 1e-5);
    assert.equal(parseEngValue('2kHz'), 2000);
    assert.equal(parseEngValue('12V'), 12);
  });

  it('normalizes common component names to catalog entries', () => {
    const r = normalizeComponentType('resistor');
    assert.equal(r.refPrefix, 'R');
    const c = normalizeComponentType('cap');
    assert.equal(c.refPrefix, 'C');
    const op = normalizeComponentType('opamp');
    assert.equal(op.refPrefix, 'U');
  });
});

describe('Milestone 6: Schematic Synthesis & Orthogonal Wiring', () => {
  it('creates empty schematic for LTspice', () => {
    const asc = createEmptySchematic('.asc');
    assert.match(asc, /^Version 4\nSHEET 1/);
  });

  it('adds components and automatically addresses pin coordinates', () => {
    let asc = createEmptySchematic('.asc');
    const resR1 = addComponentToAsc(asc, 'R', '10k');
    asc = resR1.newContent;
    assert.equal(resR1.ref, 'R1');
    assert.match(asc, /SYMBOL res \d+ \d+ R0/);
    assert.match(asc, /SYMATTR InstName R1/);

    const resC1 = addComponentToAsc(asc, 'C', '100n', 'R1');
    asc = resC1.newContent;
    assert.equal(resC1.ref, 'C1');

    const comps = parseAscComponents(asc);
    assert.equal(comps.length, 2);
    assert.equal(comps[0].ref, 'R1');
    assert.equal(comps[1].ref, 'C1');
    assert.equal(comps[0].pins.length, 2);
  });

  it('connects pins using orthogonal routing', () => {
    let asc = createEmptySchematic('.asc');
    asc = addComponentToAsc(asc, 'V', '12').newContent;
    asc = addComponentToAsc(asc, 'R', '1k').newContent;

    asc = connectPinsInAsc(asc, 'V1.1', 'R1.1');
    assert.match(asc, /WIRE \d+ \d+ \d+ \d+/);
  });

  it('removes components cleanly from schematic', () => {
    let asc = createEmptySchematic('.asc');
    asc = addComponentToAsc(asc, 'R', '1k').newContent;
    assert.match(asc, /SYMATTR InstName R1/);

    asc = removeComponentFromAsc(asc, 'R1');
    assert.doesNotMatch(asc, /SYMATTR InstName R1/);
  });
});

describe('Milestone 6: Spec Checker', () => {
  it('evaluates AC cutoff frequency against spec', () => {
    const summary: CompactSimulationSummary = {
      plotName: 'AC Analysis',
      signals: [{ name: 'V(out)', min: -10, max: 0, finalValue: 0 }],
      ac: { primarySignal: 'V(out)', cutoffFrequency3dB: 2010, phaseAt3dB: -45 },
    };

    const spec: DesignSpec = {
      signal: 'V(out)',
      cutoff_hz: { target: 2000, tol_pct: 5 },
    };

    const res = evaluateSpec(summary, spec);
    assert.equal(res.pass, true);
    assert.ok(res.evaluations['cutoff_hz'].pass);
    assert.ok(res.errorScore < 2.0);
  });

  it('flags violations when measured values exceed tolerances', () => {
    const summary: CompactSimulationSummary = {
      plotName: 'Transient Analysis',
      signals: [{ name: 'V(out)', min: 0, max: 1.3, finalValue: 1.0 }],
      transient: { primarySignal: 'V(out)', overshootPercent: 30, riseTime: 0.002 },
    };

    const spec: DesignSpec = {
      overshoot_pct: { max: 10 },
      rise_time_s: { max: 0.001 },
    };

    const res = evaluateSpec(summary, spec);
    assert.equal(res.pass, false);
    assert.equal(res.evaluations['overshoot_pct'].pass, false);
    assert.equal(res.evaluations['rise_time_s'].pass, false);
  });
});

describe('Milestone 6: Bounded Tuner Search', () => {
  it('tunes parameters to satisfy objective within max iterations', async () => {
    // Model: Cutoff fc = 1 / (2 * pi * R * C). Target = 2000 Hz.
    // C is fixed at 100nF, tuning R.
    const C = 100e-9;
    const targetFc = 2000;

    const params = [
      { name: 'R1', min: 100, max: 10000, initial: 1000, snapE24: true },
    ];

    const res = await runTuner(
      params,
      async (values) => {
        const rVal = parseEngValue(String(values['R1']));
        const measuredFc = 1 / (2 * Math.PI * rVal * C);
        const err = Math.abs((measuredFc - targetFc) / targetFc) * 100;
        const pass = err <= 5.0; // Within 5%
        return { pass, errorScore: err };
      },
      15
    );

    assert.equal(res.success, true);
    assert.ok(res.iterations <= 15);
    const tunedR = parseEngValue(String(res.bestParams['R1']));
    const tunedFc = 1 / (2 * Math.PI * tunedR * C);
    assert.ok(Math.abs(tunedFc - 2000) / 2000 <= 0.05, `Tuned Fc ${tunedFc} should be within 5% of 2000`);
  });
});
