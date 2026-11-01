// Parser for Arduino CLI and avr-gcc / xtensa-gcc compiler output and diagnostics.
// Pure Node module, zero vscode imports.

export interface ArduinoDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  context?: string;
}

/**
 * Standard GCC / Clang compiler error line pattern:
 * e.g. "C:\path\to\sketch.ino:14:5: error: 'foo' was not declared in this scope"
 * or "/path/to/sketch.ino:22:1: warning: unused variable 'x' [-Wunused-variable]"
 * or "sketch.ino:5: fatal error: SPI.h: No such file or directory"
 */
const GCC_DIAGNOSTIC_REGEX = /^(.+?):(\d+):(?:(\d+):)?\s*(error|warning|fatal error|note):\s*(.+)$/i;

/**
 * Parses compiler output text and/or builder_result.diagnostics JSON into structured diagnostics.
 */
export function parseArduinoDiagnostics(
  compilerOutput: string,
  jsonDiagnostics?: any[]
): ArduinoDiagnostic[] {
  const results: ArduinoDiagnostic[] = [];
  const seenKeys = new Set<string>();

  // If compilerOutput is a JSON payload, extract diagnostics from builder_result or diagnostics root
  let diagArray = jsonDiagnostics;
  if (!diagArray && compilerOutput && typeof compilerOutput === 'string' && compilerOutput.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(compilerOutput.trim());
      if (parsed.builder_result && Array.isArray(parsed.builder_result.diagnostics)) {
        diagArray = parsed.builder_result.diagnostics;
      } else if (Array.isArray(parsed.diagnostics)) {
        diagArray = parsed.diagnostics;
      }
    } catch { }
  }

  // 1. Parse structured JSON diagnostics if provided
  if (Array.isArray(diagArray)) {
    for (const d of diagArray) {
      if (!d || typeof d !== 'object') continue;
      const file = typeof d.file === 'string' ? d.file : '';
      const line = typeof d.line === 'number' ? d.line : parseInt(d.line, 10) || 1;
      const column = typeof d.column === 'number' ? d.column : parseInt(d.column, 10) || 1;
      const rawSev = String(d.severity || '').toLowerCase();
      const severity: 'error' | 'warning' | 'info' = rawSev.includes('warn')
        ? 'warning'
        : rawSev.includes('info') || rawSev.includes('note')
          ? 'info'
          : 'error';
      const msgRaw = d.message || d.msg;
      const message = typeof msgRaw === 'string' ? msgRaw.split('\n')[0].trim() : 'Compiler error';

      const key = `${file}:${line}:${column}:${severity}:${message}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        results.push({ file, line, column, severity, message });
      }
    }
  }

  // 2. Parse text lines from GCC/arduino-cli output
  if (compilerOutput && typeof compilerOutput === 'string') {
    const lines = compilerOutput.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const match = line.match(GCC_DIAGNOSTIC_REGEX);
      if (match) {
        const file = match[1].trim();
        const lineNum = parseInt(match[2], 10) || 1;
        const colNum = match[3] ? parseInt(match[3], 10) : 1;
        const rawType = match[4].toLowerCase();
        const message = match[5].trim();

        let severity: 'error' | 'warning' | 'info' = 'error';
        if (rawType === 'warning') {
          severity = 'warning';
        } else if (rawType === 'note') {
          severity = 'info';
        }

        const key = `${file}:${lineNum}:${colNum}:${severity}:${message}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          results.push({
            file,
            line: lineNum,
            column: colNum,
            severity,
            message,
          });
        }
      }
    }
  }

  return results;
}
