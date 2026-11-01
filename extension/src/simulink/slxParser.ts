// Simulink .slx zip archive and XML block diagram parser.
// Pure Node module (zlib, buffer), zero vscode imports, testable with node --test.

import * as zlib from 'zlib';

export interface SlxBlock {
  sid: string;
  name: string;
  type: string;
  position: { left: number; top: number; right: number; bottom: number };
  parameters: Record<string, string>;
  subsystemFile?: string;
  rotation?: number;
  mirror?: boolean;
  ports?: SlxPortCounts;
  sourceBlock?: string;
  binding?: SlxBinding;
  gauge?: { min: number; max: number };
}

/** What a dashboard block (gauge, slider, knob) is connected to in the model. */
export interface SlxBinding {
  source: string;
  sid: string;
  signal: string;
}

export interface SlxPortCounts {
  in: number;
  out: number;
  lconn: number;
  rconn: number;
}

export interface SlxAnnotation {
  sid: string;
  text: string;
  position: { left: number; top: number; right: number; bottom: number };
  fontSize?: number;
  bold?: boolean;
}

export interface SlxLineEndpoint {
  sid: string;
  portType: string;
  portNumber: number;
}

export interface SlxLine {
  src?: SlxLineEndpoint;
  dst?: SlxLineEndpoint;
  points?: Array<{ x: number; y: number }>;
  name?: string;
  logged?: boolean;
}

export interface SlxSystem {
  name: string;
  blocks: SlxBlock[];
  lines: SlxLine[];
  annotations?: SlxAnnotation[];
}

export interface SlxModel {
  name: string;
  uuid?: string;
  rootSystem: SlxSystem;
  subsystems: Record<string, SlxSystem>;
}

export interface SlxDiffResult {
  addedBlockSids: string[];
  removedBlockSids: string[];
  changedBlockSids: string[];
  addedLinesCount: number;
  hasLineChanges: boolean;
}

/**
 * Pure Node.js ZIP extractor without external npm packages.
 */
export function readZipEntries(buf: Buffer): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  if (!buf || buf.length < 22) return files;

  // Locate End of Central Directory Record (EOCD signature: 0x06054b50)
  let eocdOffset = -1;
  const maxSearch = Math.min(buf.length, 65536 + 22);
  for (let i = buf.length - 22; i >= buf.length - maxSearch; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) return files;

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  let offset = cdOffset;
  for (let e = 0; e < totalEntries; e++) {
    if (offset + 46 > buf.length) break;
    const magic = buf.readUInt32LE(offset);
    if (magic !== 0x02014b50) break;

    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const fnLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);

    const filename = buf.toString('utf8', offset + 46, offset + 46 + fnLen);
    offset += 46 + fnLen + extraLen + commentLen;

    // Read local header
    if (localHeaderOffset + 30 > buf.length) continue;
    const localMagic = buf.readUInt32LE(localHeaderOffset);
    if (localMagic !== 0x04034b50) continue;

    const localFnLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFnLen + localExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);

    try {
      if (method === 0) {
        files[filename] = compressed;
      } else if (method === 8) {
        files[filename] = zlib.inflateRawSync(compressed);
      }
    } catch {
      // skip corrupted or unsupported entries
    }
  }

  return files;
}

/**
 * Parses XML string into System (blocks, lines, parameters).
 */
export function parseSystemXml(
  xmlText: string,
  systemName = 'root',
  portHints: Record<string, SlxPortCounts> = {},
): SlxSystem {
  const blocks: SlxBlock[] = [];
  const lines: SlxLine[] = [];

  // Match Block elements
  // <Block BlockType="Step" Name="Step" SID="1"> ... </Block>
  const blockRegex = /<Block\s+([^>]*?)>([\s\S]*?)<\/Block>/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(xmlText)) !== null) {
    const attrsStr = blockMatch[1];
    const bodyStr = blockMatch[2];

    const typeMatch = attrsStr.match(/BlockType="([^"]+)"/i);
    const nameMatch = attrsStr.match(/Name="([^"]+)"/i);
    const sidMatch = attrsStr.match(/SID="([^"]+)"/i);

    const type = typeMatch ? typeMatch[1] : 'Unknown';
    const name = nameMatch ? decodeXml(nameMatch[1]) : type;
    const sid = sidMatch ? sidMatch[1] : name;

    // Extract Position: <P Name="Position">[50, 100, 80, 130]</P>
    let position = { left: 50, top: 50, right: 100, bottom: 80 };
    const posMatch = bodyStr.match(/<P\s+Name="Position">\[\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\]<\/P>/i);
    if (posMatch) {
      position = {
        left: parseInt(posMatch[1], 10),
        top: parseInt(posMatch[2], 10),
        right: parseInt(posMatch[3], 10),
        bottom: parseInt(posMatch[4], 10),
      };
    }

    // Extract Parameters: <P Name="Key">Value</P>
    const parameters: Record<string, string> = {};
    const paramRegex = /<P\s+Name="([^"]+)">([\s\S]*?)<\/P>/gi;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = paramRegex.exec(bodyStr)) !== null) {
      const pKey = pMatch[1];
      const pVal = decodeXml(pMatch[2].trim());
      if (pKey !== 'Position' && pKey !== 'ZOrder') {
        parameters[pKey] = pVal;
      }
    }

    blocks.push({
      sid,
      name,
      type,
      position,
      parameters,
      rotation: parseInt(parameters.BlockRotation ?? '0', 10) || 0,
      mirror: parameters.BlockMirror === 'on',
      ports: parsePortCountsTag(bodyStr) ?? parsePortCounts(parameters.Ports) ?? (portHints[sid] ? { ...portHints[sid] } : undefined),
      sourceBlock: parameters.SourceBlock,
    });
  }

  // Lines are trees: a <Branch> can hold further <Branch>es, so walk the tags with a stack
  // instead of regex-matching branch bodies (a lazy match stops at the first inner </Branch>).
  const rawLines: RawLine[] = [];
  const lineRegex = /<Line>([\s\S]*?)<\/Line>/gi;
  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = lineRegex.exec(xmlText)) !== null) {
    rawLines.push(parseLineTree(lineMatch[1]));
  }

  // Blocks often omit Ports; take the highest port number any line uses instead.
  const blockBySid = new Map(blocks.map((b) => [b.sid, b]));
  const seen = (ep?: SlxLineEndpoint) => {
    const b = ep && blockBySid.get(ep.sid);
    if (!b || !ep) return;
    const counts = (b.ports ??= { in: 0, out: 0, lconn: 0, rconn: 0 });
    const kind = ep.portType.toLowerCase() as keyof SlxPortCounts;
    if (kind in counts) counts[kind] = Math.max(counts[kind], ep.portNumber);
  };
  for (const raw of rawLines) {
    seen(raw.src);
    for (const leaf of raw.leaves) seen(leaf.dst);
  }

  for (const raw of rawLines) {
    const srcBlock = raw.src && blockBySid.get(raw.src.sid);
    const start = srcBlock && raw.src ? portPosition(srcBlock, raw.src.portType, raw.src.portNumber) : undefined;
    for (const leaf of raw.leaves) {
      const line: SlxLine = { src: raw.src, dst: leaf.dst, name: leaf.name ?? raw.name, logged: raw.logged || leaf.logged };
      if (start) {
        const pts = [start];
        let { x, y } = start;
        for (const [dx, dy] of leaf.offsets) {
          x += dx;
          y += dy;
          pts.push({ x, y });
        }
        const dstBlock = leaf.dst && blockBySid.get(leaf.dst.sid);
        if (dstBlock && leaf.dst) pts.push(portPosition(dstBlock, leaf.dst.portType, leaf.dst.portNumber));
        line.points = pts;
      }
      if (line.src || line.dst) lines.push(line);
    }
  }

  const annotations: SlxAnnotation[] = [];
  const annRegex = /<Annotation\s+([^>]*?)>([\s\S]*?)<\/Annotation>/gi;
  let annMatch: RegExpExecArray | null;
  while ((annMatch = annRegex.exec(xmlText)) !== null) {
    const body = annMatch[2];
    const text = body.match(/<P\s+Name="Name">([\s\S]*?)<\/P>/i)?.[1];
    const pos = body.match(/<P\s+Name="Position">\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]<\/P>/i);
    if (!text || !pos) continue;
    annotations.push({
      sid: annMatch[1].match(/SID="([^"]+)"/i)?.[1] ?? '',
      text: decodeXml(text.trim()),
      position: { left: +pos[1], top: +pos[2], right: +pos[3], bottom: +pos[4] },
      fontSize: parseFloat(body.match(/<P\s+Name="FontSize">([\d.]+)<\/P>/i)?.[1] ?? '') || undefined,
      bold: /<P\s+Name="FontWeight">bold<\/P>/i.test(body),
    });
  }

  return {
    name: systemName,
    blocks,
    lines,
    annotations,
  };
}

interface RawLine {
  src?: SlxLineEndpoint;
  name?: string;
  logged: boolean;
  leaves: Array<{ dst?: SlxLineEndpoint; offsets: Array<[number, number]>; name?: string; logged: boolean }>;
}

// Simulink stores each segment's Points as offsets from the previous point, starting at the
// source port; a branch starts where its parent's points end.
function parseLineTree(body: string): RawLine {
  const raw: RawLine = { logged: false, leaves: [] };
  type Frame = { offsets: Array<[number, number]>; dst?: SlxLineEndpoint; name?: string; logged: boolean; hasChild: boolean };
  const stack: Frame[] = [{ offsets: [], logged: false, hasChild: false }];
  const tokenRegex = /<Branch>|<\/Branch>|<P\s+Name="([^"]+)">([\s\S]*?)<\/P>/gi;
  const finish = (f: Frame) => {
    if (f.dst || !f.hasChild) raw.leaves.push({ dst: f.dst, offsets: f.offsets, name: f.name, logged: f.logged });
  };
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(body)) !== null) {
    const top = stack[stack.length - 1];
    if (m[0] === '<Branch>') {
      top.hasChild = true;
      stack.push({ offsets: [...top.offsets], logged: false, hasChild: false });
    } else if (m[0] === '</Branch>') {
      if (stack.length > 1) finish(stack.pop()!);
    } else {
      const key = m[1];
      const value = m[2].trim();
      if (key === 'Points') top.offsets.push(...parsePoints(value));
      else if (key === 'Src' && stack.length === 1) raw.src = parseEndpointValue(value);
      else if (key === 'Dst') top.dst = parseEndpointValue(value);
      else if (key === 'Name') top.name = decodeXml(value);
      else if (key === 'DataLogging' && value === 'on') top.logged = true;
    }
  }
  const root = stack[0];
  raw.name = root.name;
  raw.logged = root.logged;
  if (root.dst) raw.leaves.push({ dst: root.dst, offsets: root.offsets, name: root.name, logged: root.logged });
  return raw;
}

function parsePoints(value: string): Array<[number, number]> {
  return value
    .replace(/[[\]]/g, '')
    .split(';')
    .map((pair) => pair.split(',').map((n) => parseFloat(n)))
    .filter((p): p is [number, number] => p.length === 2 && p.every((n) => Number.isFinite(n)));
}

function parseEndpointValue(value: string): SlxLineEndpoint | undefined {
  const match = value.match(/^([0-9a-zA-Z_-]+)#([a-zA-Z]+):(\d+)$/);
  return match ? { sid: match[1], portType: match[2], portNumber: parseInt(match[3], 10) } : undefined;
}

// Newer releases write <PortCounts in="2" out="3" lconn="1"/> on the block.
function parsePortCountsTag(body: string): SlxPortCounts | undefined {
  const tag = body.match(/<PortCounts\s+([^>]*?)\/?>/i)?.[1];
  if (!tag) return undefined;
  const get = (k: string) => parseInt(tag.match(new RegExp(`\\b${k}="(\\d+)"`, 'i'))?.[1] ?? '0', 10);
  return { in: get('in'), out: get('out'), lconn: get('lconn'), rconn: get('rconn') };
}

// Ports is "[in, out, enable, trigger, state, lconn, rconn, ...]"; missing entries are 0.
function parsePortCounts(value?: string): SlxPortCounts | undefined {
  if (!value) return undefined;
  const n = value.replace(/[[\]]/g, '').split(',').map((s) => parseInt(s, 10) || 0);
  return { in: n[0] ?? 0, out: n[1] ?? 0, lconn: n[5] ?? 0, rconn: n[6] ?? 0 };
}

/**
 * Where a port sits on the canvas. Ports are spaced evenly along their side, as Simulink draws them.
 * Inputs and left connections sit on the left before rotation; rotation is clockwise in degrees.
 */
export function portPosition(block: SlxBlock, portType: string, portNumber: number): { x: number; y: number } {
  const { left, top, right, bottom } = block.position;
  const kind = portType.toLowerCase();
  const counts = block.ports ?? { in: 1, out: 1, lconn: 1, rconn: 1 };
  const total = Math.max(portNumber, (counts as any)[kind] ?? 1, 1);
  const frac = (2 * portNumber - 1) / (2 * total);
  let onStart = kind === 'in' || kind === 'lconn';
  if (block.mirror) onStart = !onStart;
  switch (((block.rotation ?? 0) % 360 + 360) % 360) {
    case 90:
      return { x: right - frac * (right - left), y: onStart ? top : bottom };
    case 180:
      return { x: onStart ? right : left, y: bottom - frac * (bottom - top) };
    case 270:
      return { x: left + frac * (right - left), y: onStart ? bottom : top };
    default:
      return { x: onStart ? left : right, y: top + frac * (bottom - top) };
  }
}

/**
 * Reads a BindingPersistence object without a MAT-file decoder. Its printable strings hold
 * the bound block's name, then its SID (the only all-digit string), then the signal or label.
 */
export function parseBinding(buf: Buffer): SlxBinding | undefined {
  const strings = buf.toString('latin1').match(/[ -~]{2,}/g) ?? [];
  const i = strings.findIndex((t) => /^\d+$/.test(t));
  if (i < 1 || i + 1 >= strings.length) return undefined;
  return { source: strings[i - 1], sid: strings[i], signal: strings[i + 1] };
}

/** Scale limits from a dashboard block's Configuration JSON. */
export function parseGaugeBounds(config: string | undefined): { min: number; max: number } | undefined {
  const bounds = config?.match(/"bounds"\s*:\s*\{([^}]*)\}/);
  if (!bounds) return undefined;
  const num = (k: string) => Number(bounds[1].match(new RegExp(`"${k}"\\s*:\\s*(-?[\\d.eE+-]+)`))?.[1]);
  const min = num('min');
  const max = num('max');
  return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : undefined;
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Parses a .slx archive Buffer into a complete SlxModel.
 */
export function parseSlx(buf: Buffer, modelName = 'model'): SlxModel {
  const entries = readZipEntries(buf);

  // Check for model UUID in simulink/blockdiagram.xml
  let uuid: string | undefined;
  const bdXml = entries['simulink/blockdiagram.xml']?.toString('utf8');
  if (bdXml) {
    const uuidMatch = bdXml.match(/<P\s+Name="ModelUUID">([^<]+)<\/P>/i);
    if (uuidMatch) {
      uuid = uuidMatch[1];
    }
  }

  const subXml: Record<string, string> = {};
  for (const [key, val] of Object.entries(entries)) {
    if (key.startsWith('simulink/systems/system_') && key !== 'simulink/systems/system_root.xml') {
      subXml[key.replace(/^simulink\/systems\/system_|\.xml$/gi, '')] = val.toString('utf8');
    }
  }

  // A SubSystem block rarely stores Ports, so count the Inport/Outport (and Simscape
  // connection port) blocks inside its system file, which is named after the block's SID.
  const portHints: Record<string, SlxPortCounts> = {};
  for (const [sid, xml] of Object.entries(subXml)) {
    const count = (type: string) => (xml.match(new RegExp(`<Block\\s+[^>]*BlockType="${type}"`, 'gi')) ?? []).length;
    const pmc = xml.match(/<Block\s+[^>]*BlockType="PMIOPort"[\s\S]*?<\/Block>/gi) ?? [];
    const rconn = pmc.filter((b) => /<P\s+Name="Side">Right<\/P>/i.test(b)).length;
    portHints[sid] = { in: count('Inport'), out: count('Outport'), lconn: pmc.length - rconn, rconn };
  }

  // Root system is in simulink/systems/system_root.xml or simulink/blockdiagram.xml
  let rootSystem: SlxSystem = { name: 'root', blocks: [], lines: [] };
  const rootXml = entries['simulink/systems/system_root.xml']?.toString('utf8');
  if (rootXml) {
    rootSystem = parseSystemXml(rootXml, 'root', portHints);
  } else if (bdXml) {
    rootSystem = parseSystemXml(bdXml, 'root', portHints);
  }

  const subsystems: Record<string, SlxSystem> = {};
  for (const [subName, xml] of Object.entries(subXml)) {
    subsystems[subName] = parseSystemXml(xml, subName, portHints);
  }

  // Dashboard blocks keep their signal or variable binding in a MATLAB object file named after the block SID.
  for (const system of [rootSystem, ...Object.values(subsystems)]) {
    for (const block of system.blocks) {
      const mx = entries[`simulink/bdmxdata/BindingPersistence_${block.sid}.mxarray`];
      const binding = mx ? parseBinding(mx) : undefined;
      if (binding) block.binding = binding;
      const gauge = parseGaugeBounds(block.parameters.Configuration);
      if (gauge) block.gauge = gauge;
    }
  }

  return {
    name: modelName,
    uuid,
    rootSystem,
    subsystems,
  };
}

/**
 * Computes difference between two SlxModels to highlight changed blocks and lines.
 */
export function diffSlxModels(prev: SlxModel, curr: SlxModel): SlxDiffResult {
  const prevBlocks = new Map(prev.rootSystem.blocks.map(b => [b.sid, b]));
  const currBlocks = new Map(curr.rootSystem.blocks.map(b => [b.sid, b]));

  const addedBlockSids: string[] = [];
  const removedBlockSids: string[] = [];
  const changedBlockSids: string[] = [];

  for (const [sid, currB] of currBlocks) {
    const prevB = prevBlocks.get(sid);
    if (!prevB) {
      addedBlockSids.push(sid);
    } else {
      // Check parameters or position or name
      const paramsChanged = JSON.stringify(prevB.parameters) !== JSON.stringify(currB.parameters);
      const posChanged = JSON.stringify(prevB.position) !== JSON.stringify(currB.position);
      const nameChanged = prevB.name !== currB.name;
      if (paramsChanged || posChanged || nameChanged) {
        changedBlockSids.push(sid);
      }
    }
  }

  for (const sid of prevBlocks.keys()) {
    if (!currBlocks.has(sid)) {
      removedBlockSids.push(sid);
    }
  }

  const prevLinesCount = prev.rootSystem.lines.length;
  const currLinesCount = curr.rootSystem.lines.length;
  const addedLinesCount = Math.max(0, currLinesCount - prevLinesCount);
  const hasLineChanges = prevLinesCount !== currLinesCount ||
    JSON.stringify(prev.rootSystem.lines) !== JSON.stringify(curr.rootSystem.lines);

  return {
    addedBlockSids,
    removedBlockSids,
    changedBlockSids,
    addedLinesCount,
    hasLineChanges,
  };
}
