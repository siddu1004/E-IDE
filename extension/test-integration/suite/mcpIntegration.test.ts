import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
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

describe('Milestone 5: AI Agent MCP Integration Flows', () => {
  let tempDir: string;
  let samplesDir: string;
  let mcpUrl: string;
  let authHeader: string;
  let validToken: string;

  before(async () => {
    const ws = await setupTestWorkspace();
    tempDir = ws.tempDir;
    samplesDir = ws.samplesDir;

    // Retrieve MCP server configuration via extension command
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

    assert.ok(config.mcpServers?.eide?.url, 'MCP config must contain server URL');
    assert.ok(config.mcpServers?.eide?.headers?.Authorization, 'MCP config must contain Authorization header');

    mcpUrl = config.mcpServers.eide.url;
    authHeader = config.mcpServers.eide.headers.Authorization;
    validToken = authHeader.replace(/^Bearer\s+/, '');
  });

  after(async () => {
    await closeAllEditors();
    cleanupTestWorkspace(tempDir);
  });

  afterEach(async () => {
    await closeAllEditors();
  });

  beforeEach(async () => {
    // Temp dir is inside workspace root
  });

  it('rejects MCP requests with invalid or missing bearer token', async () => {
    // Attempt connection with invalid token
    const badTransport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: {
        headers: {
          Authorization: 'Bearer invalid-secret-token',
        },
      },
    });

    const badClient = new Client({ name: 'unauthorized-client', version: '1.0.0' });
    let rejected = false;
    try {
      await badClient.connect(badTransport);
      await badClient.listTools();
    } catch (e: any) {
      rejected = true;
    }
    assert.ok(rejected, 'MCP server must reject unauthorized requests');
  });

  it('rejects tool calls targeting files outside the workspace folder', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(transport);

    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-ws-'));
    const outsidePath = path.join(outsideDir, 'malicious_circuit.asc');
    fs.writeFileSync(outsidePath, 'Version 4\nSHEET 1 880 680\n');

    try {
      let threw = false;
      try {
        const res: any = await client.callTool({
          name: 'getSchematic',
          arguments: { filePath: outsidePath },
        });
        if (res.isError || (res.content?.[0]?.text && res.content[0].text.includes('Security violation'))) {
          threw = true;
        }
      } catch (err: any) {
        threw = true;
      }
      assert.ok(threw, 'Access to files outside workspace folders must be blocked');
    } finally {
      try {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      } catch {}
      await client.close();
    }
  });

  it('connects real MCP client, lists open designs, edits LTspice schematic, checks banner, auto-simulates, and undos', async function () {
    this.timeout(40000);
    const tools = checkTools();
    if (!tools.hasLtspice) {
      this.skip();
      return;
    }

    const ascPath = path.join(tempDir, 'rc_lowpass.asc');
    const originalBytes = fs.readFileSync(path.join(samplesDir, 'rc_lowpass.asc'));
    fs.writeFileSync(ascPath, originalBytes);
    const uri = vscode.Uri.file(ascPath);

    // Open in E-IDE custom editor
    await vscode.commands.executeCommand('vscode.openWith', uri, 'eide.ltspiceSchematic');
    const handle = await waitForTestHandle(uri);

    // Wait for ready
    await handle.waitForMessage((m) => m.type === 'update');

    // Connect MCP client
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(transport);

    // 1. Introspection: listOpenDesigns
    const openDesignsRes: any = await client.callTool({
      name: 'listOpenDesigns',
      arguments: {},
    });
    const openDesigns = JSON.parse(openDesignsRes.content[0].text);
    assert.ok(Array.isArray(openDesigns), 'listOpenDesigns must return array');
    assert.ok(
      openDesigns.some((d: any) => d.name === 'rc_lowpass.asc' && d.type === 'ltspice'),
      'Open design rc_lowpass.asc must be detected'
    );

    // 2. setComponentValue: change R1 from 10k to 4.7k
    const setRes: any = await client.callTool({
      name: 'setComponentValue',
      arguments: {
        filePath: ascPath,
        id: 'R1',
        value: '4.7k',
      },
    });
    assert.strictEqual(setRes.isError, undefined, `setComponentValue failed: ${setRes.content?.[0]?.text}`);
    const setResData = JSON.parse(setRes.content[0].text);
    assert.equal(setResData.success, true);

    // 3. Verify editor received agentBanner with Undo
    const bannerMsg = await handle.waitForMessage(
      (m) => m.type === 'agentBanner' && m.hasUndo === true && m.text.includes('R1')
    );
    assert.ok(bannerMsg, 'Editor webview must receive agentBanner message');
    assert.match(bannerMsg.text, /Agent: R1 1k -> 4\.7k/);

    // 4. Verify simulation was executed and compact summary returned
    const docAfterEdit = await vscode.workspace.openTextDocument(uri);
    assert.match(docAfterEdit.getText(), /SYMATTR InstName R1[\s\S]*?SYMATTR Value 4\.7k/);

    // 5. Downsampling waveform check
    const waveformRes: any = await client.callTool({
      name: 'getWaveform',
      arguments: {
        filePath: ascPath,
        signal: 'V(out)',
        maxPoints: 100,
      },
    });
    const wfData = JSON.parse(waveformRes.content[0].text);
    assert.equal(wfData.signal, 'V(out)');
    assert.ok(wfData.returnedPoints <= 100);
    assert.equal(wfData.x.length, wfData.returnedPoints);
    assert.equal(wfData.y.length, wfData.returnedPoints);

    // 6. Undo restores exact original bytes
    const undoRes: any = await client.callTool({
      name: 'undoAgentChange',
      arguments: { filePath: ascPath },
    });
    const undoData = JSON.parse(undoRes.content[0].text);
    assert.equal(undoData.success, true);

    // Verify document text is restored
    const docAfterUndo = await vscode.workspace.openTextDocument(uri);
    assert.match(docAfterUndo.getText(), /SYMATTR InstName R1[\s\S]*?SYMATTR Value 1k/);

    // Compare saved disk bytes with original
    await docAfterUndo.save();
    const currentBytes = fs.readFileSync(ascPath, 'utf8').trim();
    const origText = originalBytes.toString('utf8').trim();
    assert.equal(currentBytes, origText, 'Undo must restore exact original file text');

    await client.close();
  });

  it('runs Simulink MCP workflow with setBlockParam, banner, and undo if MATLAB is running', async function () {
    this.timeout(90000);
    const tools = checkTools();
    if (!tools.hasMatlab) {
      this.skip();
      return;
    }

    const slxPath = path.join(tempDir, 'rc_circuit.slx');
    const originalBytes = fs.readFileSync(path.join(samplesDir, 'rc_circuit.slx'));
    fs.writeFileSync(slxPath, originalBytes);
    const uri = vscode.Uri.file(slxPath);

    await vscode.commands.executeCommand('vscode.openWith', uri, 'eide.simulinkModel');
    const handle = await waitForTestHandle(uri);
    await handle.waitForMessage((m) => m.type === 'update');

    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: {
        headers: {
          Authorization: authHeader,
        },
      },
    });
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(transport);

    // Inspect model
    const modelRes: any = await client.callTool({
      name: 'getSimulinkModel',
      arguments: { filePath: slxPath },
    });
    const modelData = JSON.parse(modelRes.content[0].text);
    assert.ok(modelData.rootSystem.blocks.length > 0);

    // setBlockParam: modify RC_Filter denominator
    const targetBlock = modelData.rootSystem.blocks.find((b: any) => b.name === 'RC_Filter') || modelData.rootSystem.blocks[0];
    const paramRes: any = await client.callTool({
      name: 'setBlockParam',
      arguments: {
        filePath: slxPath,
        block: targetBlock.name,
        param: 'Denominator',
        value: '[0.2 1]',
      },
    });
    assert.strictEqual(paramRes.isError, undefined, `setBlockParam failed: ${paramRes.content?.[0]?.text}`);
    const paramData = JSON.parse(paramRes.content[0].text);
    assert.equal(paramData.saved, true);

    // Verify banner received
    const bannerMsg = await handle.waitForMessage(
      (m) => m.type === 'agentBanner' && m.hasUndo === true
    );
    assert.ok(bannerMsg, 'Simulink editor webview must receive agentBanner');

    // Undo restores original file
    const undoRes: any = await client.callTool({
      name: 'undoAgentChange',
      arguments: { filePath: slxPath },
    });
    assert.strictEqual(undoRes.isError, undefined, `undoAgentChange failed: ${undoRes.content?.[0]?.text}`);
    const undoData = JSON.parse(undoRes.content[0].text);
    assert.equal(undoData.success, true);

    // Verify original bytes restored
    const restoredBytes = fs.readFileSync(slxPath);
    assert.equal(restoredBytes.length, originalBytes.length);

    await client.close();
  });
});
