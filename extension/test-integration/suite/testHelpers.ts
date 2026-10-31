import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findKicadCli } from '../../src/kicad/kicadCli';
import { findLtspice } from '../../src/ltspice/ltspiceRunner';
import { findMatlab } from '../../src/matlab/matlabFinder';
import { TestEditorHandle, TestHook } from '../../src/testHook';

/**
 * Copies samples/ directory from repo root into a unique temporary directory
 * so no test modifies the committed samples.
 */
export async function setupTestWorkspace(): Promise<{ tempDir: string; samplesDir: string }> {
  // Locate repo root: start from __dirname and walk up to find 'samples'
  let cur = path.resolve(__dirname);
  let repoRoot = cur;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(cur, 'samples'))) {
      repoRoot = cur;
      break;
    }
    cur = path.dirname(cur);
  }

  const samplesSrc = path.join(repoRoot, 'samples');
  if (!fs.existsSync(samplesSrc)) {
    throw new Error(`Cannot locate samples source directory at ${samplesSrc}`);
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.tmpdir();
  const tempDir = fs.mkdtempSync(path.join(workspaceRoot, 'eide-test-'));
  const samplesDir = path.join(tempDir, 'samples');
  fs.cpSync(samplesSrc, samplesDir, { recursive: true });

  return { tempDir, samplesDir };
}

export function cleanupTestWorkspace(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  } catch (err) {
    // Windows file locks may delay deletion briefly
  }
}

export async function waitForTestHandle(
  uri: vscode.Uri,
  timeoutMs: number = 15000
): Promise<TestEditorHandle> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const handle = TestHook.getHandle(uri);
    if (handle) {
      return handle;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for test editor handle for ${uri.fsPath}`);
}

export async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await new Promise((r) => setTimeout(r, 200));
}

export function createTruncatedFile(sourcePath: string, destPath: string): void {
  const data = fs.readFileSync(sourcePath);
  const half = Math.floor(data.length / 2);
  fs.writeFileSync(destPath, data.subarray(0, half));
}

export function createEmptyFile(destPath: string): void {
  fs.writeFileSync(destPath, Buffer.alloc(0));
}

export function createRenamedBinaryFile(destPath: string): void {
  // Binary bytes without NUL so VS Code's text model allows CustomTextEditorProvider to resolve
  const buf = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) {
    buf[i] = (i % 254) + 1;
  }
  fs.writeFileSync(destPath, buf);
}

export function checkTools() {
  const config = vscode.workspace.getConfiguration('eide');
  const ltspice = findLtspice(config.get('ltspice.path'));
  const kicad = findKicadCli(config.get('kicad.cliPath'));
  const matlab = findMatlab({ customPath: config.get('matlab.path') });
  return {
    ltspicePath: ltspice,
    kicadPath: kicad,
    matlabPath: matlab,
    hasLtspice: Boolean(ltspice),
    hasKicad: Boolean(kicad),
    hasMatlab: Boolean(matlab),
  };
}
