// Bounded parameter tuning engine for circuits and dynamic models.
// Pure Node module, zero vscode imports.

import { formatEngValue, snapToE24 } from './catalog';

export interface TuneParamConfig {
  name: string; // e.g. 'R1', 'C1', 'Gain', 'Denominator'
  min: number;
  max: number;
  initial?: number;
  snapE24?: boolean; // true for standard electrical components
}

export interface TuneIterationProgress {
  iteration: number;
  currentParams: Record<string, number | string>;
  errorScore: number;
  pass: boolean;
}

export interface TuneResult {
  success: boolean;
  iterations: number;
  bestParams: Record<string, number | string>;
  finalError: number;
}

export type EvaluateFn = (
  values: Record<string, number | string>,
  iter: number
) => Promise<{ pass: boolean; errorScore: number }>;

/**
 * Executes a bounded coordinate descent in log parameter space.
 */
export async function runTuner(
  params: TuneParamConfig[],
  evaluator: EvaluateFn,
  maxIterations: number = 20,
  onProgress?: (p: TuneIterationProgress) => void
): Promise<TuneResult> {
  if (params.length === 0) {
    throw new Error('Tuner requires at least one parameter to optimize.');
  }

  // Initialize values (midpoint in log scale or initial)
  const currentValues: Record<string, number> = {};
  for (const p of params) {
    if (p.initial !== undefined && p.initial >= p.min && p.initial <= p.max) {
      currentValues[p.name] = p.initial;
    } else {
      // Geometric midpoint
      currentValues[p.name] = Math.sqrt(p.min * p.max);
    }
    if (p.snapE24 !== false) {
      currentValues[p.name] = snapToE24(currentValues[p.name]);
    }
  }

  // Format params for evaluation
  function formatParams(raw: Record<string, number>): Record<string, number | string> {
    const formatted: Record<string, number | string> = {};
    for (const p of params) {
      const v = raw[p.name];
      if (p.snapE24 !== false) {
        formatted[p.name] = formatEngValue(v);
      } else {
        formatted[p.name] = Number(v.toFixed(4));
      }
    }
    return formatted;
  }

  // Evaluate baseline
  let iter = 1;
  let formatted = formatParams(currentValues);
  let bestRes = await evaluator(formatted, iter);
  let bestError = bestRes.errorScore;
  let bestParams = { ...formatted };

  if (onProgress) {
    onProgress({
      iteration: iter,
      currentParams: formatted,
      errorScore: bestError,
      pass: bestRes.pass,
    });
  }

  if (bestRes.pass || iter >= maxIterations) {
    return {
      success: bestRes.pass,
      iterations: iter,
      bestParams,
      finalError: bestError,
    };
  }

  // Coordinate descent loops over parameters
  let converged = false;
  while (iter < maxIterations && !converged && !bestRes.pass) {
    let improvedInCycle = false;

    for (const p of params) {
      if (iter >= maxIterations || bestRes.pass) break;

      const curVal = currentValues[p.name];
      // Try step up and step down by granular factors in log space
      const testFactors = [0.8, 1.25, 0.9, 1.1, 0.7, 1.4, 0.5, 2.0];

      for (const factor of testFactors) {
        if (iter >= maxIterations || bestRes.pass) break;

        let candidate = curVal * factor;
        candidate = Math.max(p.min, Math.min(p.max, candidate));
        if (p.snapE24 !== false) {
          candidate = snapToE24(candidate);
        }

        if (Math.abs(candidate - curVal) < 1e-12) continue;

        const candidateValues = { ...currentValues, [p.name]: candidate };
        const candidateFormatted = formatParams(candidateValues);

        iter++;
        const evalRes = await evaluator(candidateFormatted, iter);

        if (onProgress) {
          onProgress({
            iteration: iter,
            currentParams: candidateFormatted,
            errorScore: evalRes.errorScore,
            pass: evalRes.pass,
          });
        }

        if (evalRes.errorScore < bestError) {
          bestError = evalRes.errorScore;
          bestParams = { ...candidateFormatted };
          currentValues[p.name] = candidate;
          improvedInCycle = true;

          if (evalRes.pass) {
            return {
              success: true,
              iterations: iter,
              bestParams,
              finalError: bestError,
            };
          }
        }
      }
    }

    if (!improvedInCycle) {
      converged = true;
    }
  }

  return {
    success: bestRes.pass,
    iterations: iter,
    bestParams,
    finalError: bestError,
  };
}
