// Desktop apps shown inside E-IDE: runs in a real VS Code host on Windows.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { activeAppMirror } from '../../src/mirror/appMirror';
import { closeAllEditors } from './testHelpers';

describe('Desktop apps inside E-IDE', function () {
  this.timeout(90000);

  before(async function () {
    if (process.platform !== 'win32') this.skip();
    await vscode.extensions.all.find((e) => e.packageJSON?.name === 'e-ide')?.activate();
  });

  after(closeAllEditors);

  it('registers the open commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('eide.apps.open'));
    assert.ok(commands.includes('eide.apps.openFile'));
  });

  it('reports install and running state for every app', async () => {
    assert.ok(activeAppMirror, 'controller is set on activation');
    const status = await activeAppMirror!.status();
    assert.deepStrictEqual(status.map((s) => s.id), ['matlab', 'kicad', 'ltspice', 'arduino']);
    for (const s of status) assert.strictEqual(typeof s.installed, 'boolean');
  });

  it('shows a running app in a tab and captures its windows', async function () {
    const running = (await activeAppMirror!.status()).find((s) => s.running);
    if (!running) this.skip(); // nothing to mirror on this machine
    await activeAppMirror!.show(running!.id);
    // The tab model updates a moment after the panel is created.
    const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    for (let i = 0; i < 30 && !tabs().some((t) => t.label === running!.label); i++) await new Promise((r) => setTimeout(r, 100));
    const tab = tabs().find((t) => t.label === running!.label);
    const labels = tabs().map((t) => t.label);
    assert.ok(tab, `a '${running!.label}' tab is open; tabs: ${labels.join(', ')}`);
    const frame = await activeAppMirror!.capture(running!.id);
    assert.ok(frame.width > 100 && frame.height > 100, `frame ${frame.width}x${frame.height}`);
    assert.ok(Buffer.from(frame.jpeg, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'frame is a JPEG');
  });
});
