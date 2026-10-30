// Parser for LTspice .raw waveform files.
// Handles UTF-16LE and ASCII/UTF-8 headers, binary transient (float64 time + float32 values),
// binary AC (complex float64 for all variables), and ASCII text formats.
// Kept free of vscode imports for plain Node tests.

export interface RawVariable {
  name: string;
  type: string;
}

export interface ComplexSeries {
  re: Float64Array;
  im: Float64Array;
}

export interface RawPlot {
  plotName: string;
  flags: string[];
  variables: RawVariable[];
  x: Float64Array;
  series: Record<string, Float64Array | ComplexSeries>;
}

export function parseRaw(input: Buffer | Uint8Array | string): RawPlot {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.isBuffer(input) ? input : Buffer.from(input);

  // 1. Detect encoding (UTF-16LE vs ASCII/UTF-8)
  const isUtf16 = (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) ||
    (buf.length >= 4 && buf[1] === 0x00 && buf[3] === 0x00);

  // 2. Locate separator for data section (either "Binary:\n" or "Values:\n")
  let isBinary = false;
  let isAsciiData = false;
  let headerText = '';
  let dataByteOffset = 0;

  if (isUtf16) {
    const fullText = buf.toString('utf16le');
    const binIdx = fullText.indexOf('Binary:');
    const valIdx = fullText.indexOf('Values:');

    if (binIdx !== -1) {
      isBinary = true;
      headerText = fullText.slice(0, binIdx);
      let afterBin = binIdx + 7;
      while (afterBin < fullText.length && (fullText[afterBin] === '\r' || fullText[afterBin] === '\n')) {
        afterBin++;
      }
      dataByteOffset = afterBin * 2;
    } else if (valIdx !== -1) {
      isAsciiData = true;
      headerText = fullText.slice(0, valIdx);
      dataByteOffset = valIdx * 2;
    } else {
      headerText = fullText;
    }
  } else {
    const fullText = buf.toString('latin1');
    const binIdx = fullText.indexOf('Binary:');
    const valIdx = fullText.indexOf('Values:');

    if (binIdx !== -1) {
      isBinary = true;
      headerText = fullText.slice(0, binIdx);
      let afterBin = binIdx + 7;
      while (afterBin < fullText.length && (fullText[afterBin] === '\r' || fullText[afterBin] === '\n')) {
        afterBin++;
      }
      dataByteOffset = afterBin;
    } else if (valIdx !== -1) {
      isAsciiData = true;
      headerText = fullText.slice(0, valIdx);
      dataByteOffset = valIdx;
    } else {
      headerText = fullText;
    }
  }

  // 3. Parse header lines
  const lines = headerText.split(/\r?\n/);
  let plotName = '';
  let flags: string[] = [];
  let numVariables = 0;
  let numPoints = 0;
  const variables: RawVariable[] = [];

  let inVariables = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('Plotname:')) {
      plotName = line.slice(9).trim();
      inVariables = false;
    } else if (line.startsWith('Flags:')) {
      flags = line.slice(6).trim().toLowerCase().split(/\s+/);
      inVariables = false;
    } else if (line.startsWith('No. Variables:')) {
      numVariables = parseInt(line.slice(14).trim(), 10) || 0;
      inVariables = false;
    } else if (line.startsWith('No. Points:')) {
      numPoints = parseInt(line.slice(11).trim(), 10) || 0;
      inVariables = false;
    } else if (line.startsWith('Variables:')) {
      inVariables = true;
    } else if (inVariables) {
      // Line format: <index>\t<name>\t<type>
      const parts = rawLine.trim().split(/\s+/);
      if (parts.length >= 3) {
        variables.push({
          name: parts[1],
          type: parts.slice(2).join(' '),
        });
      }
    }
  }

  const isComplex = flags.includes('complex');

  // Prepare result structures
  const x = new Float64Array(numPoints);
  const series: Record<string, Float64Array | ComplexSeries> = {};

  for (let i = 1; i < variables.length; i++) {
    const varName = variables[i].name;
    if (isComplex) {
      series[varName] = {
        re: new Float64Array(numPoints),
        im: new Float64Array(numPoints),
      };
    } else {
      series[varName] = new Float64Array(numPoints);
    }
  }

  // 4. Parse Binary Data
  if (isBinary && numPoints > 0 && variables.length > 0) {
    let offset = dataByteOffset;

    if (isComplex) {
      // AC analysis: each variable is 2x float64 (re, im) = 16 bytes
      const bytesPerPoint = variables.length * 16;
      const actualPoints = Math.min(numPoints, Math.floor((buf.length - offset) / bytesPerPoint));

      for (let p = 0; p < actualPoints; p++) {
        // Variable 0 is frequency: read re as frequency
        x[p] = buf.readDoubleLE(offset);
        offset += 16; // var 0 real & imag

        for (let v = 1; v < variables.length; v++) {
          const s = series[variables[v].name] as ComplexSeries;
          s.re[p] = buf.readDoubleLE(offset);
          s.im[p] = buf.readDoubleLE(offset + 8);
          offset += 16;
        }
      }
    } else {
      // Transient analysis: variable 0 is float64 (8 bytes), variables 1..N-1 are float32 (4 bytes each)
      const bytesPerPoint = 8 + (variables.length - 1) * 4;
      const actualPoints = Math.min(numPoints, Math.floor((buf.length - offset) / bytesPerPoint));

      for (let p = 0; p < actualPoints; p++) {
        x[p] = buf.readDoubleLE(offset);
        offset += 8;

        for (let v = 1; v < variables.length; v++) {
          const s = series[variables[v].name] as Float64Array;
          s[p] = buf.readFloatLE(offset);
          offset += 4;
        }
      }
    }
  } else if (isAsciiData && numPoints > 0 && variables.length > 0) {
    // 5. Parse ASCII Values
    const fullText = isUtf16 ? buf.toString('utf16le') : buf.toString('latin1');
    const valIdx = fullText.indexOf('Values:');
    const dataSection = fullText.slice(valIdx + 7).trim();
    const dataLines = dataSection.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    let currentPoint = -1;
    let varIdx = 0;

    for (const line of dataLines) {
      const parts = line.split(/[,\s]+/).filter(Boolean);
      if (!parts.length) continue;

      if (varIdx === 0) {
        currentPoint++;
        if (currentPoint >= numPoints) break;
        // First token might be the point index
        const valToken = parts.length > 1 ? parts[1] : parts[0];
        x[currentPoint] = parseFloat(valToken);
        varIdx = 1;
      } else {
        if (varIdx < variables.length && currentPoint >= 0 && currentPoint < numPoints) {
          const varName = variables[varIdx].name;
          if (isComplex) {
            const s = series[varName] as ComplexSeries;
            s.re[currentPoint] = parseFloat(parts[0]);
            s.im[currentPoint] = parts.length > 1 ? parseFloat(parts[1]) : 0;
          } else {
            const s = series[varName] as Float64Array;
            s[currentPoint] = parseFloat(parts[0]);
          }
        }
        varIdx++;
        if (varIdx >= variables.length) {
          varIdx = 0;
        }
      }
    }
  }

  return {
    plotName,
    flags,
    variables,
    x,
    series,
  };
}
