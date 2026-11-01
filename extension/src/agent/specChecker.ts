// Design specification validation and scoring engine.
// Pure Node module, zero vscode imports.

import { CompactSimulationSummary } from './waveformSummary';

export interface SpecMetricTarget {
  target?: number;
  tol_pct?: number; // percentage tolerance around target e.g. 5 for +/- 5%
  min?: number;
  max?: number;
}

export interface DesignSpec {
  signal?: string;
  cutoff_hz?: SpecMetricTarget;
  overshoot_pct?: SpecMetricTarget;
  rise_time_s?: SpecMetricTarget;
  settling_time_s?: SpecMetricTarget;
  ripple_v?: SpecMetricTarget;
  ripple_mv?: SpecMetricTarget;
  mean_v?: SpecMetricTarget;
  final_value?: SpecMetricTarget;
}

export interface MetricEvaluation {
  metric: string;
  pass: boolean;
  measured: number | null;
  target?: number;
  minAllowed?: number;
  maxAllowed?: number;
  error_pct?: number;
  message?: string;
}

export interface SpecCheckResult {
  pass: boolean;
  errorScore: number; // 0 = exact match, positive = normalized error metric for tuning
  evaluations: Record<string, MetricEvaluation>;
}

/**
 * Checks a simulation summary against a design specification.
 */
export function evaluateSpec(
  summary: CompactSimulationSummary,
  spec: DesignSpec,
  rawWaveform?: { x: number[]; y: number[] }
): SpecCheckResult {
  const evaluations: Record<string, MetricEvaluation> = {};
  let allPass = true;
  let totalErrorScore = 0;

  // 1. Cutoff frequency (AC analysis)
  if (spec.cutoff_hz) {
    const measured = summary.ac?.cutoffFrequency3dB ?? null;
    const ev = checkTarget('cutoff_hz', measured, spec.cutoff_hz);
    evaluations['cutoff_hz'] = ev;
    if (!ev.pass) allPass = false;
    totalErrorScore += (ev.error_pct || 0);
  }

  // 2. Overshoot % (Transient analysis)
  if (spec.overshoot_pct) {
    const measured = summary.transient?.overshootPercent ?? 0;
    const ev = checkTarget('overshoot_pct', measured, spec.overshoot_pct);
    evaluations['overshoot_pct'] = ev;
    if (!ev.pass) allPass = false;
    totalErrorScore += (ev.error_pct || 0);
  }

  // 3. Rise time (Transient analysis)
  if (spec.rise_time_s) {
    const measured = summary.transient?.riseTime ?? null;
    const ev = checkTarget('rise_time_s', measured, spec.rise_time_s);
    evaluations['rise_time_s'] = ev;
    if (!ev.pass) allPass = false;
    totalErrorScore += (ev.error_pct || 0);
  }

  // 4. Final value (Transient or DC)
  if (spec.final_value) {
    let measured: number | null = null;
    const targetSig = spec.signal?.toUpperCase();
    const foundSig = targetSig
      ? summary.signals.find((s) => s.name.toUpperCase() === targetSig)
      : (summary.signals.find((s) => s.name.toUpperCase().includes('OUT')) || summary.signals[0]);
    if (foundSig) {
      measured = foundSig.finalValue;
    }
    const ev = checkTarget('final_value', measured, spec.final_value);
    evaluations['final_value'] = ev;
    if (!ev.pass) allPass = false;
    totalErrorScore += (ev.error_pct || 0);
  }

  // 5. Output Ripple (Peak-to-Peak in steady-state, e.g. buck converter)
  if (spec.ripple_v || spec.ripple_mv) {
    let rippleV = 0;
    if (rawWaveform && rawWaveform.x.length > 20) {
      const n = rawWaveform.y.length;
      // Examine last 30% of simulation for steady-state ripple
      const startIdx = Math.floor(n * 0.7);
      const steadyY = rawWaveform.y.slice(startIdx);
      const minV = Math.min(...steadyY);
      const maxV = Math.max(...steadyY);
      rippleV = maxV - minV;
    }

    if (spec.ripple_v) {
      const ev = checkTarget('ripple_v', rippleV, spec.ripple_v);
      evaluations['ripple_v'] = ev;
      if (!ev.pass) allPass = false;
      totalErrorScore += (ev.error_pct || 0);
    }

    if (spec.ripple_mv) {
      const rippleMv = rippleV * 1000;
      const ev = checkTarget('ripple_mv', rippleMv, spec.ripple_mv);
      evaluations['ripple_mv'] = ev;
      if (!ev.pass) allPass = false;
      totalErrorScore += (ev.error_pct || 0);
    }
  }

  // 6. Mean output voltage (in steady-state, e.g. buck converter final periods)
  if (spec.mean_v) {
    let meanV: number | null = null;
    if (rawWaveform && rawWaveform.y.length > 0) {
      const n = rawWaveform.y.length;
      const startIdx = Math.floor(n * 0.7);
      const steadyY = rawWaveform.y.slice(startIdx);
      const sum = steadyY.reduce((acc, v) => acc + v, 0);
      meanV = sum / steadyY.length;
    } else if (summary.signals.length > 0) {
      const targetSig = spec.signal?.toUpperCase();
      const foundSig = targetSig
        ? summary.signals.find((s) => s.name.toUpperCase() === targetSig)
        : (summary.signals.find((s) => s.name.toUpperCase().includes('OUT')) || summary.signals[0]);
      if (foundSig) {
        meanV = (foundSig.min + foundSig.max) / 2;
      }
    }
    const ev = checkTarget('mean_v', meanV, spec.mean_v);
    evaluations['mean_v'] = ev;
    if (!ev.pass) allPass = false;
    totalErrorScore += (ev.error_pct || 0);
  }

  return {
    pass: allPass,
    errorScore: Number(totalErrorScore.toFixed(3)),
    evaluations,
  };
}

function checkTarget(name: string, measured: number | null, targetObj: SpecMetricTarget): MetricEvaluation {
  if (measured === null || isNaN(measured)) {
    return {
      metric: name,
      pass: false,
      measured: null,
      error_pct: 100,
      message: `Metric '${name}' could not be measured from simulation output`,
    };
  }

  let minAllowed = targetObj.min;
  let maxAllowed = targetObj.max;

  if (targetObj.target !== undefined) {
    const tol = targetObj.tol_pct !== undefined ? targetObj.tol_pct / 100 : 0.05;
    if (minAllowed === undefined) minAllowed = targetObj.target * (1 - tol);
    if (maxAllowed === undefined) maxAllowed = targetObj.target * (1 + tol);
  }

  let pass = true;
  let error_pct = 0;

  if (minAllowed !== undefined && measured < minAllowed) {
    pass = false;
    const ref = targetObj.target ?? minAllowed;
    error_pct = Math.abs((minAllowed - measured) / (ref || 1)) * 100;
  }

  if (maxAllowed !== undefined && measured > maxAllowed) {
    pass = false;
    const ref = targetObj.target ?? maxAllowed;
    const overErr = Math.abs((measured - maxAllowed) / (ref || 1)) * 100;
    error_pct = Math.max(error_pct, overErr);
  }

  if (targetObj.target !== undefined && !targetObj.min && !targetObj.max) {
    error_pct = Math.abs((measured - targetObj.target) / (targetObj.target || 1)) * 100;
  }

  return {
    metric: name,
    pass,
    measured: Number(measured.toFixed(4)),
    target: targetObj.target,
    minAllowed: minAllowed !== undefined ? Number(minAllowed.toFixed(4)) : undefined,
    maxAllowed: maxAllowed !== undefined ? Number(maxAllowed.toFixed(4)) : undefined,
    error_pct: Number(error_pct.toFixed(2)),
  };
}
