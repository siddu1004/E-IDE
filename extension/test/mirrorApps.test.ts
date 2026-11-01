import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appForFile,
  appPids,
  findAppExecutable,
  getMirrorApp,
  launchArgs,
  launchExecutable,
  matlabReloadCommand,
  windowsShowingFile,
} from '../src/mirror/mirrorApps';

const windows = [
  { hwnd: 1, pid: 10, process: 'MATLAB', title: 'MATLAB R2026a' },
  { hwnd: 2, pid: 11, process: 'MATLAB', title: 'model - Simulink' },
  { hwnd: 3, pid: 11, process: 'MATLAB', title: 'Scope' },
  { hwnd: 4, pid: 20, process: 'pcbnew', title: 'board.kicad_pcb - PCB Editor' },
  { hwnd: 5, pid: 30, process: 'Antigravity IDE', title: 'E-IDE' },
];

test('appPids collects every process of an app, case-insensitively', () => {
  assert.deepEqual(appPids(getMirrorApp('matlab')!, windows), [10, 11]);
  assert.deepEqual(appPids(getMirrorApp('kicad')!, windows), [20]);
  assert.deepEqual(appPids(getMirrorApp('ltspice')!, windows), []);
});

test('appForFile maps EEE file types to their desktop app', () => {
  assert.equal(appForFile('C:/p/model.SLX')?.id, 'matlab');
  assert.equal(appForFile('board.kicad_pcb')?.id, 'kicad');
  assert.equal(appForFile('buck.asc')?.id, 'ltspice');
  assert.equal(appForFile('blink.ino')?.id, 'arduino');
  assert.equal(appForFile('notes.txt'), undefined);
});

test('findAppExecutable prefers a configured path, then the install folders, else reports not installed', () => {
  const app = getMirrorApp('ltspice')!;
  const env = { LOCALAPPDATA: 'C:\\L', ProgramFiles: 'C:\\PF' };
  const ltspice = require('path').join('C:\\PF', 'ADI', 'LTspice', 'LTspice.exe');
  assert.equal(findAppExecutable(app, 'D:\\my\\LTspice.exe', env, (p) => p === 'D:\\my\\LTspice.exe'), 'D:\\my\\LTspice.exe');
  assert.equal(findAppExecutable(app, undefined, env, (p) => p === ltspice), ltspice);
  assert.equal(findAppExecutable(app, 'D:\\missing.exe', env, () => false), undefined);
});

test('launchArgs opens files, quoting paths for MATLAB', () => {
  assert.deepEqual(launchArgs(getMirrorApp('kicad')!, 'C:\\p\\a.kicad_pro'), ['C:\\p\\a.kicad_pro']);
  assert.deepEqual(launchArgs(getMirrorApp('matlab')!, "C:\\it's\\m.slx"), ['-desktop', '-r', "open('C:\\it''s\\m.slx')"]);
  assert.deepEqual(launchArgs(getMirrorApp('arduino')!), []);
});

test('KiCad opens schematics and boards in their own editors', () => {
  const kicad = getMirrorApp('kicad')!;
  const exe = require('path').join('C:\K', 'bin', 'kicad.exe');
  const has = () => true;
  assert.match(launchExecutable(kicad, exe, 'a.kicad_sch', has), /eeschema\.exe$/);
  assert.match(launchExecutable(kicad, exe, 'a.kicad_pcb', has), /pcbnew\.exe$/);
  assert.equal(launchExecutable(kicad, exe, 'a.kicad_pro', has), exe);
  assert.equal(launchExecutable(kicad, exe, 'a.kicad_sch', () => false), exe);
  assert.equal(launchExecutable(getMirrorApp('ltspice')!, 'L.exe', 'a.asc', has), 'L.exe');
});

test('matlabReloadCommand reopens models without discarding unsaved edits', () => {
  assert.equal(
    matlabReloadCommand("C:/it's/mppt.slx"),
    "close_system('mppt'); open_system('C:/it''s/mppt.slx')"
  );
  assert.equal(matlabReloadCommand('run.m'), undefined);
});

test('windowsShowingFile finds the app windows titled with the file', () => {
  const shown = windowsShowingFile(getMirrorApp('kicad')!, windows, 'C:/p/board.kicad_pcb');
  assert.deepEqual(shown.map((w) => w.hwnd), [4]);
  assert.deepEqual(windowsShowingFile(getMirrorApp('matlab')!, windows, 'board.kicad_pcb'), []);
});
