// Pure logic for waveform summaries and downsampling.
// Zero vscode dependencies: tested directly with node --test.

export interface SignalSummary {
  name: string;
  min: number;
  max: number;
  finalValue: number;
}

export interface TransientAnalysis {
  primarySignal: string;
  riseTime?: number; // seconds (10% to 90% crossing)
  overshootPercent?: number; // % overshoot above steady state
}

export interface AcAnalysis {
  primarySignal: string;
  cutoffFrequency3dB?: number; // Hz
  phaseAt3dB?: number; // degrees
}

export interface CompactSimulationSummary {
  plotName: string;
  signals: SignalSummary[];
  measurements?: Record<string, number>;
  transient?: TransientAnalysis;
  ac?: AcAnalysis;
}

export interface DownsampledWaveform {
  signal: string;
  totalPoints: number;
  returnedPoints: number;
  x: number[];
  y: number[];
}

export function downsampleSeries(
  x: number[],
  y: number[],
  maxPoints: number = 200
): { x: number[]; y: number[] } {
  if (x.length === 0) return { x: [], y: [] };
  if (x.length <= maxPoints || maxPoints < 2) {
    return { x: Array.from(x), y: Array.from(y) };
  }

  const resultX: number[] = new Array(maxPoints);
  const resultY: number[] = new Array(maxPoints);
  const n = x.length;
  const step = (n - 1) / (maxPoints - 1);

  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(n - 1, Math.round(i * step));
    resultX[i] = x[idx];
    resultY[i] = y[idx];
  }

  return { x: resultX, y: resultY };
}

export function analyzeTransient(
  x: number[],
  y: number[],
  signalName: string
): TransientAnalysis | undefined {
  if (x.length < 2 || y.length < 2) return undefined;

  const y0 = y[0];
  const yFinal = y[y.length - 1];
  const delta = yFinal - y0;

  if (Math.abs(delta) < 1e-9) {
    return { primarySignal: signalName };
  }

  let riseTime: number | undefined;
  let overshootPercent: number | undefined;

  if (delta > 0) {
    // Rising transition
    const target10 = y0 + 0.1 * delta;
    const target90 = y0 + 0.9 * delta;

    let t10: number | undefined;
    let t90: number | undefined;

    for (let i = 0; i < y.length - 1; i++) {
      if (t10 === undefined && y[i] <= target10 && y[i + 1] >= target10) {
        const frac = (target10 - y[i]) / (y[i + 1] - y[i] || 1);
        t10 = x[i] + frac * (x[i + 1] - x[i]);
      }
      if (t90 === undefined && y[i] <= target90 && y[i + 1] >= target90) {
        const frac = (target90 - y[i]) / (y[i + 1] - y[i] || 1);
        t90 = x[i] + frac * (x[i + 1] - x[i]);
        break;
      }
    }

    if (t10 !== undefined && t90 !== undefined && t90 >= t10) {
      riseTime = t90 - t10;
    }

    let maxVal = y[0];
    for (let i = 1; i < y.length; i++) {
      if (y[i] > maxVal) maxVal = y[i];
    }

    if (maxVal > yFinal) {
      overshootPercent = ((maxVal - yFinal) / delta) * 100;
    } else {
      overshootPercent = 0;
    }
  } else {
    // Falling transition
    const target10 = y0 - 0.1 * Math.abs(delta);
    const target90 = y0 - 0.9 * Math.abs(delta);

    let t10: number | undefined;
    let t90: number | undefined;

    for (let i = 0; i < y.length - 1; i++) {
      if (t10 === undefined && y[i] >= target10 && y[i + 1] <= target10) {
        const frac = (y[i] - target10) / (y[i] - y[i + 1] || 1);
        t10 = x[i] + frac * (x[i + 1] - x[i]);
      }
      if (t90 === undefined && y[i] >= target90 && y[i + 1] <= target90) {
        const frac = (y[i] - target90) / (y[i] - y[i + 1] || 1);
        t90 = x[i] + frac * (x[i + 1] - x[i]);
        break;
      }
    }

    if (t10 !== undefined && t90 !== undefined && t90 >= t10) {
      riseTime = t90 - t10;
    }

    let minVal = y[0];
    for (let i = 1; i < y.length; i++) {
      if (y[i] < minVal) minVal = y[i];
    }

    if (minVal < yFinal) {
      overshootPercent = ((yFinal - minVal) / Math.abs(delta)) * 100;
    } else {
      overshootPercent = 0;
    }
  }

  return {
    primarySignal: signalName,
    riseTime,
    overshootPercent: overshootPercent !== undefined ? Math.round(overshootPercent * 100) / 100 : undefined,
  };
}

export function analyzeAc(
  freq: number[],
  magDb: number[],
  phaseDeg: number[],
  signalName: string
): AcAnalysis | undefined {
  if (freq.length < 2 || magDb.length < 2) return undefined;

  const lowFreqMag = magDb[0];
  const target3dB = lowFreqMag - 3.0103; // -3 dB drop from passband

  let cutoffFreq: number | undefined;
  let phaseAtCutoff: number | undefined;

  for (let i = 0; i < magDb.length - 1; i++) {
    const m1 = magDb[i];
    const m2 = magDb[i + 1];

    if ((m1 >= target3dB && m2 <= target3dB) || (m1 <= target3dB && m2 >= target3dB)) {
      const frac = (target3dB - m1) / (m2 - m1 || 1);
      // Interpolate frequency in log scale if positive, else linear
      if (freq[i] > 0 && freq[i + 1] > 0) {
        const logF1 = Math.log10(freq[i]);
        const logF2 = Math.log10(freq[i + 1]);
        cutoffFreq = Math.pow(10, logF1 + frac * (logF2 - logF1));
      } else {
        cutoffFreq = freq[i] + frac * (freq[i + 1] - freq[i]);
      }
      phaseAtCutoff = phaseDeg[i] + frac * (phaseDeg[i + 1] - phaseDeg[i]);
      break;
    }
  }

  return {
    primarySignal: signalName,
    cutoffFrequency3dB: cutoffFreq !== undefined ? Math.round(cutoffFreq * 10) / 10 : undefined,
    phaseAt3dB: phaseAtCutoff !== undefined ? Math.round(phaseAtCutoff * 100) / 100 : undefined,
  };
}

export function summarizeSimulationData(params: {
  plotName: string;
  x: number[];
  series: Record<string, number[] | { re: number[]; im: number[] }>;
  measurements?: Record<string, number>;
}): CompactSimulationSummary {
  const { plotName, x, series, measurements } = params;
  const isAc = plotName.toLowerCase().includes('ac') || Object.values(series).some((s) => !Array.isArray(s));
  const isTransient = plotName.toLowerCase().includes('transient') || !isAc;

  const signals: SignalSummary[] = [];
  // Select primary signal prioritizing output over input
  let primarySignal = '';
  for (const name of Object.keys(series)) {
    const lower = name.toLowerCase();
    if (lower.includes('out') || lower === 'y' || lower.endsWith('_out')) {
      primarySignal = name;
      break;
    }
  }
  if (!primarySignal) {
    for (const name of Object.keys(series)) {
      const lower = name.toLowerCase();
      if (!lower.includes('in') && (name.startsWith('V(') || name.startsWith('v(') || name.startsWith('I('))) {
        primarySignal = name;
        break;
      }
    }
  }
  if (!primarySignal && Object.keys(series).length > 0) {
    primarySignal = Object.keys(series)[0];
  }

  for (const [name, data] of Object.entries(series)) {
    if (Array.isArray(data)) {
      if (data.length === 0) continue;
      let min = data[0];
      let max = data[0];
      for (const v of data) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      signals.push({
        name,
        min: Math.round(min * 10000) / 10000,
        max: Math.round(max * 10000) / 10000,
        finalValue: Math.round(data[data.length - 1] * 10000) / 10000,
      });
    } else {
      // Complex series { re, im }
      const re = data.re;
      const im = data.im;
      let minMag = Infinity;
      let maxMag = -Infinity;
      let finalMag = 0;

      for (let i = 0; i < re.length; i++) {
        const mag = 20 * Math.log10(Math.hypot(re[i], im[i]) || 1e-15);
        if (mag < minMag) minMag = mag;
        if (mag > maxMag) maxMag = mag;
        if (i === re.length - 1) finalMag = mag;
      }

      signals.push({
        name,
        min: Math.round(minMag * 100) / 100,
        max: Math.round(maxMag * 100) / 100,
        finalValue: Math.round(finalMag * 100) / 100,
      });
    }
  }

  if (!primarySignal && signals.length > 0) {
    primarySignal = signals[0].name;
  }

  let transient: TransientAnalysis | undefined;
  let ac: AcAnalysis | undefined;

  if (primarySignal && series[primarySignal]) {
    const primaryData = series[primarySignal];
    if (isAc && !Array.isArray(primaryData)) {
      const re = primaryData.re;
      const im = primaryData.im;
      const magDb: number[] = new Array(re.length);
      const phaseDeg: number[] = new Array(re.length);
      for (let i = 0; i < re.length; i++) {
        magDb[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) || 1e-15);
        phaseDeg[i] = (Math.atan2(im[i], re[i]) * 180) / Math.PI;
      }
      ac = analyzeAc(x, magDb, phaseDeg, primarySignal);
    } else if (isTransient && Array.isArray(primaryData)) {
      transient = analyzeTransient(x, primaryData, primarySignal);
    }
  }

  return {
    plotName,
    signals,
    measurements,
    transient,
    ac,
  };
}
