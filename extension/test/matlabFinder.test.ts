import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { findMatlab, sortMatlabReleaseFolders } from '../src/matlab/matlabFinder';

describe('matlabFinder', () => {
  it('sorts MATLAB release folders with newest first', () => {
    const folders = ['R2024b', 'R2026a', 'R2025a', 'R2025b', 'R2023a'];
    const sorted = sortMatlabReleaseFolders(folders);
    assert.deepEqual(sorted, ['R2026a', 'R2025b', 'R2025a', 'R2024b', 'R2023a']);
  });

  it('honors valid custom path', () => {
    const fakeCustom = path.resolve('fake/custom/matlab.exe');
    const result = findMatlab({
      customPath: fakeCustom,
      existsSync: (p) => path.resolve(p) === fakeCustom,
    });
    assert.equal(result, fakeCustom);
  });

  it('discovers newest release under ProgramFiles in simulated environment', () => {
    const root = 'C:\\Program Files\\MATLAB';
    const fakeFiles = new Set([
      root,
      path.join(root, 'R2025b', 'bin', 'matlab.exe'),
      path.join(root, 'R2026a', 'bin', 'matlab.exe'),
    ]);

    const result = findMatlab({
      env: { ProgramFiles: 'C:\\Program Files', PATH: '' },
      existsSync: (p) => fakeFiles.has(path.normalize(p)),
      readdirSync: (p) => {
        if (path.normalize(p) === root) {
          return ['R2025b', 'R2026a'];
        }
        return [];
      },
    });

    assert.equal(result, path.resolve('C:\\Program Files\\MATLAB\\R2026a\\bin\\matlab.exe'));
  });

  it('falls back to PATH if Program Files has no MATLAB', () => {
    const pathDir = 'C:\\Tools\\bin';
    const fakeExe = path.join(pathDir, 'matlab.exe');

    const result = findMatlab({
      env: {
        ProgramFiles: 'C:\\Nonexistent',
        PATH: pathDir,
        OS: 'Windows_NT',
      },
      existsSync: (p) => path.normalize(p) === path.normalize(fakeExe),
      readdirSync: () => [],
    });

    assert.equal(result, path.resolve(fakeExe));
  });

  it('returns undefined when no MATLAB is found', () => {
    const result = findMatlab({
      customPath: '',
      env: { ProgramFiles: 'C:\\Empty', PATH: '' },
      existsSync: () => false,
      readdirSync: () => [],
    });

    assert.equal(result, undefined);
  });

  it('detects live installed MATLAB if running on this workstation', () => {
    const found = findMatlab();
    if (found) {
      assert.match(found, /matlab(\.exe)?$/i);
    }
  });
});
