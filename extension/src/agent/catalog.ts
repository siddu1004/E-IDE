// Component catalog and engineering value utilities for circuit synthesis.
// Pure Node module, zero vscode imports.

export interface ComponentPin {
  name: string;
  aliases: string[];
  // Offset relative to symbol origin in standard R0 orientation
  dx: number;
  dy: number;
}

export interface CatalogEntry {
  type: string;
  refPrefix: string;
  ltspiceSymbol: string;
  kicadSymbol: string;
  pins: ComponentPin[];
}

export const E24_SERIES = [
  1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0,
  3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1
];

export const COMPONENT_CATALOG: Record<string, CatalogEntry> = {
  R: {
    type: 'R',
    refPrefix: 'R',
    ltspiceSymbol: 'res',
    kicadSymbol: 'Device:R',
    pins: [
      { name: '1', aliases: ['1', 'A', 'p1'], dx: 16, dy: 16 },
      { name: '2', aliases: ['2', 'B', 'p2'], dx: 16, dy: 96 },
    ],
  },
  C: {
    type: 'C',
    refPrefix: 'C',
    ltspiceSymbol: 'cap',
    kicadSymbol: 'Device:C',
    pins: [
      { name: '1', aliases: ['1', 'A', 'p1', '+'], dx: 16, dy: 0 },
      { name: '2', aliases: ['2', 'B', 'p2', '-'], dx: 16, dy: 64 },
    ],
  },
  L: {
    type: 'L',
    refPrefix: 'L',
    ltspiceSymbol: 'ind',
    kicadSymbol: 'Device:L',
    pins: [
      { name: '1', aliases: ['1', 'A', 'p1'], dx: 16, dy: 16 },
      { name: '2', aliases: ['2', 'B', 'p2'], dx: 16, dy: 96 },
    ],
  },
  V: {
    type: 'V',
    refPrefix: 'V',
    ltspiceSymbol: 'voltage',
    kicadSymbol: 'Simulation_SPICE:VDC',
    pins: [
      { name: '1', aliases: ['1', '+', 'pos', 'p1'], dx: 0, dy: 16 },
      { name: '2', aliases: ['2', '-', 'neg', 'p2'], dx: 0, dy: 96 },
    ],
  },
  I: {
    type: 'I',
    refPrefix: 'I',
    ltspiceSymbol: 'current',
    kicadSymbol: 'Simulation_SPICE:IDC',
    pins: [
      { name: '1', aliases: ['1', '+', 'pos'], dx: 0, dy: 16 },
      { name: '2', aliases: ['2', '-', 'neg'], dx: 0, dy: 96 },
    ],
  },
  D: {
    type: 'D',
    refPrefix: 'D',
    ltspiceSymbol: 'diode',
    kicadSymbol: 'Device:D',
    pins: [
      { name: '1', aliases: ['1', 'A', 'anode'], dx: 0, dy: 0 },
      { name: '2', aliases: ['2', 'K', 'cathode'], dx: 0, dy: 64 },
    ],
  },
  NPN: {
    type: 'NPN',
    refPrefix: 'Q',
    ltspiceSymbol: 'npn',
    kicadSymbol: 'Simulation_SPICE:NPN',
    pins: [
      { name: 'C', aliases: ['C', 'collector', '1'], dx: 32, dy: 0 },
      { name: 'B', aliases: ['B', 'base', '2'], dx: 0, dy: 32 },
      { name: 'E', aliases: ['E', 'emitter', '3'], dx: 32, dy: 64 },
    ],
  },
  PNP: {
    type: 'PNP',
    refPrefix: 'Q',
    ltspiceSymbol: 'pnp',
    kicadSymbol: 'Simulation_SPICE:PNP',
    pins: [
      { name: 'C', aliases: ['C', 'collector', '1'], dx: 32, dy: 64 },
      { name: 'B', aliases: ['B', 'base', '2'], dx: 0, dy: 32 },
      { name: 'E', aliases: ['E', 'emitter', '3'], dx: 32, dy: 0 },
    ],
  },
  NMOS: {
    type: 'NMOS',
    refPrefix: 'M',
    ltspiceSymbol: 'nmos',
    kicadSymbol: 'Simulation_SPICE:NMOS',
    pins: [
      { name: 'D', aliases: ['D', 'drain', '1'], dx: 32, dy: 0 },
      { name: 'G', aliases: ['G', 'gate', '2'], dx: 0, dy: 32 },
      { name: 'S', aliases: ['S', 'source', '3'], dx: 32, dy: 64 },
    ],
  },
  PMOS: {
    type: 'PMOS',
    refPrefix: 'M',
    ltspiceSymbol: 'pmos',
    kicadSymbol: 'Simulation_SPICE:PMOS',
    pins: [
      { name: 'D', aliases: ['D', 'drain', '1'], dx: 32, dy: 64 },
      { name: 'G', aliases: ['G', 'gate', '2'], dx: 0, dy: 32 },
      { name: 'S', aliases: ['S', 'source', '3'], dx: 32, dy: 0 },
    ],
  },
  opamp: {
    type: 'opamp',
    refPrefix: 'U',
    ltspiceSymbol: 'OpAmps\\opamp',
    kicadSymbol: 'Simulation_SPICE:OPAMP',
    pins: [
      { name: 'in-', aliases: ['in-', '-', 'inv', 'invin', '1'], dx: -32, dy: 48 },
      { name: 'in+', aliases: ['in+', '+', 'noninv', 'noninvin', '2'], dx: -32, dy: 80 },
      { name: 'out', aliases: ['out', 'OUT', '3'], dx: 32, dy: 64 },
    ],
  },
  GND: {
    type: 'GND',
    refPrefix: 'GND',
    ltspiceSymbol: 'FLAG 0',
    kicadSymbol: 'power:GND',
    pins: [
      { name: '0', aliases: ['0', '1', 'gnd', 'ground'], dx: 0, dy: 0 },
    ],
  },
};

/**
 * Normalizes component type key (e.g. 'resistor' -> 'R', 'cap' -> 'C', etc.).
 */
export function normalizeComponentType(type: string): CatalogEntry {
  const upper = type.toUpperCase().trim();
  if (COMPONENT_CATALOG[upper]) return COMPONENT_CATALOG[upper];

  if (upper.startsWith('RES') || upper === 'RESISTOR') return COMPONENT_CATALOG['R'];
  if (upper.startsWith('CAP') || upper === 'CAPACITOR') return COMPONENT_CATALOG['C'];
  if (upper.startsWith('IND') || upper === 'INDUCTOR') return COMPONENT_CATALOG['L'];
  if (upper.startsWith('VOLT') || upper === 'VSRC' || upper === 'VDC') return COMPONENT_CATALOG['V'];
  if (upper.startsWith('CURR') || upper === 'ISRC') return COMPONENT_CATALOG['I'];
  if (upper.startsWith('DIODE')) return COMPONENT_CATALOG['D'];
  if (upper.includes('OPAMP') || upper === 'AMP') return COMPONENT_CATALOG['opamp'];
  if (upper.includes('GND') || upper === 'GROUND') return COMPONENT_CATALOG['GND'];

  throw new Error(`Unsupported component type '${type}'. Available: ${Object.keys(COMPONENT_CATALOG).join(', ')}`);
}

/**
 * Snaps a numerical value (resistor, capacitor) to the nearest E24 series value.
 */
export function snapToE24(val: number): number {
  if (val <= 0 || !isFinite(val)) return val;
  const decade = Math.pow(10, Math.floor(Math.log10(val)));
  const normalized = val / decade;

  let best = E24_SERIES[0];
  let minDiff = Math.abs(normalized - best);

  for (let i = 1; i < E24_SERIES.length; i++) {
    const diff = Math.abs(normalized - E24_SERIES[i]);
    if (diff < minDiff) {
      minDiff = diff;
      best = E24_SERIES[i];
    }
  }

  // Handle rounding near 10
  const result = best * decade;
  return Number(result.toPrecision(4));
}

/**
 * Parses engineering formatted values like '1k', '4.7k', '100n', '10u', '1meg', '12V'.
 */
export function parseEngValue(str: string): number {
  if (typeof str !== 'string') return Number(str);
  const trimmed = str.trim();
  const m = trimmed.match(/^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*([a-zA-Z]*)/);
  if (!m) {
    const direct = Number(trimmed);
    if (!isNaN(direct)) return direct;
    throw new Error(`Cannot parse engineering value '${str}'`);
  }

  const num = parseFloat(m[1]);
  const unit = m[2].toLowerCase();

  const multMap: Record<string, number> = {
    'f': 1e-15,
    'p': 1e-12,
    'n': 1e-9,
    'u': 1e-6,
    'm': 1e-3,
    'k': 1e3,
    'meg': 1e6,
    'g': 1e9,
    't': 1e12,
  };

  // Strip trailing voltage/farad/hertz characters e.g. '10uf' -> 'u', '2khz' -> 'k', '12v' -> ''
  let prefix = unit;
  if (prefix.endsWith('hz') || prefix.endsWith('v') || prefix.endsWith('a') || prefix.endsWith('f') || prefix.endsWith('h')) {
    prefix = prefix.replace(/(hz|v|a|f|h)$/, '');
  }

  if (prefix === '' || prefix === 'r' || prefix === 'ohm' || prefix === 'ohms') {
    return num;
  }

  const mult = multMap[prefix];
  if (mult !== undefined) {
    const raw = num * mult;
    return Number(raw.toPrecision(12));
  }

  return num;
}

/**
 * Formats a number to engineering notation (e.g. 1000 -> '1k', 1e-7 -> '100n').
 */
export function formatEngValue(val: number): string {
  if (val === 0 || !isFinite(val)) return '0';
  const abs = Math.abs(val);

  if (abs >= 1e9) return (val / 1e9).toFixed(3).replace(/\.?0+$/, '') + 'g';
  if (abs >= 1e6) return (val / 1e6).toFixed(3).replace(/\.?0+$/, '') + 'meg';
  if (abs >= 1e3) return (val / 1e3).toFixed(3).replace(/\.?0+$/, '') + 'k';
  if (abs >= 1) return val.toFixed(3).replace(/\.?0+$/, '');
  if (abs >= 1e-3) return (val / 1e-3).toFixed(3).replace(/\.?0+$/, '') + 'm';
  if (abs >= 1e-6) return (val / 1e-6).toFixed(3).replace(/\.?0+$/, '') + 'u';
  if (abs >= 1e-9) return (val / 1e-9).toFixed(3).replace(/\.?0+$/, '') + 'n';
  if (abs >= 1e-12) return (val / 1e-12).toFixed(3).replace(/\.?0+$/, '') + 'p';
  if (abs >= 1e-15) return (val / 1e-15).toFixed(3).replace(/\.?0+$/, '') + 'f';

  return val.toExponential(2);
}
