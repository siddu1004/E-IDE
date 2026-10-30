import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseMatlabErrors } from '../src/matlab/matlabDiagnostics';

describe('matlabDiagnostics', () => {
  it('parses File/Line/Column syntax errors', () => {
    const errorText = `
Error: File: C:\\sim\\filter.m Line: 14 Column: 8
Invalid expression. When calling a function or indexing a variable, use parentheses.
`;
    const diags = parseMatlabErrors(errorText);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].filePath, 'C:\\sim\\filter.m');
    assert.equal(diags[0].line, 14);
    assert.equal(diags[0].column, 8);
    assert.match(diags[0].message, /Invalid expression/);
  });

  it('parses runtime stack trace errors with line numbers', () => {
    const errorText = `
Error using plot
Vectors must be the same lengths.

Error in run_simulation (line 27)
plot(t, y);
`;
    const diags = parseMatlabErrors(errorText, 'C:\\sim\\run_simulation.m');
    assert.equal(diags.length, 1);
    assert.equal(diags[0].filePath, 'C:\\sim\\run_simulation.m');
    assert.equal(diags[0].line, 27);
    assert.match(diags[0].message, /Vectors must be the same lengths/);
  });

  it('returns empty array when text has no errors', () => {
    const normalOutput = `
Simulation complete.
Maximum voltage: 3.3V
Elapsed time: 0.12s
`;
    const diags = parseMatlabErrors(normalOutput);
    assert.equal(diags.length, 0);
  });
});
