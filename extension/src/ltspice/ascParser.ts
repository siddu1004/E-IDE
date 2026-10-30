// Parser and helpers for LTspice .asc schematic files.
// Kept free of the vscode API so it can run in plain Node tests.

export interface AscAttr {
  value: string;
  line: number;
}

export interface AscSymbol {
  id: string;
  type: string;
  x: number;
  y: number;
  rotation: string;
  line: number;
  endLine: number;
  attrs: Record<string, AscAttr>;
}

export interface AscWire {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  line: number;
}

export interface AscFlag {
  x: number;
  y: number;
  name: string;
  line: number;
}

export interface AscText {
  x: number;
  y: number;
  text: string;
  directive: boolean;
  line: number;
}

export interface AscSchematic {
  version: string;
  sheet: { width: number; height: number };
  wires: AscWire[];
  flags: AscFlag[];
  symbols: AscSymbol[];
  texts: AscText[];
}

export interface SchematicChanges {
  symbols: string[];
  removedSymbols: string[];
  wires: number[];
  texts: number[];
}

export interface LineEdit {
  line: number;
  insert: boolean;
  text: string;
}

const num = (s: string | undefined): number => Number(s ?? 0);

// Text after the first n whitespace-separated tokens, internal spacing kept.
function remainder(raw: string, n: number): string {
  return raw.replace(new RegExp(`^\\s*(?:\\S+\\s+){${n}}`), '').trim();
}

export function parseAsc(source: string): AscSchematic {
  const result: AscSchematic = {
    version: '',
    sheet: { width: 0, height: 0 },
    wires: [],
    flags: [],
    symbols: [],
    texts: [],
  };
  let current: AscSymbol | undefined;

  source.split(/\r?\n/).forEach((raw, line) => {
    const tokens = raw.trim().split(/\s+/);
    const [kw, ...rest] = tokens;
    switch (kw) {
      case 'SYMBOL':
        if (rest.length < 3) {
          throw new Error('Truncated SYMBOL definition at line ' + (line + 1));
        }
        current = {
          id: '',
          type: rest[0] ?? '',
          x: num(rest[1]),
          y: num(rest[2]),
          rotation: rest[3] ?? 'R0',
          line,
          endLine: line,
          attrs: {},
        };
        result.symbols.push(current);
        return;
      case 'SYMATTR':
        if (!current) {
          throw new Error('Unexpected SYMATTR without active SYMBOL at line ' + (line + 1));
        }
        if (rest.length < 2) {
          throw new Error('Truncated SYMATTR definition at line ' + (line + 1));
        }
        current.attrs[rest[0]] = { value: remainder(raw, 2), line };
        current.endLine = line;
        return;
      case 'WINDOW':
        if (current) current.endLine = line;
        return;
    }
    current = undefined;
    switch (kw) {
      case 'Version':
        result.version = rest[0] ?? '';
        break;
      case 'SHEET':
        result.sheet = { width: num(rest[1]), height: num(rest[2]) };
        break;
      case 'WIRE':
        result.wires.push({ x1: num(rest[0]), y1: num(rest[1]), x2: num(rest[2]), y2: num(rest[3]), line });
        break;
      case 'FLAG':
        result.flags.push({ x: num(rest[0]), y: num(rest[1]), name: remainder(raw, 3), line });
        break;
      case 'TEXT': {
        const body = remainder(raw, 5);
        result.texts.push({
          x: num(rest[0]),
          y: num(rest[1]),
          text: body.replace(/^[!;]/, ''),
          directive: body.startsWith('!'),
          line,
        });
        break;
      }
    }
  });

  for (const s of result.symbols) {
    if (!s.attrs.InstName || !s.attrs.InstName.value) {
      throw new Error('Truncated schematic: symbol definition missing InstName attribute');
    }
    s.id = s.attrs.InstName.value;
  }
  return result;
}

const symbolSignature = (s: AscSymbol): string =>
  JSON.stringify([s.type, s.x, s.y, s.rotation, Object.entries(s.attrs).map(([k, a]) => [k, a.value]).sort()]);

const wireKey = (w: AscWire): string => {
  const a = `${w.x1},${w.y1}`;
  const b = `${w.x2},${w.y2}`;
  return a < b ? `${a}-${b}` : `${b}-${a}`;
};

// What changed between two parses, so the editor can highlight agent edits.
export function diffSchematics(prev: AscSchematic | undefined, next: AscSchematic): SchematicChanges {
  const changes: SchematicChanges = { symbols: [], removedSymbols: [], wires: [], texts: [] };
  if (!prev) return changes;

  const prevSymbols = new Map(prev.symbols.map((s) => [s.id, symbolSignature(s)]));
  for (const s of next.symbols) {
    if (prevSymbols.get(s.id) !== symbolSignature(s)) changes.symbols.push(s.id);
  }
  const nextIds = new Set(next.symbols.map((s) => s.id));
  changes.removedSymbols = prev.symbols.map((s) => s.id).filter((id) => !nextIds.has(id));

  const prevWires = new Set(prev.wires.map(wireKey));
  next.wires.forEach((w, i) => {
    if (!prevWires.has(wireKey(w))) changes.wires.push(i);
  });

  const prevTexts = new Set(prev.texts.map((t) => `${t.directive}|${t.text}`));
  next.texts.forEach((t, i) => {
    if (!prevTexts.has(`${t.directive}|${t.text}`)) changes.texts.push(i);
  });
  return changes;
}

// Line edit that sets a symbol attribute, replacing the line or adding one after the symbol.
export function symbolAttrEdit(
  schematic: AscSchematic,
  id: string,
  key: string,
  value: string,
): LineEdit | undefined {
  const symbol = schematic.symbols.find((s) => s.id === id);
  if (!symbol || !/^\w+$/.test(key)) return undefined;
  const text = `SYMATTR ${key} ${value.replace(/[\r\n]+/g, ' ').trim()}`;
  const existing = symbol.attrs[key];
  return existing
    ? { line: existing.line, insert: false, text }
    : { line: symbol.endLine + 1, insert: true, text };
}

export function applyLineEdit(source: string, edit: LineEdit): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  if (edit.insert) lines.splice(edit.line, 0, edit.text);
  else lines[edit.line] = edit.text;
  return lines.join(eol);
}
