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
export function parseSystemXml(xmlText: string, systemName = 'root'): SlxSystem {
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
    });
  }

  // Match Line elements: <Line> ... </Line>
  const lineRegex = /<Line>([\s\S]*?)<\/Line>/gi;
  let lineMatch: RegExpExecArray | null;

  while ((lineMatch = lineRegex.exec(xmlText)) !== null) {
    const lineBody = lineMatch[1];
    const srcEndpoint = parseEndpoint(lineBody, 'Src');

    // Extract direct Dst outside of any <Branch> tags
    const directBody = lineBody.replace(/<Branch>[\s\S]*?<\/Branch>/gi, '');
    const directDst = parseEndpoint(directBody, 'Dst');

    if (srcEndpoint && directDst) {
      lines.push({
        src: srcEndpoint,
        dst: directDst,
        name: parseLineName(directBody),
        logged: /<P\s+Name="DataLogging">on<\/P>/i.test(directBody),
      });
    }

    // Check for branches: <Branch> ... </Branch>
    const branchRegex = /<Branch>([\s\S]*?)<\/Branch>/gi;
    let branchMatch: RegExpExecArray | null;
    while ((branchMatch = branchRegex.exec(lineBody)) !== null) {
      const branchBody = branchMatch[1];
      const branchDst = parseEndpoint(branchBody, 'Dst');
      if (srcEndpoint && branchDst) {
        lines.push({
          src: srcEndpoint,
          dst: branchDst,
          name: parseLineName(branchBody) || parseLineName(lineBody),
          logged: /<P\s+Name="DataLogging">on<\/P>/i.test(branchBody) || /<P\s+Name="DataLogging">on<\/P>/i.test(lineBody),
        });
      }
    }
  }

  return {
    name: systemName,
    blocks,
    lines,
  };
}

function parseEndpoint(xmlPart: string, tag: 'Src' | 'Dst'): SlxLineEndpoint | undefined {
  // Matches: <P Name="Src">1#out:1</P> or <P Name="Dst">2#in:1</P> or <P Name="Src">1#rconn:1</P>
  const regex = new RegExp(`<P\\s+Name="${tag}">([0-9a-zA-Z_-]+)#([a-zA-Z]+):(\\d+)<\\/P>`, 'i');
  const match = xmlPart.match(regex);
  if (match) {
    return {
      sid: match[1],
      portType: match[2],
      portNumber: parseInt(match[3], 10),
    };
  }
  return undefined;
}

function parseLineName(xmlPart: string): string | undefined {
  const match = xmlPart.match(/<P\s+Name="Name">([^<]+)<\/P>/i);
  return match ? decodeXml(match[1]) : undefined;
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

  // Root system is in simulink/systems/system_root.xml or simulink/blockdiagram.xml
  let rootSystem: SlxSystem = { name: 'root', blocks: [], lines: [] };
  const rootXml = entries['simulink/systems/system_root.xml']?.toString('utf8');
  if (rootXml) {
    rootSystem = parseSystemXml(rootXml, 'root');
  } else if (bdXml) {
    rootSystem = parseSystemXml(bdXml, 'root');
  }

  // Subsystems in simulink/systems/system_*.xml
  const subsystems: Record<string, SlxSystem> = {};
  for (const [key, val] of Object.entries(entries)) {
    if (key.startsWith('simulink/systems/system_') && key !== 'simulink/systems/system_root.xml') {
      const subName = key.replace(/^simulink\/systems\/system_|\.xml$/gi, '');
      subsystems[subName] = parseSystemXml(val.toString('utf8'), subName);
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
