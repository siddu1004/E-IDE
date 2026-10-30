import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeAc,
  analyzeTransient,
  downsampleSeries,
  summarizeSimulationData,
} from '../src/agent/waveformSummary';

describe('waveformSummary', () => {
  describe('downsampleSeries', () => {
    it('returns empty array if input is empty', () => {
      const res = downsampleSeries([], []);
      assert.deepEqual(res, { x: [], y: [] });
    });

    it('returns original points if length <= maxPoints', () => {
      const x = [0, 1, 2];
      const y = [10, 20, 30];
      const res = downsampleSeries(x, y, 200);
      assert.deepEqual(res, { x: [0, 1, 2], y: [10, 20, 30] });
    });

    it('downsamples large arrays to exactly maxPoints preserving boundaries', () => {
      const n = 1000;
      const x = Array.from({ length: n }, (_, i) => i * 0.001);
      const y = x.map((v) => Math.sin(2 * Math.PI * 10 * v));
      const res = downsampleSeries(x, y, 200);

      assert.equal(res.x.length, 200);
      assert.equal(res.y.length, 200);
      assert.equal(res.x[0], x[0]);
      assert.equal(res.x[199], x[n - 1]);
      assert.equal(res.y[0], y[0]);
      assert.equal(res.y[199], y[n - 1]);
    });
  });

  describe('analyzeTransient', () => {
    it('calculates 10-90% rise time for a first-order step response', () => {
      // Step response: y(t) = 1 - exp(-t / tau), tau = 1 ms
      const tau = 0.001;
      const tMax = 0.01;
      const points = 1000;
      const x = Array.from({ length: points }, (_, i) => (i * tMax) / (points - 1));
      const y = x.map((t) => 1.0 - Math.exp(-t / tau));

      const analysis = analyzeTransient(x, y, 'V(out)');
      assert.ok(analysis !== undefined);
      if (!analysis) return;
      assert.equal(analysis.primarySignal, 'V(out)');
      // Theoretical rise time for 1st order RC is ln(9) * tau ~= 2.197 * 0.001 = 0.002197 s
      assert.ok(analysis.riseTime !== undefined);
      assert.ok(Math.abs((analysis.riseTime ?? 0) - 0.0022) < 0.0001);
      assert.equal(analysis.overshootPercent, 0);
    });

    it('calculates overshoot for an underdamped response', () => {
      // Underdamped step with 20% overshoot
      const x = [0, 1, 2, 3, 4, 5];
      const y = [0, 0.5, 1.2, 1.05, 0.98, 1.0];

      const analysis = analyzeTransient(x, y, 'V(out)');
      assert.ok(analysis !== undefined);
      if (!analysis) return;
      assert.equal(analysis.overshootPercent, 20);
      assert.ok((analysis.riseTime ?? 0) > 0);
    });
  });

  describe('analyzeAc', () => {
    it('calculates -3 dB cutoff frequency and phase for a lowpass filter', () => {
      // 1st order lowpass with fc = 1000 Hz
      const fc = 1000;
      const freqs = [100, 500, 1000, 2000, 10000];
      const magDb = freqs.map((f) => -10 * Math.log10(1 + Math.pow(f / fc, 2)));
      const phaseDeg = freqs.map((f) => (-Math.atan(f / fc) * 180) / Math.PI);

      const analysis = analyzeAc(freqs, magDb, phaseDeg, 'V(out)');
      assert.ok(analysis !== undefined);
      if (!analysis) return;
      assert.equal(analysis.primarySignal, 'V(out)');
      assert.ok(analysis.cutoffFrequency3dB !== undefined);
      assert.ok(
        Math.abs((analysis.cutoffFrequency3dB ?? 0) - 1000) < 50,
        `Expected ~1000 Hz, got ${analysis.cutoffFrequency3dB}`
      );
      assert.ok(analysis.phaseAt3dB !== undefined);
      assert.ok(
        Math.abs((analysis.phaseAt3dB ?? 0) - -45) < 3,
        `Expected ~ -45 deg, got ${analysis.phaseAt3dB}`
      );
    });
  });

  describe('summarizeSimulationData', () => {
    it('summarizes transient simulation with min, max, final, rise time', () => {
      const summary = summarizeSimulationData({
        plotName: 'Transient Analysis',
        x: [0, 0.001, 0.002, 0.003],
        series: {
          'V(in)': [1, 1, 1, 1],
          'V(out)': [0, 0.5, 0.8, 1.0],
        },
        measurements: {
          t_rise: 0.0015,
        },
      });

      assert.equal(summary.plotName, 'Transient Analysis');
      assert.equal(summary.signals.length, 2);
      assert.equal(summary.signals[1].name, 'V(out)');
      assert.equal(summary.signals[1].min, 0);
      assert.equal(summary.signals[1].max, 1.0);
      assert.equal(summary.signals[1].finalValue, 1.0);
      assert.equal(summary.measurements?.t_rise, 0.0015);
      assert.ok(summary.transient !== undefined);
      assert.equal(summary.transient?.primarySignal, 'V(out)');
    });

    it('summarizes AC simulation with complex series', () => {
      const summary = summarizeSimulationData({
        plotName: 'AC Analysis',
        x: [100, 1000, 10000],
        series: {
          'V(out)': {
            re: [1.0, 0.5, 0.05],
            im: [0.0, -0.5, -0.05],
          },
        },
      });

      assert.equal(summary.plotName, 'AC Analysis');
      assert.equal(summary.signals.length, 1);
      assert.ok(summary.ac !== undefined);
      assert.equal(summary.ac?.primarySignal, 'V(out)');
      assert.ok(summary.ac?.cutoffFrequency3dB !== undefined);
    });
  });
});
