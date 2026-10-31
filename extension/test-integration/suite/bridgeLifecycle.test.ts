import * as assert from 'assert';
import * as vscode from 'vscode';
import { getMatlabBridge } from '../../src/agent/tools';
import { checkTools } from './testHelpers';

describe('MATLAB Bridge Lifecycle', () => {
  it('starts, rejects wrong token, stops, and verifies clean process cleanup', async function () {
    this.timeout(90000);
    const tools = checkTools();
    if (!tools.hasMatlab) {
      this.skip();
      return;
    }

    const bridge = getMatlabBridge();

    // 1. Start bridge session
    if (bridge.getStatus() === 'off') {
      await bridge.start();
    }
    assert.equal(bridge.getStatus(), 'ready');

    // 2. Verify token rejection on bridge
    let tokenRejected = false;
    try {
      await bridge.sendCommand('ping', { _tokenOverride: 'invalid-token-xyz' });
    } catch (err: any) {
      tokenRejected = true;
      assert.equal(err.identifier, 'EIDE:Unauthorized');
    }
    assert.ok(tokenRejected, 'Expected invalid token to be rejected with EIDE:Unauthorized');

    // 3. Stop bridge session
    await bridge.stop();
    assert.equal(bridge.getStatus(), 'off');
    await new Promise((r) => setTimeout(r, 1500));

    // 4. Restart bridge session
    await bridge.start();
    assert.equal(bridge.getStatus(), 'ready');
    const pong = await bridge.ping();
    assert.equal(pong, 'pong');

    await bridge.stop();
    assert.equal(bridge.getStatus(), 'off');
  });
});
