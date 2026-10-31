import * as path from 'path';
import * as vscode from 'vscode';
import { defaultConfigPath, registerInFile, unregisterInFile } from './agent/mcpConfigFile';
import { EidMcpServer } from './agent/mcpServer';
import { listOpenDesigns, setMatlabBridge, undoAgentChange } from './agent/tools';
import { exportSpiceNetlist, findKicadCli } from './kicad/kicadCli';
import { KicadEditorProvider } from './kicad/schEditorProvider';
import { AscEditorProvider } from './ltspice/ascEditorProvider';
import { MatlabBridge, BridgeStatus } from './matlab/matlabBridge';
import { findMatlab } from './matlab/matlabFinder';
import { MatlabScriptRunner } from './matlab/matlabScriptRunner';
import { SlxEditorProvider } from './simulink/slxEditorProvider';

let activeMatlabBridge: MatlabBridge | undefined;
let activeMcpServer: EidMcpServer | undefined;
let registeredMcpConfig = false;

export function activate(context: vscode.ExtensionContext) {
  // 1. Editors
  const ascProvider = new AscEditorProvider(context);
  const kicadProvider = new KicadEditorProvider(context);

  // 2. Discover MATLAB
  const matlabConfig = vscode.workspace.getConfiguration('eide.matlab');
  const customMatlabPath = matlabConfig.get<string>('path');
  const matlabPath = findMatlab({ customPath: customMatlabPath });

  const bridge = new MatlabBridge({
    matlabPath,
    bridgeScriptDir: path.join(context.extensionPath, 'matlab'),
  });
  activeMatlabBridge = bridge;
  setMatlabBridge(bridge);

  const slxProvider = new SlxEditorProvider(context, bridge);
  const scriptRunner = new MatlabScriptRunner(context, bridge);

  // 3. MCP Server inside extension
  const mcpServer = new EidMcpServer(context);
  activeMcpServer = mcpServer;
  // Point Antigravity at this session's port and token so the agent finds E-IDE without copy-paste.
  const autoRegister = () =>
    process.env.EIDE_TEST !== '1' &&
    vscode.workspace.getConfiguration('eide.agent').get<boolean>('autoRegister', true);
  mcpServer.start().then((port) => {
    if (!autoRegister()) return;
    try {
      registerInFile(defaultConfigPath(), port, mcpServer.getToken());
      registeredMcpConfig = true;
    } catch (err: any) {
      vscode.window.showWarningMessage(`E-IDE could not update Antigravity's MCP config: ${err.message}`);
    }
  }).catch((err) => {
    vscode.window.showErrorMessage(`Failed to start E-IDE MCP server: ${err.message}`);
  });

  // 3. Status Bar Item for MATLAB
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'eide.toggleMatlabBridge';

  function updateStatusBar(status: BridgeStatus) {
    switch (status) {
      case 'off':
        statusBar.text = '$(circle-slash) MATLAB: off';
        statusBar.tooltip = 'Click to start persistent MATLAB bridge session';
        break;
      case 'starting':
        statusBar.text = '$(loading~spin) MATLAB: starting';
        statusBar.tooltip = 'MATLAB session is launching...';
        break;
      case 'ready':
        statusBar.text = '$(check) MATLAB: ready';
        statusBar.tooltip = 'MATLAB bridge is active. Click to stop session.';
        break;
      case 'busy':
        statusBar.text = '$(sync~spin) MATLAB: busy';
        statusBar.tooltip = 'Executing MATLAB / Simulink command...';
        break;
    }
    statusBar.show();
  }

  updateStatusBar(bridge.getStatus());
  bridge.onStatusChange(updateStatusBar);
  context.subscriptions.push(statusBar);

  // 4. Register Providers and Commands
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(AscEditorProvider.viewType, ascProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerCustomEditorProvider(KicadEditorProvider.viewType, kicadProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerCustomEditorProvider(SlxEditorProvider.viewType, slxProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.languages.registerCodeLensProvider({ pattern: '**/*.m' }, scriptRunner),

    vscode.commands.registerCommand('eide.openAsText', async () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (input instanceof vscode.TabInputCustom) {
        await vscode.commands.executeCommand('vscode.openWith', input.uri, 'default');
      }
    }),
    vscode.commands.registerCommand('eide.runSimulation', () => {
      AscEditorProvider.runSimulationOnActive();
    }),
    vscode.commands.registerCommand('eide.runKicadErc', () => {
      KicadEditorProvider.runErcOnActive();
    }),
    vscode.commands.registerCommand('eide.simulateKicad', () => {
      KicadEditorProvider.runSimulationOnActive();
    }),
    vscode.commands.registerCommand('eide.runMatlabScript', async (uri?: vscode.Uri) => {
      await scriptRunner.runScript(uri);
    }),
    vscode.commands.registerCommand('eide.simulateSimulink', async () => {
      if (SlxEditorProvider.activeEditor) {
        await SlxEditorProvider.activeEditor.simulate();
      } else {
        vscode.window.showInformationMessage('No active Simulink editor found.');
      }
    }),
    vscode.commands.registerCommand('eide.toggleMatlabBridge', async () => {
      const status = bridge.getStatus();
      if (status === 'off') {
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Starting MATLAB persistent bridge...',
              cancellable: false,
            },
            async () => {
              await bridge.start();
            }
          );
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to start MATLAB bridge: ${err.message}`);
        }
      } else {
        const confirm = await vscode.window.showQuickPick(['Stop MATLAB session', 'Keep running'], {
          placeHolder: 'MATLAB session is currently active. Stop session?',
        });
        if (confirm === 'Stop MATLAB session') {
          await bridge.stop();
        }
      }
    }),
    vscode.commands.registerCommand('eide.exportNetlist', async () => {
      const config = vscode.workspace.getConfiguration('eide.kicad');
      const cli = findKicadCli(config.get<string>('cliPath'));
      if (!cli) {
        vscode.window.showErrorMessage('kicad-cli not found. Please set eide.kicad.cliPath in settings.');
        return;
      }
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      let uri: vscode.Uri | undefined;
      if (activeTab?.input instanceof vscode.TabInputCustom) {
        uri = activeTab.input.uri;
      } else if (vscode.window.activeTextEditor) {
        uri = vscode.window.activeTextEditor.document.uri;
      }
      if (!uri || !uri.fsPath.endsWith('.kicad_sch')) {
        vscode.window.showWarningMessage('Please open a .kicad_sch file to export netlist.');
        return;
      }

      const res = await exportSpiceNetlist({
        cliPath: cli,
        schPath: uri.fsPath,
      });

      if (res.success && res.netlist) {
        const netDoc = await vscode.workspace.openTextDocument({
          content: res.netlist,
          language: 'spice',
        });
        await vscode.window.showTextDocument(netDoc, { preview: false });
        vscode.window.showInformationMessage(`SPICE netlist exported successfully for ${path.basename(uri.fsPath)}`);
      } else {
        vscode.window.showErrorMessage(`Netlist export failed: ${res.error}`);
      }
    }),
    vscode.commands.registerCommand('eide.copyMcpConfig', async () => {
      const server = activeMcpServer || EidMcpServer.getActiveInstance();
      if (server) {
        const start = Date.now();
        while (server.getPort() === 0 && Date.now() - start < 5000) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const configJson = server.getMcpConfigJson();
        await vscode.env.clipboard.writeText(configJson);
        vscode.window.showInformationMessage(
          'E-IDE MCP config copied to clipboard! Paste it into Antigravity mcp_config.json.'
        );
      }
    }),
    vscode.commands.registerCommand('eide.undoAgentChange', async (filePath?: string) => {
      let targetPath = filePath;
      if (!targetPath) {
        const openDesigns = listOpenDesigns();
        if (openDesigns.length > 0) targetPath = openDesigns[0].path;
      }
      if (targetPath) {
        await undoAgentChange(targetPath);
      }
    })
  );
}

export function deactivate() {
  if (registeredMcpConfig) {
    try { unregisterInFile(defaultConfigPath()); } catch { /* best effort on shutdown */ }
  }
  if (activeMcpServer) {
    activeMcpServer.stop();
  }
  if (activeMatlabBridge) {
    activeMatlabBridge.stop();
  }
}
