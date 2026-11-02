// Unit tests for in-IDE MATLAB Command Window pure logic.
// Tests command history tracking, local commands, and prompt echo formatting.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CommandHistoryTracker,
  formatConsoleEcho,
  formatWelcomeBanner,
  isLocalConsoleCommand,
} from '../src/matlab/matlabConsolePure';

describe('MATLAB Console Pure Logic', () => {
  it('formats command prompt echo', () => {
    assert.equal(formatConsoleEcho('a = magic(3)'), '>> a = magic(3)');
    assert.equal(formatConsoleEcho('plot(x, y)'), '>> plot(x, y)');
  });

  it('detects local console commands without remote eval', () => {
    assert.equal(isLocalConsoleCommand('clc'), 'clc');
    assert.equal(isLocalConsoleCommand('  clc  '), 'clc');
    assert.equal(isLocalConsoleCommand('clear screen'), 'clc');
    assert.equal(isLocalConsoleCommand('help'), 'help');
    assert.equal(isLocalConsoleCommand('help eide'), 'help');
    assert.equal(isLocalConsoleCommand('who'), undefined);
    assert.equal(isLocalConsoleCommand('sim("model")'), undefined);
  });

  it('tracks command history with arrow navigation', () => {
    const tracker = new CommandHistoryTracker(5);
    tracker.push('x = 10;');
    tracker.push('y = 20;');
    tracker.push('z = x + y');

    assert.deepEqual(tracker.getHistory(), ['x = 10;', 'y = 20;', 'z = x + y']);

    // Up arrow navigation
    assert.equal(tracker.navigateUp('current draft'), 'z = x + y');
    assert.equal(tracker.navigateUp('z = x + y'), 'y = 20;');
    assert.equal(tracker.navigateUp('y = 20;'), 'x = 10;');
    assert.equal(tracker.navigateUp('x = 10;'), 'x = 10;'); // at top

    // Down arrow navigation back to draft
    assert.equal(tracker.navigateDown('x = 10;'), 'y = 20;');
    assert.equal(tracker.navigateDown('y = 20;'), 'z = x + y');
    assert.equal(tracker.navigateDown('z = x + y'), 'current draft');
  });

  it('deduplicates consecutive identical commands', () => {
    const tracker = new CommandHistoryTracker(5);
    tracker.push('clc');
    tracker.push('clc');
    tracker.push('clc');
    assert.deepEqual(tracker.getHistory(), ['clc']);
  });

  it('formats welcome banner highlighting in-IDE execution', () => {
    const banner = formatWelcomeBanner('R2026a');
    assert.ok(banner.includes('E-IDE MATLAB Interactive Console'));
    assert.ok(banner.includes('Running completely inside IDE without opening real desktop windows'));
  });
});
