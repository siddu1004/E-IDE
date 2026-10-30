// MATLAB error output parser for VS Code Problems panel / diagnostics.
// Pure Node module, zero vscode imports, testable with node --test.

export interface MatlabErrorDiagnostic {
  filePath?: string;
  line: number;
  column: number;
  message: string;
  identifier?: string;
  severity: 'error' | 'warning';
}

/**
 * Parses MATLAB stdout/stderr/error text into diagnostic records.
 */
export function parseMatlabErrors(
  text: string,
  defaultFilePath?: string
): MatlabErrorDiagnostic[] {
  const diagnostics: MatlabErrorDiagnostic[] = [];
  if (!text) return diagnostics;

  const lines = text.split(/\r?\n/);

  // Pattern 1: Error: File: <path> Line: <num> Column: <num>
  // Message on next line or same line
  const fileLineColRegex = /Error:\s*File:\s*(.*?)\s+Line:\s*(\d+)\s+Column:\s*(\d+)/i;

  // Pattern 2: Error in/using <fn> (line <num>) or Error in/using <path> (line <num>)
  const errorInLineRegex = /Error\s+(?:in|using)\s+(.*?)\s*\(line\s+(\d+)\)/i;

  // Pattern 3: Error using <fn>\n<message>
  const errorUsingRegex = /Error using\s+(.*)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const match1 = line.match(fileLineColRegex);
    if (match1) {
      const parsedPath = match1[1].trim() || defaultFilePath;
      const lineNum = parseInt(match1[2], 10);
      const colNum = parseInt(match1[3], 10);
      let msg = lines[i + 1]?.trim() || line.trim();
      diagnostics.push({
        filePath: parsedPath,
        line: lineNum > 0 ? lineNum : 1,
        column: colNum > 0 ? colNum : 1,
        message: msg,
        severity: 'error',
      });
      continue;
    }

    const match2 = line.match(errorInLineRegex);
    if (match2) {
      const sourceRef = match2[1].trim();
      const lineNum = parseInt(match2[2], 10);
      
      // Look backward for the error message (e.g. "Error using ... \n <msg>")
      let msg = '';
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j].trim();
        if (!prev) continue;
        if (/^Error in/i.test(prev)) continue;
        msg = prev;
        break;
      }
      if (!msg) {
        msg = line.trim();
      }

      // If sourceRef is just a function name, default to defaultFilePath
      const resolvedPath = sourceRef.includes('/') || sourceRef.includes('\\')
        ? sourceRef
        : defaultFilePath;

      diagnostics.push({
        filePath: resolvedPath,
        line: lineNum > 0 ? lineNum : 1,
        column: 1,
        message: msg,
        severity: 'error',
      });
      continue;
    }
  }

  return diagnostics;
}
