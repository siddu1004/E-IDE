import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as net from 'net';
import { MatlabBridge, BridgeStatus } from '../src/matlab/matlabBridge';

describe('MatlabBridge Protocol & Authentication', () => {
  let server: net.Server;
  let serverPort = 0;
  const validToken = 'test-secret-token-12345';

  before(async () => {
    // Start a mock MATLAB bridge server
    await new Promise<void>((resolve) => {
      server = net.createServer((socket) => {
        let buf = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          buf += chunk;
          const lines = buf.split('\n');
          buf = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const req = JSON.parse(trimmed);

              // 1. Verify token
              if (req.token !== validToken) {
                const resp = {
                  status: 'error',
                  error: {
                    identifier: 'EIDE:Unauthorized',
                    message: 'Invalid or missing session token',
                  },
                };
                socket.write(JSON.stringify(resp) + '\n');
                continue;
              }

              // 2. Dispatch commands
              switch (req.cmd) {
                case 'ping':
                  socket.write(JSON.stringify({ status: 'ok', result: 'pong' }) + '\n');
                  break;

                case 'runScript':
                  socket.write(
                    JSON.stringify({
                      status: 'ok',
                      result: {
                        output: `Executed ${req.args.path}\nResult = 42\n`,
                        figures: ['/tmp/fig1.png'],
                      },
                    }) + '\n'
                  );
                  break;

                case 'loadModel':
                  socket.write(
                    JSON.stringify({
                      status: 'ok',
                      result: { model: 'rc_circuit', loaded: true },
                    }) + '\n'
                  );
                  break;

                case 'createModel':
                  socket.write(JSON.stringify({ status: 'ok', result: { model: 'test_model', created: true } }) + '\n');
                  break;

                case 'addBlock':
                  socket.write(JSON.stringify({ status: 'ok', result: { block: req.args.name, added: true } }) + '\n');
                  break;

                case 'removeBlock':
                  socket.write(JSON.stringify({ status: 'ok', result: { block: req.args.name, removed: true } }) + '\n');
                  break;

                case 'autoLayout':
                  socket.write(JSON.stringify({ status: 'ok', result: { model: 'test_model', arranged: true } }) + '\n');
                  break;

                case 'setParam':
                  socket.write(
                    JSON.stringify({
                      status: 'ok',
                      result: { saved: true, block: req.args.block, param: req.args.param, value: req.args.value },
                    }) + '\n'
                  );
                  break;

                case 'simulate':
                  socket.write(
                    JSON.stringify({
                      status: 'ok',
                      result: {
                        model: 'rc_circuit',
                        signals: [
                          {
                            name: 'Vc',
                            time: [0, 0.1, 0.2, 0.3],
                            values: [0, 0.63, 0.86, 0.95],
                          },
                        ],
                      },
                    }) + '\n'
                  );
                  break;

                case 'errorCmd':
                  socket.write(
                    JSON.stringify({
                      status: 'error',
                      error: {
                        identifier: 'Simulink:Commands:InvBlockName',
                        message: 'Block not found in model',
                      },
                    }) + '\n'
                  );
                  break;

                case 'exit':
                  socket.write(JSON.stringify({ status: 'ok', result: 'bye' }) + '\n');
                  socket.end();
                  break;

                default:
                  socket.write(
                    JSON.stringify({
                      status: 'error',
                      error: {
                        identifier: 'EIDE:UnknownCommand',
                        message: `Unknown command ${req.cmd}`,
                      },
                    }) + '\n'
                  );
              }
            } catch (err: any) {
              socket.write(
                JSON.stringify({
                  status: 'error',
                  error: {
                    identifier: 'EIDE:InvalidJson',
                    message: err.message,
                  },
                }) + '\n'
              );
            }
          }
        });
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        serverPort = addr.port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('connects, tracks status transitions, and executes ping', async () => {
    const bridge = new MatlabBridge();
    const statuses: BridgeStatus[] = [];
    bridge.onStatusChange((s) => statuses.push(s));

    assert.equal(bridge.getStatus(), 'off');
    await bridge.connectDirect(serverPort, validToken);

    assert.equal(bridge.getStatus(), 'ready');
    const pong = await bridge.ping();
    assert.equal(pong, 'pong');

    await bridge.stop();
    assert.equal(bridge.getStatus(), 'off');
    assert.ok(statuses.includes('starting'));
    assert.ok(statuses.includes('ready'));
    assert.ok(statuses.includes('off'));
  });

  it('rejects commands when token is invalid', async () => {
    const bridge = new MatlabBridge();
    await bridge.connectDirect(serverPort, 'wrong-token-abc');

    await assert.rejects(
      async () => {
        await bridge.ping();
      },
      (err: any) => {
        assert.match(err.message, /\[EIDE:Unauthorized\]/);
        return true;
      }
    );

    await bridge.stop();
  });

  it('handles runScript and extracts output and figures', async () => {
    const bridge = new MatlabBridge();
    await bridge.connectDirect(serverPort, validToken);

    const res = await bridge.runScript('sample_test.m');
    assert.match(res.output, /Result = 42/);
    assert.deepEqual(res.figures, ['/tmp/fig1.png']);

    await bridge.stop();
  });

  it('handles createModel, addBlock, removeBlock, autoLayout, and validates libraries', async () => {
    const bridge = new MatlabBridge();
    await bridge.connectDirect(serverPort, validToken);

    const created = await bridge.createModel('test_model.slx');
    assert.equal(created.created, true);

    const added = await bridge.addBlock('test_model.slx', 'simulink/Continuous/Integrator', 'Int1');
    assert.equal(added.added, true);

    // Security check: disallowed library
    await assert.rejects(
      async () => {
        await bridge.addBlock('test_model.slx', 'malicious/library/block', 'BadBlock');
      },
      /Security violation/
    );

    const removed = await bridge.removeBlock('test_model.slx', 'Int1');
    assert.equal(removed.removed, true);

    const arranged = await bridge.autoLayout('test_model.slx');
    assert.equal(arranged.arranged, true);

    await bridge.stop();
  });

  it('handles setParam and simulate', async () => {
    const bridge = new MatlabBridge();
    await bridge.connectDirect(serverPort, validToken);

    const setRes = await bridge.setParam('rc_circuit.slx', 'Gain', 'Gain', '2.5');
    assert.equal(setRes.saved, true);

    const simRes = await bridge.simulate('rc_circuit.slx', 1.0);
    assert.equal(simRes.model, 'rc_circuit');
    assert.equal(simRes.signals.length, 1);
    assert.equal(simRes.signals[0].name, 'Vc');
    assert.deepEqual(simRes.signals[0].values, [0, 0.63, 0.86, 0.95]);

    await bridge.stop();
  });

  it('propagates MATLAB error identifier and message', async () => {
    const bridge = new MatlabBridge();
    await bridge.connectDirect(serverPort, validToken);

    await assert.rejects(
      async () => {
        await bridge.sendCommand('errorCmd');
      },
      (err: any) => {
        assert.match(err.message, /\[Simulink:Commands:InvBlockName\]/);
        assert.equal(err.identifier, 'Simulink:Commands:InvBlockName');
        return true;
      }
    );

    await bridge.stop();
  });

  it('queues concurrent commands and executes them sequentially', async () => {
    const bridge = new MatlabBridge();
    await bridge.connectDirect(serverPort, validToken);

    const [p1, p2, p3] = await Promise.all([
      bridge.ping(),
      bridge.loadModel('rc_circuit.slx'),
      bridge.ping(),
    ]);

    assert.equal(p1, 'pong');
    assert.equal(p2.loaded, true);
    assert.equal(p3, 'pong');

    await bridge.stop();
  });
});
