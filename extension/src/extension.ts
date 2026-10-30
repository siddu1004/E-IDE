import * as vscode from 'vscode';
import { AscEditorProvider } from './ltspice/ascEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(AscEditorProvider.viewType, new AscEditorProvider(context), {
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
  );
}

export function deactivate() {}
