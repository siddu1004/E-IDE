// KiCad schematic (.kicad_sch) model and parser for KiCad 7 to 10.
// Extracts lib_symbols, placed symbols, wires, junctions, labels, and text.
// Builds nets, computes property edits, and diffs schematics.
// Pure TypeScript module, zero vscode imports.

import {
  findChildList,
  findChildLists,
  getAtomAt,
  getListTag,
  parseSExpr,
  quoteString,
  SExpr,
  SExprAtom,
  SExprList,
} from './sexpr';

export interface KicadPinDef {
  name: string;
  number: string;
  type: string;
  shape: string;
  x: number;
  y: number;
  angle: number;
  length: number;
}

export interface KicadGraphicItem {
  type: 'rectangle' | 'polyline' | 'circle' | 'arc';
  pts: Array<{ x: number; y: number }>;
  center?: { x: number; y: number };
  radius?: number;
  strokeWidth?: number;
  fill?: string;
}

export interface KicadLibSymbol {
  id: string;
  pins: KicadPinDef[];
  graphics: KicadGraphicItem[];
  properties: Record<string, string>;
}

export interface KicadProperty {
  name: string;
  value: string;
  x: number;
  y: number;
  angle: number;
  hide: boolean;
  valueStart: number;
  valueEnd: number;
  raw: string;
}

export interface KicadPlacedSymbol {
  uuid: string;
  libId: string;
  x: number;
  y: number;
  angle: number;
  mirror?: 'x' | 'y';
  unit: number;
  properties: Record<string, KicadProperty>;
  ref: string;
  value: string;
  footprint: string;
  pins: Array<{ number: string; uuid: string }>;
}

export interface KicadWire {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  uuid: string;
}

export interface KicadJunction {
  x: number;
  y: number;
  uuid: string;
}

export interface KicadLabel {
  name: string;
  x: number;
  y: number;
  angle: number;
  type: 'local' | 'global' | 'hierarchical';
  uuid: string;
}

export interface KicadText {
  text: string;
  x: number;
  y: number;
  angle: number;
  directive: boolean;
  uuid: string;
}

export interface KicadPinRef {
  ref: string;
  pin: string;
}

export interface KicadNet {
  name: string;
  pins: KicadPinRef[];
}

export interface KicadSchematic {
  version: number;
  generator: string;
  uuid: string;
  paper: string;
  libSymbols: Map<string, KicadLibSymbol>;
  symbols: KicadPlacedSymbol[];
  wires: KicadWire[];
  junctions: KicadJunction[];
  labels: KicadLabel[];
  texts: KicadText[];
  nets: KicadNet[];
  ast: SExprList;
}

export interface SchematicChanges {
  symbols: string[];
  removedSymbols: string[];
  wires: number[];
  texts: number[];
}

export interface PropertyEdit {
  start: number;
  end: number;
  text: string;
  oldText: string;
  line: number;
}

const num = (s: string | undefined): number => parseFloat(s ?? '0') || 0;

function parseAt(list: SExprList | undefined): { x: number; y: number; angle: number } {
  if (!list) return { x: 0, y: 0, angle: 0 };
  return {
    x: num(getAtomAt(list, 1)),
    y: num(getAtomAt(list, 2)),
    angle: num(getAtomAt(list, 3)),
  };
}

function parseLibSymbol(symList: SExprList): KicadLibSymbol {
  const id = getAtomAt(symList, 1) || '';
  const pins: KicadPinDef[] = [];
  const graphics: KicadGraphicItem[] = [];
  const properties: Record<string, string> = {};

  function traverse(node: SExprList) {
    for (const child of node.children) {
      if (child.type !== 'list') continue;
      const tag = getListTag(child);
      if (tag === 'symbol') {
        traverse(child);
      } else if (tag === 'property') {
        const key = getAtomAt(child, 1);
        const val = getAtomAt(child, 2);
        if (key && val !== undefined) properties[key] = val;
      } else if (tag === 'pin') {
        // (pin <type> <shape> (at x y angle) (length len) (name "...") (number "..."))
        const type = getAtomAt(child, 1) || 'passive';
        const shape = getAtomAt(child, 2) || 'line';
        const atList = findChildList(child, 'at');
        const at = parseAt(atList);
        const lenList = findChildList(child, 'length');
        const length = num(getAtomAt(lenList || child, 1));

        const nameList = findChildList(child, 'name');
        const numList = findChildList(child, 'number');
        const name = getAtomAt(nameList || child, 1) || '';
        const pinNum = getAtomAt(numList || child, 1) || '';

        pins.push({
          name,
          number: pinNum,
          type,
          shape,
          x: at.x,
          y: at.y,
          angle: at.angle,
          length,
        });
      } else if (tag === 'rectangle') {
        const startList = findChildList(child, 'start');
        const endList = findChildList(child, 'end');
        if (startList && endList) {
          graphics.push({
            type: 'rectangle',
            pts: [
              { x: num(getAtomAt(startList, 1)), y: num(getAtomAt(startList, 2)) },
              { x: num(getAtomAt(endList, 1)), y: num(getAtomAt(endList, 2)) },
            ],
          });
        }
      } else if (tag === 'polyline') {
        const ptsList = findChildList(child, 'pts');
        if (ptsList) {
          const xyLists = findChildLists(ptsList, 'xy');
          graphics.push({
            type: 'polyline',
            pts: xyLists.map((xy) => ({ x: num(getAtomAt(xy, 1)), y: num(getAtomAt(xy, 2)) })),
          });
        }
      } else if (tag === 'circle') {
        const centerList = findChildList(child, 'center');
        const radList = findChildList(child, 'radius');
        if (centerList) {
          graphics.push({
            type: 'circle',
            pts: [],
            center: { x: num(getAtomAt(centerList, 1)), y: num(getAtomAt(centerList, 2)) },
            radius: num(getAtomAt(radList || child, 1)),
          });
        }
      }
    }
  }

  traverse(symList);
  return { id, pins, graphics, properties };
}

// Transforms a symbol's local coordinates to schematic coordinates based on position, angle, and mirror
export function transformPoint(
  localX: number,
  localY: number,
  symX: number,
  symY: number,
  angleDeg: number,
  mirror?: 'x' | 'y',
): { x: number; y: number } {
  let px = localX;
  let py = -localY; // Symbol library coordinates are Y-up; schematic coordinates are Y-down

  if (mirror === 'x') {
    px = -px;
  } else if (mirror === 'y') {
    py = -py;
  }

  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const rx = px * cos - py * sin;
  const ry = px * sin + py * cos;

  return {
    x: Math.round((symX + rx) * 1000) / 1000,
    y: Math.round((symY + ry) * 1000) / 1000,
  };
}

export function parseKicadSch(source: string): KicadSchematic {
  const ast = parseSExpr(source);
  if (getListTag(ast) !== 'kicad_sch') {
    throw new Error('Expected root tag (kicad_sch)');
  }

  const libSymbols = new Map<string, KicadLibSymbol>();
  const symbols: KicadPlacedSymbol[] = [];
  const wires: KicadWire[] = [];
  const junctions: KicadJunction[] = [];
  const labels: KicadLabel[] = [];
  const texts: KicadText[] = [];

  let version = 0;
  let generator = '';
  let schUuid = '';
  let paper = 'A4';

  for (const child of ast.children) {
    if (child.type !== 'list') continue;
    const tag = getListTag(child);

    switch (tag) {
      case 'version':
        version = parseInt(getAtomAt(child, 1) || '0', 10);
        break;
      case 'generator':
        generator = getAtomAt(child, 1) || '';
        break;
      case 'uuid':
        schUuid = getAtomAt(child, 1) || '';
        break;
      case 'paper':
        paper = getAtomAt(child, 1) || 'A4';
        break;
      case 'lib_symbols': {
        for (const symChild of child.children) {
          if (symChild.type === 'list' && getListTag(symChild) === 'symbol') {
            const libSym = parseLibSymbol(symChild);
            if (libSym.id) libSymbols.set(libSym.id, libSym);
          }
        }
        break;
      }
      case 'wire': {
        const ptsList = findChildList(child, 'pts');
        const uuidList = findChildList(child, 'uuid');
        if (ptsList) {
          const xys = findChildLists(ptsList, 'xy');
          if (xys.length >= 2) {
            wires.push({
              x1: num(getAtomAt(xys[0], 1)),
              y1: num(getAtomAt(xys[0], 2)),
              x2: num(getAtomAt(xys[1], 1)),
              y2: num(getAtomAt(xys[1], 2)),
              uuid: getAtomAt(uuidList || child, 1) || '',
            });
          }
        }
        break;
      }
      case 'junction': {
        const atList = findChildList(child, 'at');
        const uuidList = findChildList(child, 'uuid');
        const at = parseAt(atList);
        junctions.push({
          x: at.x,
          y: at.y,
          uuid: getAtomAt(uuidList || child, 1) || '',
        });
        break;
      }
      case 'label':
      case 'global_label':
      case 'hierarchical_label': {
        const name = getAtomAt(child, 1) || '';
        const atList = findChildList(child, 'at');
        const uuidList = findChildList(child, 'uuid');
        const at = parseAt(atList);
        labels.push({
          name,
          x: at.x,
          y: at.y,
          angle: at.angle,
          type: tag === 'global_label' ? 'global' : tag === 'hierarchical_label' ? 'hierarchical' : 'local',
          uuid: getAtomAt(uuidList || child, 1) || '',
        });
        break;
      }
      case 'text': {
        const textContent = getAtomAt(child, 1) || '';
        const atList = findChildList(child, 'at');
        const uuidList = findChildList(child, 'uuid');
        const at = parseAt(atList);
        texts.push({
          text: textContent,
          x: at.x,
          y: at.y,
          angle: at.angle,
          directive: textContent.trim().startsWith('.'),
          uuid: getAtomAt(uuidList || child, 1) || '',
        });
        break;
      }
      case 'symbol': {
        // Placed symbol instance
        const libIdList = findChildList(child, 'lib_id');
        const libId = getAtomAt(libIdList || child, 1) || '';
        const atList = findChildList(child, 'at');
        const at = parseAt(atList);

        const mirrorList = findChildList(child, 'mirror');
        const mirrorVal = getAtomAt(mirrorList || child, 1);
        const mirror = mirrorVal === 'x' || mirrorVal === 'y' ? mirrorVal : undefined;

        const unitList = findChildList(child, 'unit');
        const unit = parseInt(getAtomAt(unitList || child, 1) || '1', 10);
        const uuidList = findChildList(child, 'uuid');
        const uuid = getAtomAt(uuidList || child, 1) || '';

        const properties: Record<string, KicadProperty> = {};
        const propertyLists = findChildLists(child, 'property');
        for (const propList of propertyLists) {
          const key = getAtomAt(propList, 1) || '';
          const valAtom = propList.children[2] as SExprAtom | undefined;
          const val = valAtom?.value ?? '';
          const pAtList = findChildList(propList, 'at');
          const pAt = parseAt(pAtList);
          const hideList = findChildList(propList, 'hide');
          const hide = getAtomAt(hideList || propList, 1) === 'yes';

          properties[key] = {
            name: key,
            value: val,
            x: pAt.x,
            y: pAt.y,
            angle: pAt.angle,
            hide,
            valueStart: valAtom?.start ?? propList.start,
            valueEnd: valAtom?.end ?? propList.end,
            raw: valAtom?.raw ?? '',
          };
        }

        const pinLists = findChildLists(child, 'pin');
        const placedPins = pinLists.map((p) => ({
          number: getAtomAt(p, 1) || '',
          uuid: getAtomAt(findChildList(p, 'uuid') || p, 1) || '',
        }));

        const ref = properties.Reference?.value || '';
        const val = properties.Value?.value || '';
        const footprint = properties.Footprint?.value || '';

        symbols.push({
          uuid,
          libId,
          x: at.x,
          y: at.y,
          angle: at.angle,
          mirror,
          unit,
          properties,
          ref,
          value: val,
          footprint,
          pins: placedPins,
        });
        break;
      }
    }
  }

  const nets = buildNets(symbols, wires, junctions, labels, libSymbols);

  return {
    version,
    generator,
    uuid: schUuid,
    paper,
    libSymbols,
    symbols,
    wires,
    junctions,
    labels,
    texts,
    nets,
    ast,
  };
}

// Builds electrical nets by tracing connected wires, junctions, labels, and transformed pin positions
export function buildNets(
  symbols: KicadPlacedSymbol[],
  wires: KicadWire[],
  junctions: KicadJunction[],
  labels: KicadLabel[],
  libSymbols: Map<string, KicadLibSymbol>,
): KicadNet[] {
  // Disjoint Set Union (Union-Find)
  const parent = new Map<string, string>();
  function find(a: string): string {
    let root = a;
    while (parent.has(root) && parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    let curr = a;
    while (curr !== root) {
      const next = parent.get(curr) || root;
      parent.set(curr, root);
      curr = next;
    }
    return root;
  }
  function union(a: string, b: string) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootB, rootA);
    }
  }

  const coordKey = (x: number, y: number): string => `${x.toFixed(3)},${y.toFixed(3)}`;

  // 1. Register wire endpoints and connect wire ends
  for (const w of wires) {
    const k1 = coordKey(w.x1, w.y1);
    const k2 = coordKey(w.x2, w.y2);
    if (!parent.has(k1)) parent.set(k1, k1);
    if (!parent.has(k2)) parent.set(k2, k2);
    union(k1, k2);
  }

  // 2. Connect junctions and endpoints that lie on wire segments
  for (const j of junctions) {
    const jk = coordKey(j.x, j.y);
    if (!parent.has(jk)) parent.set(jk, jk);
    for (const w of wires) {
      if (pointOnSegment(j.x, j.y, w.x1, w.y1, w.x2, w.y2)) {
        union(jk, coordKey(w.x1, w.y1));
      }
    }
  }

  // 3. Labels and Power pins
  const labelNodes: Array<{ name: string; key: string }> = [];
  for (const lbl of labels) {
    const lk = coordKey(lbl.x, lbl.y);
    if (!parent.has(lk)) parent.set(lk, lk);

    for (const w of wires) {
      if (pointOnSegment(lbl.x, lbl.y, w.x1, w.y1, w.x2, w.y2)) {
        union(lk, coordKey(w.x1, w.y1));
      }
    }

    labelNodes.push({ name: lbl.name, key: lk });
  }

  // 4. Connect pin positions
  const pinNodes: Array<{ ref: string; pin: string; key: string }> = [];

  for (const sym of symbols) {
    const libSym = libSymbols.get(sym.libId);
    if (!libSym) continue;

    const isPowerSym = sym.ref.startsWith('#PWR') || sym.libId.startsWith('power:');

    for (const pinDef of libSym.pins) {
      const transformed = transformPoint(pinDef.x, pinDef.y, sym.x, sym.y, sym.angle, sym.mirror);
      const pk = coordKey(transformed.x, transformed.y);
      if (!parent.has(pk)) parent.set(pk, pk);

      // Check wire endpoints or segments touching this pin
      for (const w of wires) {
        if (pointOnSegment(transformed.x, transformed.y, w.x1, w.y1, w.x2, w.y2)) {
          union(pk, coordKey(w.x1, w.y1));
        }
      }

      if (isPowerSym && sym.value) {
        // Power symbols define global power nets named after their value
        labelNodes.push({ name: sym.value, key: pk });
      }

      pinNodes.push({ ref: sym.ref, pin: pinDef.number, key: pk });
    }
  }

  // 5. Connect all labels with the same name across the schematic
  const labelsByName = new Map<string, string[]>();
  for (const { name, key } of labelNodes) {
    const existing = labelsByName.get(name) || [];
    existing.push(key);
    labelsByName.set(name, existing);
  }
  for (const [_, keys] of labelsByName) {
    for (let i = 1; i < keys.length; i++) {
      union(keys[0], keys[i]);
    }
  }

  // 6. Group pins into nets
  const netGroups = new Map<string, { name: string; pins: KicadPinRef[] }>();

  // Determine root net names
  const rootNames = new Map<string, string>();
  for (const [name, keys] of labelsByName) {
    if (keys.length > 0) {
      const root = find(keys[0]);
      rootNames.set(root, name);
    }
  }

  for (const p of pinNodes) {
    const root = find(p.key);
    let net = netGroups.get(root);
    if (!net) {
      const explicitName = rootNames.get(root);
      const name = explicitName || `Net-(${p.ref}-${p.pin})`;
      net = { name, pins: [] };
      netGroups.set(root, net);
    }
    net.pins.push({ ref: p.ref, pin: p.pin });
  }

  return Array.from(netGroups.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function pointOnSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number, tol = 0.08): boolean {
  // Check bounding box
  const minX = Math.min(x1, x2) - tol;
  const maxX = Math.max(x1, x2) + tol;
  const minY = Math.min(y1, y2) - tol;
  const maxY = Math.max(y1, y2) + tol;
  if (px < minX || px > maxX || py < minY || py > maxY) return false;

  // Cross product distance
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return Math.hypot(px - x1, py - y1) <= tol;
  }
  const dist = Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / Math.sqrt(lenSq);
  return dist <= tol;
}

// Returns a single text-range edit replacing only that property's quoted value string
export function propertyEdit(
  sch: KicadSchematic,
  ref: string,
  key: string,
  value: string,
  source?: string,
): PropertyEdit | undefined {
  const sym = sch.symbols.find((s) => s.ref === ref);
  if (!sym) return undefined;
  const prop = sym.properties[key];
  if (!prop) return undefined;

  let line = 0;
  if (source) {
    const upToStart = source.slice(0, prop.valueStart);
    line = upToStart.split(/\r?\n/).length - 1;
  }

  return {
    start: prop.valueStart,
    end: prop.valueEnd,
    text: quoteString(value),
    oldText: prop.raw,
    line,
  };
}

// Computes diff between two parsed KiCad schematics to drive live highlighting
export function diffSchematics(prev: KicadSchematic | undefined, next: KicadSchematic): SchematicChanges {
  const changes: SchematicChanges = { symbols: [], removedSymbols: [], wires: [], texts: [] };
  if (!prev) return changes;

  const symSignature = (s: KicadPlacedSymbol): string =>
    `${s.libId}|${s.x}|${s.y}|${s.angle}|${s.mirror}|${s.value}|${s.footprint}`;

  const prevSymbols = new Map(prev.symbols.map((s) => [s.ref, symSignature(s)]));
  for (const s of next.symbols) {
    if (prevSymbols.get(s.ref) !== symSignature(s)) {
      changes.symbols.push(s.ref);
    }
  }

  const nextRefs = new Set(next.symbols.map((s) => s.ref));
  changes.removedSymbols = prev.symbols.map((s) => s.ref).filter((ref) => !nextRefs.has(ref));

  const wireSig = (w: KicadWire): string => {
    const a = `${w.x1},${w.y1}`;
    const b = `${w.x2},${w.y2}`;
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  };

  const prevWires = new Set(prev.wires.map(wireSig));
  next.wires.forEach((w, i) => {
    if (!prevWires.has(wireSig(w))) changes.wires.push(i);
  });

  const prevTexts = new Set(prev.texts.map((t) => `${t.directive}|${t.text}`));
  next.texts.forEach((t, i) => {
    if (!prevTexts.has(`${t.directive}|${t.text}`)) changes.texts.push(i);
  });

  return changes;
}
