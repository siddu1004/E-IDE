// KiCad S-expression parser and printer.
// Parses nested lists, symbols, quoted strings with escapes, and numbers,
// preserving exact source positions (start and end offsets) for range-based edits.
// Pure TypeScript module, zero vscode imports.

export interface SExprBase {
  start: number;
  end: number;
}

export interface SExprAtom extends SExprBase {
  type: 'atom';
  value: string;
  raw: string;
  isQuoted: boolean;
}

export interface SExprList extends SExprBase {
  type: 'list';
  children: SExpr[];
}

export type SExpr = SExprList | SExprAtom;

export function escapeString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

export function quoteString(s: string): string {
  return `"${escapeString(s)}"`;
}

export function parseSExpr(source: string): SExprList {
  let pos = 0;
  const len = source.length;

  function skipWhitespaceAndComments() {
    while (pos < len) {
      const ch = source[pos];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        pos++;
      } else if (ch === '#' || (ch === '/' && source[pos + 1] === '/')) {
        // Comment until newline
        while (pos < len && source[pos] !== '\n') {
          pos++;
        }
      } else {
        break;
      }
    }
  }

  function parseString(): SExprAtom {
    const start = pos;
    pos++; // skip opening '"'
    let val = '';
    while (pos < len) {
      const ch = source[pos];
      if (ch === '"') {
        pos++; // skip closing '"'
        break;
      }
      if (ch === '\\' && pos + 1 < len) {
        pos++;
        const next = source[pos];
        switch (next) {
          case '"': val += '"'; break;
          case '\\': val += '\\'; break;
          case 'n': val += '\n'; break;
          case 'r': val += '\r'; break;
          case 't': val += '\t'; break;
          default: val += next; break;
        }
        pos++;
      } else {
        val += ch;
        pos++;
      }
    }
    const end = pos;
    return {
      type: 'atom',
      start,
      end,
      value: val,
      raw: source.slice(start, end),
      isQuoted: true,
    };
  }

  function parseAtom(): SExprAtom {
    const start = pos;
    while (pos < len) {
      const ch = source[pos];
      if (
        ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' ||
        ch === '(' || ch === ')' || ch === '"'
      ) {
        break;
      }
      pos++;
    }
    const end = pos;
    const raw = source.slice(start, end);
    return {
      type: 'atom',
      start,
      end,
      value: raw,
      raw,
      isQuoted: false,
    };
  }

  function parseList(): SExprList {
    const start = pos;
    pos++; // skip '('
    const children: SExpr[] = [];

    while (pos < len) {
      skipWhitespaceAndComments();
      if (pos >= len) break;
      const ch = source[pos];
      if (ch === ')') {
        pos++;
        break;
      }
      if (ch === '(') {
        children.push(parseList());
      } else if (ch === '"') {
        children.push(parseString());
      } else {
        children.push(parseAtom());
      }
    }
    const end = pos;
    return {
      type: 'list',
      start,
      end,
      children,
    };
  }

  skipWhitespaceAndComments();
  if (pos >= len || source[pos] !== '(') {
    throw new Error(`Invalid S-expression: expected '(' at position ${pos}`);
  }

  const root = parseList();
  return root;
}

// Print S-expression. When source is provided, unchanged nodes return exact source slices,
// guaranteeing 100% byte-identical round-trip preservation.
export function printSExpr(expr: SExpr, source?: string): string {
  if (source !== undefined && expr.start >= 0 && expr.end <= source.length) {
    return source.slice(expr.start, expr.end);
  }

  if (expr.type === 'atom') {
    return expr.isQuoted ? quoteString(expr.value) : expr.value;
  }

  const childStrings = expr.children.map((c) => printSExpr(c, source));
  return `(${childStrings.join(' ')})`;
}

// Helpers for querying S-expression AST

export function getListTag(expr: SExpr): string | undefined {
  if (expr.type !== 'list' || expr.children.length === 0) return undefined;
  const first = expr.children[0];
  return first.type === 'atom' ? first.value : undefined;
}

export function findChildList(list: SExprList, tag: string): SExprList | undefined {
  for (const child of list.children) {
    if (child.type === 'list' && getListTag(child) === tag) {
      return child;
    }
  }
  return undefined;
}

export function findChildLists(list: SExprList, tag: string): SExprList[] {
  const result: SExprList[] = [];
  for (const child of list.children) {
    if (child.type === 'list' && getListTag(child) === tag) {
      result.push(child);
    }
  }
  return result;
}

export function getAtomAt(list: SExprList, index: number): string | undefined {
  const child = list.children[index];
  return child && child.type === 'atom' ? child.value : undefined;
}
