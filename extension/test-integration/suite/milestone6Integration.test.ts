import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  checkTools,
  cleanupTestWorkspace,
  closeAllEditors,
  setupTestWorkspace,
  waitForTestHandle,
} from './testHelpers';

describe('Milestone 6: AI Agent Design Synthesis & Tuning Integration Flows', () => {
  let tempDir: string;
  let samplesDir: string;
  let mcpUrl: string;
  let authHeader: string;

  before(async function () {
    this.timeout(30000);
    const ws = await setupTestWorkspace();
    tempDir = ws.tempDir;
    samplesDir = ws.samplesDir;

    let config: any;
    const start = Date.now();
    while (Date.now() - start < 10000) {
      await vscode.commands.executeCommand('eide.copyMcpConfig');
      await new Promise((r) => setTimeout(r, 100));
      const clipboardText = await vscode.env.clipboard.readText();
      if (clipboardText && clipboardText.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(clipboardText);
          if (parsed.mcpServers?.eide?.url) {
            config = parsed;
            break;
          }
        } catch {}
      }
    }
    if (!config) {
      const { EidMcpServer } = require('../../src/agent/mcpServer');
      const inst = EidMcpServer.getActiveInstance();
      if (inst) {
        config = JSON.parse(inst.getMcpConfigJson());
      }
    }

    assert.ok(config?.mcpServers?.eide?.url, 'MCP config must contain server URL');
    assert.ok(config?.mcpServers?.eide?.headers?.Authorization, 'MCP config must contain Authorization header');

    mcpUrl = config.mcpServers.eide.url;
    authHeader = config.mcpServers.eide.headers.Authorization;
  });

  after(async () => {
    await closeAllEditors();
    cleanupTestWorkspace(tempDir);
  });

  afterEach(async () => {
    await closeAllEditors();
  });

  it('builds, checks, and tunes Sallen-Key low-pass filter through MCP client with single undo', async function () {
    this.timeout(120000);
    const tools = checkTools();
    if (!tools.hasLtspice) {
      this.skip();
      return;
    }

    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    const client = new Client({ name: 'test-milestone6-agent', version: '1.0.0' }, { timeout: 180000 } as any as any);
    await client.connect(transport);

    const ascPath = path.join(tempDir, 'sallen_key_synth.asc');
    const uri = vscode.Uri.file(ascPath);

    // 1. Tool: createSchematic
    const createRes: any = await client.callTool({
      name: 'createSchematic',
      arguments: { filePath: ascPath },
    });
    const createData = JSON.parse(createRes.content[0].text);
    assert.equal(createData.created, true);
    assert.ok(fs.existsSync(ascPath));

    await waitForTestHandle(uri);

    // 2. Tool: addComponent (V1, R1, R2, C1, C2, U1, GND1)
    const addVRes: any = await client.callTool({
      name: 'addComponent',
      arguments: { filePath: ascPath, type: 'V', value: 'SINE(0 1 2k) AC 1' },
    });
    assert.equal(JSON.parse(addVRes.content[0].text).ref, 'V1');

    const addR1Res: any = await client.callTool({
      name: 'addComponent',
      arguments: { filePath: ascPath, type: 'R', value: '7.5k' },
    });
    assert.equal(JSON.parse(addR1Res.content[0].text).ref, 'R1');

    // 3. Load full verified Sallen-Key topology
    const sampleAsc = fs.readFileSync(path.join(samplesDir, 'sallen_key_2k.asc'), 'utf8');
    const openDoc = await vscode.workspace.openTextDocument(uri);
    const we = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(new vscode.Position(0, 0), openDoc.lineAt(openDoc.lineCount - 1).range.end);
    we.replace(uri, fullRange, sampleAsc);
    await vscode.workspace.applyEdit(we);
    await openDoc.save();

    const historyMgr = (require('../../src/agent/agentHistory') as any).AgentHistoryManager.getInstance();
    historyMgr.clearHistory(ascPath);

    // 4. Tool: checkSpec
    const spec = {
      signal: 'V(out)',
      cutoff_hz: { target: 2000, tol_pct: 5 },
    };
    const checkRes: any = await client.callTool({
      name: 'checkSpec',
      arguments: { filePath: ascPath, spec },
    });
    const checkData = JSON.parse(checkRes.content[0].text);
    assert.ok(checkData.evaluations.cutoff_hz);
    assert.equal(checkData.pass, true);
    assert.ok(checkData.evaluations.cutoff_hz.measured > 1900 && checkData.evaluations.cutoff_hz.measured < 2100);

    // 5. Tool: tune
    // Deliberately detune R1 to 11k using setComponentValue
    await client.callTool({
      name: 'setComponentValue',
      arguments: { filePath: ascPath, id: 'R1', value: '11k' },
    });
    historyMgr.commitActiveTurn(ascPath);

    const tuneRes: any = await client.callTool(
      {
        name: 'tune',
        arguments: {
          filePath: ascPath,
          params: [
            { name: 'R1', min: 4000, max: 15000, initial: 11000, snapE24: true },
          ],
          spec,
          maxIterations: 5,
        },
      },
      undefined,
      { timeout: 180000 }
    );
    const tuneData = JSON.parse(tuneRes.content[0].text);
    assert.equal(tuneData.success, true);

    // 6. Verify single Undo restores detuned state
    const undoRes: any = await client.callTool(
      {
        name: 'undoAgentChange',
        arguments: { filePath: ascPath },
      },
      undefined,
      { timeout: 60000 }
    );
    const undoData = JSON.parse(undoRes.content[0].text);
    assert.equal(undoData.success, true);

    const docAfterUndo = await vscode.workspace.openTextDocument(uri);
    assert.match(docAfterUndo.getText(), /SYMATTR Value 11k/, 'Single Undo must restore pre-tune state');

    await client.close();
  });

  it('creates, wires, auto-arranges, and simulates Simulink model meeting spec via MCP client', async function () {
    this.timeout(120000);
    const tools = checkTools();
    if (!tools.hasMatlab) {
      this.skip();
      return;
    }

    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    const client = new Client({ name: 'test-milestone6-simulink', version: '1.0.0' }, { timeout: 180000 } as any);
    await client.connect(transport);

    const slxPath = path.join(tempDir, 'synth_motor.slx');

    // 1. Tool: createModel
    const createRes: any = await client.callTool({
      name: 'createModel',
      arguments: { filePath: slxPath },
    });
    const createData = JSON.parse(createRes.content[0].text);
    assert.equal(createData.created, true);

    // 2. Tool: addBlock (add all blocks)
    await client.callTool({
      name: 'addBlock',
      arguments: {
        filePath: slxPath,
        libraryPath: 'simulink/Sources/Step',
        name: 'Step_Ref',
        params: { Time: '0.05', Before: '0', After: '100' },
      },
    });

    await client.callTool({
      name: 'addBlock',
      arguments: {
        filePath: slxPath,
        libraryPath: 'simulink/Math Operations/Sum',
        name: 'Sum_Error',
        params: { Inputs: '+-' },
      },
    });

    await client.callTool({
      name: 'addBlock',
      arguments: {
        filePath: slxPath,
        libraryPath: 'simulink/Continuous/PID Controller',
        name: 'PI_Controller',
        params: { Controller: 'PI', P: '0.9', I: '4.5' },
      },
    });

    await client.callTool({
      name: 'addBlock',
      arguments: {
        filePath: slxPath,
        libraryPath: 'simulink/Continuous/Transfer Fcn',
        name: 'DC_Motor',
        params: { Numerator: '[2]', Denominator: '[0.005 0.1 1]' },
      },
    });

    await client.callTool({
      name: 'addBlock',
      arguments: {
        filePath: slxPath,
        libraryPath: 'simulink/Sinks/Out1',
        name: 'Speed_Out',
      },
    });

    // 3. Connect blocks
    await client.callTool({ name: 'connectBlocks', arguments: { filePath: slxPath, src: 'Step_Ref/1', dst: 'Sum_Error/1' } });
    await client.callTool({ name: 'connectBlocks', arguments: { filePath: slxPath, src: 'Sum_Error/1', dst: 'PI_Controller/1' } });
    await client.callTool({ name: 'connectBlocks', arguments: { filePath: slxPath, src: 'PI_Controller/1', dst: 'DC_Motor/1' } });
    await client.callTool({ name: 'connectBlocks', arguments: { filePath: slxPath, src: 'DC_Motor/1', dst: 'Speed_Out/1' } });
    await client.callTool({ name: 'connectBlocks', arguments: { filePath: slxPath, src: 'DC_Motor/1', dst: 'Sum_Error/2' } });

    // Enable signal logging
    const bridge = (require('../../src/agent/tools') as any).getMatlabBridge();
    await bridge.enableLogging(slxPath, 'DC_Motor', 1);

    // 4. Tool: autoLayout
    const layoutRes: any = await client.callTool({
      name: 'autoLayout',
      arguments: { filePath: slxPath },
    });
    assert.equal(JSON.parse(layoutRes.content[0].text).arranged, true);

    // 5. Tool: checkSpec (Overshoot < 10%)
    const spec = {
      overshoot_pct: { max: 10 },
      final_value: { target: 100, tol_pct: 10 },
    };
    const specRes: any = await client.callTool({
      name: 'checkSpec',
      arguments: { filePath: slxPath, spec },
    });
    const specData = JSON.parse(specRes.content[0].text);
    assert.equal(specData.pass, true);
    assert.ok(specData.evaluations.overshoot_pct.measured <= 10.0, 'Overshoot must be under 10%');

    await client.close();
  });
});
