import * as path from 'path';
import * as vscode from 'vscode';
import { AscEditorProvider } from './ltspice/ascEditorProvider';
import { exportSpiceNetlist, findKicadCli } from './kicad/kicadCli';
import { KicadEditorProvider } from './kicad/schEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  const ascProvider = new AscEditorProvider(context);
  const kicadProvider = new KicadEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(AscEditorProvider.viewType, ascProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerCustomEditorProvider(KicadEditorProvider.viewType, kicadProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
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
  );
}

export function deactivate() {}
