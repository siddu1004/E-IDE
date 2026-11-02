// Unit tests for desktop app mirror helpers.
// Pure node --test runner with zero vscode dependencies.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appForFile,
  appPids,
  AppWindow,
  findAppExecutable,
  getMirrorApp,
  isProtectedUserWindow,
  launchArgs,
  MIRROR_APPS,
  protectedUserPids,
} from '../src/mirror/mirrorApps';
import {
  computeAppStatus,
  formatAppStatusLabel,
  formatMirrorHeaderStatus,
  formatReloadPrompt,
  getAppDisplayState,
  shouldPromptGettingStarted,
} from '../src/mirror/mirrorStatus';

describe('Mirror Apps Registry & Detection', () => {
  it('contains entries for all 4 supported EEE apps', () => {
    const ids = MIRROR_APPS.map((a) => a.id);
    assert.deepEqual(ids, ['matlab', 'kicad', 'ltspice', 'arduino']);
  });

  it('maps file extensions to correct desktop app', () => {
    assert.equal(appForFile('filter.asc')?.id, 'ltspice');
    assert.equal(appForFile('subcircuit.cir')?.id, 'ltspice');
    assert.equal(appForFile('schematic.kicad_sch')?.id, 'kicad');
    assert.equal(appForFile('board.kicad_pcb')?.id, 'kicad');
    assert.equal(appForFile('model.slx')?.id, 'matlab');
    assert.equal(appForFile('script.m')?.id, 'matlab');
    assert.equal(appForFile('sketch.ino')?.id, 'arduino');
    assert.equal(appForFile('unknown.xyz'), undefined);
    assert.equal(appForFile('readme.txt'), undefined);
  });

  it('retrieves apps by id', () => {
    assert.equal(getMirrorApp('matlab')?.label, 'MATLAB / Simulink');
    assert.equal(getMirrorApp('kicad')?.label, 'KiCad');
    assert.equal(getMirrorApp('ltspice')?.label, 'LTspice');
    assert.equal(getMirrorApp('arduino')?.label, 'Arduino IDE');
    assert.equal(getMirrorApp('nonexistent'), undefined);
  });

  it('honors custom executable path in findAppExecutable', () => {
    const app = getMirrorApp('ltspice')!;
    const custom = 'C:\\custom\\path\\LTspice.exe';
    const found = findAppExecutable(app, custom, {}, (p) => p === custom);
    assert.equal(found, custom);
  });
});

describe('Launch Arguments & Process Matching', () => {
  it('formats launch arguments for MATLAB', () => {
    const matlab = getMirrorApp('matlab')!;
    assert.deepEqual(launchArgs(matlab), ['-desktop']);
    assert.deepEqual(launchArgs(matlab, 'C:\\work\\model.slx'), [
      '-desktop',
      '-r',
      "open('C:\\work\\model.slx')",
    ]);
  });

  it('formats launch arguments for other apps', () => {
    const ltspice = getMirrorApp('ltspice')!;
    const kicad = getMirrorApp('kicad')!;
    const arduino = getMirrorApp('arduino')!;

    assert.deepEqual(launchArgs(ltspice, 'C:\\test\\rc.asc'), ['C:\\test\\rc.asc']);
    assert.deepEqual(launchArgs(kicad, 'C:\\test\\board.kicad_sch'), ['C:\\test\\board.kicad_sch']);
    assert.deepEqual(launchArgs(arduino, 'C:\\test\\blink.ino'), ['C:\\test\\blink.ino']);
  });

  it('identifies process IDs matching app processes', () => {
    const kicad = getMirrorApp('kicad')!;
    const mockWindows: AppWindow[] = [
      { hwnd: 101, pid: 1000, process: 'kicad', title: 'KiCad Project Manager' },
      { hwnd: 102, pid: 1001, process: 'eeschema', title: 'Schematic Editor' },
      { hwnd: 103, pid: 2000, process: 'notepad', title: 'Untitled' },
    ];

    const pids = appPids(kicad, mockWindows);
    assert.deepEqual(pids.sort(), [1000, 1001]);
  });
});

describe('Mirror Status and Formatting Helpers', () => {
  it('derives display state correctly', () => {
    assert.equal(getAppDisplayState(true, true), 'running');
    assert.equal(getAppDisplayState(false, true), 'running');
    assert.equal(getAppDisplayState(true, false), 'installed');
    assert.equal(getAppDisplayState(false, false), 'not_installed');
  });

  it('formats status labels', () => {
    assert.equal(formatAppStatusLabel('running'), 'Running');
    assert.equal(formatAppStatusLabel('installed'), 'Installed');
    assert.equal(formatAppStatusLabel('not_installed'), 'Not installed');
  });

  it('formats reload prompt string', () => {
    assert.equal(formatReloadPrompt('LTspice'), 'Changed on disk, reload in LTspice?');
    assert.equal(formatReloadPrompt('KiCad'), 'Changed on disk, reload in KiCad?');
    assert.equal(formatReloadPrompt('MATLAB / Simulink'), 'Changed on disk, reload in MATLAB / Simulink?');
    assert.equal(formatReloadPrompt('Arduino IDE'), 'Changed on disk, reload in Arduino IDE?');
  });

  it('computes combined app status', () => {
    const ltspice = getMirrorApp('ltspice')!;
    const mockWindows: AppWindow[] = [
      { hwnd: 501, pid: 5000, process: 'LTspice', title: 'Draft1.asc' },
    ];

    const status = computeAppStatus(
      ltspice,
      mockWindows,
      'C:\\mock\\LTspice.exe',
      { ProgramFiles: 'C:\\Program Files' }
    );

    assert.equal(status.running, true);
    assert.deepEqual(status.pids, [5000]);
  });

  it('protects user MATLAB (Zero_Perturb_MPPT_Live) and KiCad (kcad_workshop) sessions', () => {
    assert.equal(isProtectedUserWindow('Zero_Perturb_MPPT_Live - Simulink academic use'), true);
    assert.equal(isProtectedUserWindow('kcad_workshop — KiCad 10.0'), true);
    assert.equal(isProtectedUserWindow('rc_circuit - Simulink'), false);
    assert.equal(isProtectedUserWindow('rc_filter — Schematic Editor'), false);

    const matlab = getMirrorApp('matlab')!;
    const kicad = getMirrorApp('kicad')!;
    const wins: AppWindow[] = [
      { hwnd: 1, pid: 22632, process: 'MATLAB', title: 'MATLAB R2026a' },
      { hwnd: 2, pid: 22632, process: 'MATLAB', title: 'Zero_Perturb_MPPT_Live - Simulink academic use' },
      { hwnd: 3, pid: 90001, process: 'MATLAB', title: 'rc_circuit - Simulink' },
      { hwnd: 4, pid: 55204, process: 'kicad', title: 'kcad_workshop — KiCad 10.0' },
      { hwnd: 5, pid: 90002, process: 'eeschema', title: 'rc_filter — Schematic Editor' },
    ];

    assert.deepEqual([...protectedUserPids(wins)].sort(), [22632, 55204]);
    assert.deepEqual(appPids(matlab, wins, false), [90001]);
    assert.deepEqual(appPids(matlab, wins, true), [22632, 90001]);
    assert.deepEqual(appPids(kicad, wins, false), [90002]);
    assert.deepEqual(appPids(kicad, wins, true), [55204, 90002]);
  });

  it('formats mirror header statuses and checks getting started prompt condition', () => {
    assert.equal(formatMirrorHeaderStatus('starting', 0, 'MATLAB / Simulink'), 'Starting MATLAB / Simulink…');
    assert.equal(formatMirrorHeaderStatus('live', 12), 'Live · 12 fps');
    assert.equal(formatMirrorHeaderStatus('live', 0), 'Live');
    assert.equal(formatMirrorHeaderStatus('minimized'), 'Minimized (App closed or minimized)');
    assert.equal(formatMirrorHeaderStatus('gone'), 'App closed or minimized');

    assert.equal(shouldPromptGettingStarted(false, [{ installed: false }, { installed: false }]), true);
    assert.equal(shouldPromptGettingStarted(true, [{ installed: false }]), false);
    assert.equal(shouldPromptGettingStarted(false, [{ installed: false }, { installed: true }]), false);
  });
});
