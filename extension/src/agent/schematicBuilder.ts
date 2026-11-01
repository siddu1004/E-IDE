// Programmatic schematic synthesis engine for LTspice (.asc) and KiCad (.kicad_sch).
// Pure Node module, zero vscode imports.

import { COMPONENT_CATALOG, normalizeComponentType, CatalogEntry } from './catalog';

export interface PlacedPin {
  ref: string;
  pinName: string;
  x: number;
  y: number;
}

export interface ComponentInstance {
  ref: string;
  type: string;
  value: string;
  x: number;
  y: number;
  rotation: string;
  pins: PlacedPin[];
}

/**
 * Creates an empty schematic string for the given file extension.
 */
export function createEmptySchematic(ext: '.asc' | '.kicad_sch'): string {
  if (ext === '.asc') {
    return 'Version 4\nSHEET 1 880 680\n';
  } else {
    return `(kicad_sch
\t(version 20250108)
\t(generator "eeschema")
\t(generator_version "10.0")
\t(uuid "00000000-0000-0000-0000-000000000001")
\t(paper "A4")
\t(lib_symbols
\t\t(symbol "Device:R"
\t\t\t(pin_numbers hide)
\t\t\t(pin_names (offset 0))
\t\t\t(property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(property "Value" "R" (at -2.032 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(symbol "R_1_1"
\t\t\t\t(pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
\t\t\t\t(pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
\t\t\t)
\t\t)
\t\t(symbol "Device:C"
\t\t\t(pin_numbers hide)
\t\t\t(pin_names (offset 0))
\t\t\t(property "Reference" "C" (at 1.651 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(property "Value" "C" (at -1.651 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(symbol "C_1_1"
\t\t\t\t(pin passive line (at 0 3.81 270) (length 3.048) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
\t\t\t\t(pin passive line (at 0 -3.81 90) (length 3.048) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
\t\t\t)
\t\t)
\t\t(symbol "Simulation_SPICE:VDC"
\t\t\t(pin_names (offset 0))
\t\t\t(property "Reference" "V" (at 2.54 1.27 0) (effects (font (size 1.27 1.27))))
\t\t\t(property "Value" "VDC" (at 2.54 -1.27 0) (effects (font (size 1.27 1.27))))
\t\t\t(symbol "VDC_1_1"
\t\t\t\t(pin passive line (at 0 6.35 270) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
\t\t\t\t(pin passive line (at 0 -6.35 90) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
\t\t\t)
\t\t)
\t)
)\n`;
  }
}

/**
 * Parses existing components and pin locations from LTspice .asc schematic text.
 */
export function parseAscComponents(content: string): ComponentInstance[] {
  const lines = content.split(/\r?\n/);
  const components: ComponentInstance[] = [];

  let curSymbol: { name: string; x: number; y: number; rot: string } | null = null;
  let curInstName: string | null = null;
  let curValue: string | null = null;

  function commitSymbol() {
    if (curSymbol && curInstName) {
      let cat: CatalogEntry;
      try {
        cat = normalizeComponentType(curSymbol.name);
      } catch {
        cat = COMPONENT_CATALOG['R'];
      }

      const pins: PlacedPin[] = cat.pins.map((p) => {
        // Rotate pin offset according to LTspice symbol rotation
        const { dx, dy } = rotateLtspiceOffset(p.dx, p.dy, curSymbol!.rot);
        return {
          ref: curInstName!,
          pinName: p.name,
          x: curSymbol!.x + dx,
          y: curSymbol!.y + dy,
        };
      });

      components.push({
        ref: curInstName,
        type: cat.type,
        value: curValue || '',
        x: curSymbol.x,
        y: curSymbol.y,
        rotation: curSymbol.rot,
        pins,
      });
    }
    curSymbol = null;
    curInstName = null;
    curValue = null;
  }

  let gndIndex = 1;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('SYMBOL ')) {
      commitSymbol();
      const parts = trimmed.split(/\s+/);
      curSymbol = {
        name: parts[1],
        x: parseInt(parts[2], 10) || 0,
        y: parseInt(parts[3], 10) || 0,
        rot: parts[4] || 'R0',
      };
    } else if (trimmed.startsWith('SYMATTR InstName ')) {
      curInstName = trimmed.substring('SYMATTR InstName '.length).trim();
    } else if (trimmed.startsWith('SYMATTR Value ')) {
      curValue = trimmed.substring('SYMATTR Value '.length).trim();
    } else if (trimmed.startsWith('FLAG ')) {
      const parts = trimmed.split(/\s+/);
      const fx = parseInt(parts[1], 10) || 0;
      const fy = parseInt(parts[2], 10) || 0;
      const label = parts[3];
      if (label === '0' || label === 'GND') {
        const ref = `GND${gndIndex++}`;
        components.push({
          ref,
          type: 'GND',
          value: '0',
          x: fx,
          y: fy,
          rotation: 'R0',
          pins: [{ ref, pinName: '0', x: fx, y: fy }],
        });
      }
    }
  }
  commitSymbol();

  return components;
}

function rotateLtspiceOffset(dx: number, dy: number, rot: string): { dx: number; dy: number } {
  switch (rot) {
    case 'R90': return { dx: -dy, dy: dx };
    case 'R180': return { dx: -dx, dy: -dy };
    case 'R270': return { dx: dy, dy: -dx };
    case 'M0': return { dx: -dx, dy: dy };
    case 'M90': return { dx: dy, dy: dx };
    case 'M180': return { dx: dx, dy: -dy };
    case 'M270': return { dx: -dy, dy: -dx };
    case 'R0':
    default:
      return { dx, dy };
  }
}

/**
 * Determines next available reference designator (e.g. R1, R2, C1...).
 */
export function getNextRef(existing: ComponentInstance[], prefix: string): string {
  let highest = 0;
  for (const c of existing) {
    if (c.ref.startsWith(prefix)) {
      const num = parseInt(c.ref.substring(prefix.length), 10);
      if (!isNaN(num) && num > highest) {
        highest = num;
      }
    }
  }
  return `${prefix}${highest + 1}`;
}

/**
 * Adds a component to LTspice .asc schematic content.
 */
export function addComponentToAsc(
  content: string,
  type: string,
  value: string,
  nearRef?: string,
  orientation: string = 'R0'
): { newContent: string; ref: string; x: number; y: number } {
  const catalog = normalizeComponentType(type);
  const existing = parseAscComponents(content);
  const ref = catalog.type === 'GND' ? getNextRef(existing, 'GND') : getNextRef(existing, catalog.refPrefix);

  // Compute position
  let x = 64;
  let y = 128;

  if (nearRef) {
    let targetRef = nearRef;
    let relDir = 'right';
    const m = nearRef.match(/^(above|below|left|right)[:(]([A-Za-z0-9_]+)\)?$/i);
    if (m) {
      relDir = m[1].toLowerCase();
      targetRef = m[2];
    }
    const nearComp = existing.find((c) => c.ref.toUpperCase() === targetRef.toUpperCase());
    if (nearComp) {
      if (relDir === 'above') {
        x = nearComp.x;
        y = nearComp.y - 80;
      } else if (relDir === 'below') {
        x = nearComp.x;
        y = nearComp.y + 64;
      } else if (relDir === 'left') {
        x = nearComp.x - 96;
        y = nearComp.y;
      } else {
        x = nearComp.x + 96;
        y = nearComp.y;
      }
    }
  } else if (existing.length > 0) {
    const maxX = Math.max(...existing.map((c) => c.x));
    x = maxX + 96;
    y = 128;
  }

  // Snap to 16-pixel LTspice grid
  x = Math.round(x / 16) * 16;
  y = Math.round(y / 16) * 16;

  let block = '';
  if (catalog.type === 'GND') {
    block = `FLAG ${x} ${y} 0\n`;
  } else {
    block = `SYMBOL ${catalog.ltspiceSymbol} ${x} ${y} ${orientation}\nSYMATTR InstName ${ref}\nSYMATTR Value ${value}\n`;
  }

  return {
    newContent: content.trimEnd() + '\n' + block,
    ref,
    x,
    y,
  };
}

/**
 * Resolves absolute pin coordinates for pin address e.g. 'R1.1', 'U1.OUT', 'GND1.0'.
 */
export function resolvePinCoord(components: ComponentInstance[], pinAddr: string): PlacedPin {
  const parts = pinAddr.split('.');
  if (parts.length < 2) {
    throw new Error(`Invalid pin address '${pinAddr}'. Expected format '<REF>.<PIN>' (e.g. 'R1.1', 'U1.out')`);
  }

  const ref = parts[0].toUpperCase();
  const pinQuery = parts[1].toLowerCase();

  const comp = components.find((c) => c.ref.toUpperCase() === ref);
  if (!comp) {
    throw new Error(`Component '${ref}' not found in schematic. Existing: ${components.map((c) => c.ref).join(', ')}`);
  }

  const cat = COMPONENT_CATALOG[comp.type] || normalizeComponentType(comp.type);
  let matchedPinName = pinQuery;

  // Search pin aliases
  for (const p of cat.pins) {
    if (p.name.toLowerCase() === pinQuery || p.aliases.some((a) => a.toLowerCase() === pinQuery)) {
      matchedPinName = p.name;
      break;
    }
  }

  const found = comp.pins.find((p) => p.pinName.toLowerCase() === matchedPinName.toLowerCase());
  if (!found) {
    throw new Error(`Pin '${pinQuery}' not found on ${ref}. Available pins: ${comp.pins.map((p) => p.pinName).join(', ')}`);
  }

  return found;
}

function segmentCrossesPin(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  components: ComponentInstance[],
  ignorePins: PlacedPin[]
): boolean {
  for (const c of components) {
    for (const p of c.pins) {
      if (ignorePins.some((ip) => ip.x === p.x && ip.y === p.y)) continue;
      // Vertical segment
      if (x1 === x2 && p.x === x1) {
        if (p.y >= Math.min(y1, y2) && p.y <= Math.max(y1, y2)) {
          return true;
        }
      }
      // Horizontal segment
      if (y1 === y2 && p.y === y1) {
        if (p.x >= Math.min(x1, x2) && p.x <= Math.max(x1, x2)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Connects two pins in an LTspice .asc schematic using orthogonal wire routing,
 * or attaches a net flag/label if one pin address is a label without a dot (e.g. 'out' or '0').
 */
export function connectPinsInAsc(content: string, pinA: string, pinB: string): string {
  const components = parseAscComponents(content);

  // If one of the endpoints is a net label/ground flag (e.g. 'out', '0', 'GND')
  if (!pinB.includes('.')) {
    const pA = resolvePinCoord(components, pinA);
    const label = pinB.toUpperCase() === 'GND' ? '0' : pinB;
    return content.trimEnd() + `\nFLAG ${pA.x} ${pA.y} ${label}\n`;
  }
  if (!pinA.includes('.')) {
    const pB = resolvePinCoord(components, pinB);
    const label = pinA.toUpperCase() === 'GND' ? '0' : pinA;
    return content.trimEnd() + `\nFLAG ${pB.x} ${pB.y} ${label}\n`;
  }

  const pA = resolvePinCoord(components, pinA);
  const pB = resolvePinCoord(components, pinB);

  if (pA.x === pB.x && pA.y === pB.y) {
    return content;
  }

  let wires = '';
  if (pA.x === pB.x || pA.y === pB.y) {
    // Direct horizontal or vertical wire
    wires = `WIRE ${pA.x} ${pA.y} ${pB.x} ${pB.y}\n`;
  } else {
    // Select orthogonal route that avoids intermediate pin collision
    const ignore = [pA, pB];
    const a1Crosses = segmentCrossesPin(pA.x, pA.y, pB.x, pA.y, components, ignore);
    const a2Crosses = segmentCrossesPin(pB.x, pA.y, pB.x, pB.y, components, ignore);
    const routeACrosses = a1Crosses || a2Crosses;

    const b1Crosses = segmentCrossesPin(pA.x, pA.y, pA.x, pB.y, components, ignore);
    const b2Crosses = segmentCrossesPin(pA.x, pB.y, pB.x, pB.y, components, ignore);
    const routeBCrosses = b1Crosses || b2Crosses;

    if (!routeACrosses) {
      wires = `WIRE ${pA.x} ${pA.y} ${pB.x} ${pA.y}\nWIRE ${pB.x} ${pA.y} ${pB.x} ${pB.y}\n`;
    } else if (!routeBCrosses) {
      wires = `WIRE ${pA.x} ${pA.y} ${pA.x} ${pB.y}\nWIRE ${pA.x} ${pB.y} ${pB.x} ${pB.y}\n`;
    } else {
      const jogY = Math.max(pA.y, pB.y) + 32;
      wires = `WIRE ${pA.x} ${pA.y} ${pA.x} ${jogY}\nWIRE ${pA.x} ${jogY} ${pB.x} ${jogY}\nWIRE ${pB.x} ${jogY} ${pB.x} ${pB.y}\n`;
    }
  }

  return content.trimEnd() + '\n' + wires;
}

/**
 * Removes a component and connected wire endpoints from an LTspice .asc schematic.
 */
export function removeComponentFromAsc(content: string, ref: string): string {
  const lines = content.split(/\r?\n/);
  const newLines: string[] = [];
  let inTargetSymbol = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('SYMBOL ')) {
      // Look ahead for InstName
      let isMatch = false;
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (lines[j].trim().startsWith(`SYMATTR InstName ${ref}`)) {
          isMatch = true;
          break;
        }
        if (lines[j].trim().startsWith('SYMBOL ')) break;
      }
      if (isMatch) {
        inTargetSymbol = true;
        continue;
      }
    }

    if (inTargetSymbol) {
      if (trimmed.startsWith('SYMBOL ') || trimmed.startsWith('TEXT ') || trimmed.startsWith('WIRE ') || trimmed.startsWith('FLAG ')) {
        inTargetSymbol = false;
      } else {
        continue;
      }
    }

    newLines.push(line);
  }

  return newLines.join('\n');
}

/**
 * Appends a SPICE text directive to an LTspice .asc schematic.
 */
export function addDirectiveToAsc(content: string, text: string): string {
  const clean = text.trim().startsWith('!') ? text.trim() : `!${text.trim()}`;
  const existingDirectives = (content.match(/^TEXT\s+/gm) || []).length;
  const y = 300 + existingDirectives * 24;
  return content.trimEnd() + `\nTEXT 32 ${y} Left 2 ${clean}\n`;
}
