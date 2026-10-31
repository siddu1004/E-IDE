import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as tools from './tools';

export class EidMcpServer {
  private static activeInstance?: EidMcpServer;

  public static getActiveInstance(): EidMcpServer | undefined {
    return EidMcpServer.activeInstance;
  }

  private server?: http.Server;
  private transport?: StreamableHTTPServerTransport;
  private mcpServer?: McpServer;
  private token: string;
  private port: number = 0;
  private statusBarItem: vscode.StatusBarItem;
  private isConnected: boolean = false;
  private sessions = new Map<string, { transport: StreamableHTTPServerTransport; mcpServer: McpServer }>();

  constructor(private readonly context: vscode.ExtensionContext) {
    EidMcpServer.activeInstance = this;
    this.token = crypto.randomBytes(24).toString('hex');
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'eide.copyMcpConfig';
    this.updateStatusBar();
    this.statusBarItem.show();
    this.context.subscriptions.push(this.statusBarItem);
  }

  public getPort(): number {
    return this.port;
  }

  public getToken(): string {
    return this.token;
  }

  public getMcpConfigJson(): string {
    const config = {
      mcpServers: {
        eide: {
          url: `http://127.0.0.1:${this.port}/mcp`,
          headers: {
            Authorization: `Bearer ${this.token}`,
          },
        },
      },
    };
    return JSON.stringify(config, null, 2);
  }

  private updateStatusBar() {
    if (this.isConnected) {
      this.statusBarItem.text = `$(hubot) E-IDE: Agent Connected`;
      this.statusBarItem.tooltip = `E-IDE MCP Server active on 127.0.0.1:${this.port} (Agent connected). Click to copy MCP config.`;
    } else {
      this.statusBarItem.text = `$(hubot) E-IDE: Agent Ready`;
      this.statusBarItem.tooltip = `E-IDE MCP Server active on 127.0.0.1:${this.port} (No agent connected). Click to copy MCP config.`;
    }
  }

  public async start(): Promise<number> {
    this.server = http.createServer(async (req, res) => {
      // 1. Origin check: Reject untrusted origins
      const origin = req.headers['origin'];
      if (origin) {
        // Compare the parsed hostname: a prefix check would let http://localhost.evil.com through.
        let host = '';
        try { host = new URL(origin).hostname; } catch { /* malformed origin stays rejected */ }
        const isAllowed = host === '127.0.0.1' || host === 'localhost';
        if (!isAllowed) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden origin' }));
          return;
        }
      }

      // 2. Bearer token check
      const auth = req.headers['authorization'];
      const expected = Buffer.from(`Bearer ${this.token}`);
      const given = Buffer.from(String(auth ?? ''));
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing bearer token' }));
        return;
      }

      // Mark agent connected
      if (!this.isConnected) {
        this.isConnected = true;
        this.updateStatusBar();
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let session = sessionId ? this.sessions.get(sessionId) : undefined;

      try {
        if (!session) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
          });
          const mcpServer = new McpServer({
            name: 'eide',
            version: '0.0.1',
          });
          this.registerTools(mcpServer);
          await mcpServer.connect(transport);

          await transport.handleRequest(req, res);
          if (transport.sessionId) {
            this.sessions.set(transport.sessionId, { transport, mcpServer });
          }
        } else {
          await session.transport.handleRequest(req, res);
          if (req.method === 'DELETE') {
            this.sessions.delete(sessionId!);
          }
        }
      } catch (err: any) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
        }
      }
    });

    return new Promise<number>((resolve, reject) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (typeof addr === 'object' && addr !== null) {
          this.port = addr.port;
          this.updateStatusBar();
          resolve(this.port);
        } else {
          reject(new Error('Failed to obtain server address'));
        }
      });
      this.server!.on('error', reject);
    });
  }

  private registerTools(mcp: McpServer) {
    // 0. Introspection
    mcp.tool('listOpenDesigns', 'List designs currently open in E-IDE editors (*.asc, *.kicad_sch, *.slx).', {}, async () => {
      const designs = tools.listOpenDesigns();
      return { content: [{ type: 'text', text: JSON.stringify(designs, null, 2) }] };
    });

    // 1. LTspice: getSchematic
    mcp.tool(
      'getSchematic',
      'Get parsed AST of an LTspice schematic (*.asc).',
      { filePath: z.string().describe('Path to the .asc file inside workspace') },
      async ({ filePath }) => {
        const sch = await tools.getSchematic(filePath);
        return { content: [{ type: 'text', text: JSON.stringify(sch, null, 2) }] };
      }
    );

    // 2. LTspice: setComponentValue
    mcp.tool(
      'setComponentValue',
      'Set component value in LTspice schematic, re-simulates, and overlays results.',
      {
        filePath: z.string().describe('Path to the .asc file inside workspace'),
        id: z.string().describe('Symbol instance name (e.g. R1, C1)'),
        value: z.string().describe('New component value (e.g. 4.7k, 100n)'),
      },
      async ({ filePath, id, value }) => {
        const res = await tools.setComponentValue(filePath, id, value);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 3. LTspice: runSimulation
    mcp.tool(
      'runSimulation',
      'Run LTspice batch simulation and return compact summary (rise time, overshoot, cutoff frequency, measurements).',
      { filePath: z.string().describe('Path to the .asc file inside workspace') },
      async ({ filePath }) => {
        const res = await tools.runSimulation(filePath);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 4. LTspice: getMeasurements
    mcp.tool(
      'getMeasurements',
      'Get SPICE .meas results from an LTspice simulation.',
      { filePath: z.string().describe('Path to the .asc file inside workspace') },
      async ({ filePath }) => {
        const res = await tools.getMeasurements(filePath);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 5. KiCad: getKicadSchematic
    mcp.tool(
      'getKicadSchematic',
      'Get KiCad schematic summary (components, nets, labels).',
      { filePath: z.string().describe('Path to the .kicad_sch file inside workspace') },
      async ({ filePath }) => {
        const res = await tools.getKicadSchematic(filePath);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 6. KiCad: setKicadProperty
    mcp.tool(
      'setKicadProperty',
      'Set property (Value, Footprint, etc.) on a KiCad symbol.',
      {
        filePath: z.string().describe('Path to the .kicad_sch file inside workspace'),
        ref: z.string().describe('Symbol reference (e.g. R1)'),
        key: z.string().describe('Property key (e.g. Value)'),
        value: z.string().describe('New property value'),
      },
      async ({ filePath, ref, key, value }) => {
        const res = await tools.setKicadProperty(filePath, ref, key, value);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 7. KiCad: runErc
    mcp.tool(
      'runErc',
      'Run KiCad Electrical Rules Check (ERC) via kicad-cli.',
      { filePath: z.string().describe('Path to the .kicad_sch file inside workspace') },
      async ({ filePath }) => {
        const res = await tools.runErc(filePath);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 8. KiCad: simulateKicad
    mcp.tool(
      'simulateKicad',
      'Simulate KiCad schematic in LTspice and return compact summary.',
      { filePath: z.string().describe('Path to the .kicad_sch file inside workspace') },
      async ({ filePath }) => {
        const res = await tools.simulateKicad(filePath);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 9. MATLAB: runMatlabScript
    mcp.tool(
      'runMatlabScript',
      'Run a MATLAB script (*.m) inside workspace through the bridge.',
      { filePath: z.string().describe('Path to the .m script inside workspace') },
      async ({ filePath }) => {
        const res = await tools.runMatlabScript(filePath);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 10. Simulink: getSimulinkModel
    mcp.tool(
      'getSimulinkModel',
      'Get block diagram structure of a Simulink model (*.slx).',
      { filePath: z.string().describe('Path to the .slx file inside workspace') },
      async ({ filePath }) => {
        const res = await tools.getSimulinkModel(filePath);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 11. Simulink: setBlockParam
    mcp.tool(
      'setBlockParam',
      'Set Simulink block parameter, re-simulates, and updates the open editor.',
      {
        filePath: z.string().describe('Path to the .slx file inside workspace'),
        block: z.string().describe('Block name/path (e.g. Gain)'),
        param: z.string().describe('Parameter name (e.g. Gain)'),
        value: z.union([z.string(), z.number()]).describe('New parameter value'),
      },
      async ({ filePath, block, param, value }) => {
        const res = await tools.setBlockParam(filePath, block, param, value);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 12. Simulink: connectBlocks
    mcp.tool(
      'connectBlocks',
      'Connect two Simulink block ports.',
      {
        filePath: z.string().describe('Path to the .slx file inside workspace'),
        src: z.string().describe('Source port (e.g. Source/1)'),
        dst: z.string().describe('Destination port (e.g. Scope/1)'),
      },
      async ({ filePath, src, dst }) => {
        const res = await tools.connectBlocks(filePath, src, dst);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 13. Simulink: simulateModel
    mcp.tool(
      'simulateModel',
      'Simulate Simulink model and return compact summary with waveforms.',
      {
        filePath: z.string().describe('Path to the .slx file inside workspace'),
        stopTime: z.union([z.number(), z.string()]).optional().describe('Stop time in seconds'),
      },
      async ({ filePath, stopTime }) => {
        const res = await tools.simulateModel(filePath, stopTime);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 14. Waveform downsampling
    mcp.tool(
      'getWaveform',
      'Get downsampled waveform data (default 200 points) for an analog or digital signal.',
      {
        filePath: z.string().describe('Path to the simulation file inside workspace'),
        signal: z.string().describe('Signal name (e.g. V(out))'),
        maxPoints: z.number().optional().default(200).describe('Maximum points to return'),
      },
      async ({ filePath, signal, maxPoints }) => {
        const res = await tools.getWaveform(filePath, signal, maxPoints);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 15. Undo
    mcp.tool(
      'undoAgentChange',
      'Undo the last agent change on a file, restoring exact prior state and re-simulating.',
      { filePath: z.string().describe('Path to the file inside workspace') },
      async ({ filePath }) => {
        const success = await tools.undoAgentChange(filePath);
        return { content: [{ type: 'text', text: JSON.stringify({ success }) }] };
      }
    );

    // 16. Schematic: createSchematic
    mcp.tool(
      'createSchematic',
      'Create a new empty schematic file (.asc or .kicad_sch) and open it in the editor.',
      { filePath: z.string().describe('Path to the schematic file inside workspace') },
      async ({ filePath }) => {
        const res = await tools.createSchematic(filePath);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 17. Schematic: addComponent
    mcp.tool(
      'addComponent',
      'Add a component (R, C, L, V, I, D, NPN, PNP, NMOS, PMOS, opamp, GND) to schematic without coordinates.',
      {
        filePath: z.string().describe('Path to the schematic file inside workspace'),
        type: z.string().describe('Component type (e.g. R, C, V, opamp, GND)'),
        value: z.string().describe('Component value or model (e.g. 10k, 100n, 12, SINE(0 1 1k))'),
        near: z.string().optional().describe('Optional reference designator to place near (e.g. R1)'),
      },
      async ({ filePath, type, value, near }) => {
        const res = await tools.addComponent(filePath, type, value, near);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 18. Schematic: connect
    mcp.tool(
      'connect',
      'Connect two pins orthogonally (e.g. R1.1 to C1.1, U1.out to R2.1).',
      {
        filePath: z.string().describe('Path to the schematic file inside workspace'),
        pinA: z.string().describe('First pin address (e.g. R1.1, V1.+, U1.out)'),
        pinB: z.string().describe('Second pin address (e.g. C1.1, GND1.0, U1.in-)'),
      },
      async ({ filePath, pinA, pinB }) => {
        const res = await tools.connect(filePath, pinA, pinB);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 19. Schematic: removeComponent
    mcp.tool(
      'removeComponent',
      'Remove a component and its associated wires from schematic.',
      {
        filePath: z.string().describe('Path to the schematic file inside workspace'),
        ref: z.string().describe('Reference designator (e.g. R1, C2, U1)'),
      },
      async ({ filePath, ref }) => {
        const res = await tools.removeComponent(filePath, ref);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 20. Schematic: addDirective
    mcp.tool(
      'addDirective',
      'Add a SPICE simulation directive to schematic (e.g. .tran 5m, .ac dec 50 10 1meg).',
      {
        filePath: z.string().describe('Path to the schematic file inside workspace'),
        text: z.string().describe('SPICE directive text (e.g. .tran 10m, .ac dec 20 1 100k)'),
      },
      async ({ filePath, text }) => {
        const res = await tools.addDirective(filePath, text);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 21. Simulink: createModel
    mcp.tool(
      'createModel',
      'Create a new Simulink model (.slx) in workspace and open in visual editor.',
      { filePath: z.string().describe('Path to the .slx file inside workspace') },
      async ({ filePath }) => {
        const res = await tools.createModel(filePath);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 22. Simulink: addBlock
    mcp.tool(
      'addBlock',
      'Add a library block to Simulink model (validated against allowed library whitelist).',
      {
        filePath: z.string().describe('Path to the .slx file inside workspace'),
        libraryPath: z.string().describe('Library block path (e.g. simulink/Continuous/Integrator, simulink/Sources/Step)'),
        name: z.string().describe('Block name in model'),
        params: z.record(z.string(), z.string()).optional().describe('Initial block parameters'),
      },
      async ({ filePath, libraryPath, name, params }) => {
        const res = await tools.addBlock(filePath, libraryPath, name, params);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 23. Simulink: removeBlock
    mcp.tool(
      'removeBlock',
      'Delete a block from Simulink model.',
      {
        filePath: z.string().describe('Path to the .slx file inside workspace'),
        name: z.string().describe('Block name in model'),
      },
      async ({ filePath, name }) => {
        const res = await tools.removeBlock(filePath, name);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 24. Simulink: autoLayout
    mcp.tool(
      'autoLayout',
      'Auto-arrange block diagram layout cleanly in Simulink model.',
      { filePath: z.string().describe('Path to the .slx file inside workspace') },
      async ({ filePath }) => {
        const res = await tools.autoLayout(filePath);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 25. Spec: checkSpec
    mcp.tool(
      'checkSpec',
      'Simulate design and evaluate against engineering performance specifications (cutoff, overshoot, rise time, ripple).',
      {
        filePath: z.string().describe('Path to schematic or model inside workspace'),
        spec: z.object({
          signal: z.string().optional(),
          cutoff_hz: z.object({ target: z.number().optional(), tol_pct: z.number().optional(), min: z.number().optional(), max: z.number().optional() }).optional(),
          overshoot_pct: z.object({ target: z.number().optional(), tol_pct: z.number().optional(), min: z.number().optional(), max: z.number().optional() }).optional(),
          rise_time_s: z.object({ target: z.number().optional(), tol_pct: z.number().optional(), min: z.number().optional(), max: z.number().optional() }).optional(),
          settling_time_s: z.object({ target: z.number().optional(), tol_pct: z.number().optional(), min: z.number().optional(), max: z.number().optional() }).optional(),
          ripple_v: z.object({ target: z.number().optional(), tol_pct: z.number().optional(), min: z.number().optional(), max: z.number().optional() }).optional(),
          ripple_mv: z.object({ target: z.number().optional(), tol_pct: z.number().optional(), min: z.number().optional(), max: z.number().optional() }).optional(),
          final_value: z.object({ target: z.number().optional(), tol_pct: z.number().optional(), min: z.number().optional(), max: z.number().optional() }).optional(),
        }).describe('Engineering specification JSON object'),
      },
      async ({ filePath, spec }) => {
        const res = await tools.checkSpec(filePath, spec);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // 26. Optimization: tune
    mcp.tool(
      'tune',
      'Tune component values or model parameters to satisfy specification within iteration budget (with live updates and single undo).',
      {
        filePath: z.string().describe('Path to file inside workspace'),
        params: z.array(z.object({
          name: z.string().describe('Component or block parameter name'),
          min: z.number().describe('Minimum allowable value'),
          max: z.number().describe('Maximum allowable value'),
          initial: z.number().optional(),
          snapE24: z.boolean().optional(),
        })).describe('List of tunable parameters with bounds'),
        spec: z.any().describe('Target engineering specification'),
        maxIterations: z.number().optional().default(20).describe('Maximum tuning iterations'),
      },
      async ({ filePath, params, spec, maxIterations }) => {
        const res = await tools.tune(filePath, params, spec, maxIterations);
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }
    );

    // Register with vscode.lm if available
    this.registerLmTools();
  }

  private registerLmTools() {
    const lm = (vscode as any).lm;
    if (typeof lm?.registerTool === 'function') {
      try {
        lm.registerTool('eide_listOpenDesigns', {
          async invoke() {
            return new (vscode as any).LanguageModelToolResult([
              new (vscode as any).LanguageModelTextPart(JSON.stringify(tools.listOpenDesigns())),
            ]);
          },
        });
      } catch {}
    }
  }

  public async stop(): Promise<void> {
    for (const s of this.sessions.values()) {
      try {
        await s.transport.close();
      } catch {}
    }
    this.sessions.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }
}
