import * as path from 'path';
import * as vscode from 'vscode';
import { AscSchematic, diffSchematics, parseAsc, symbolAttrEdit } from './ascParser';

// Visual editor for .asc files. The text document stays the source of truth,
// so edits from the user, the agent, or LTspice itself all flow through it.
export class AscEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'eide.ltspiceSchematic';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webview.html = this.html(webview);

    let last: AscSchematic | undefined;
    const push = () => {
      const next = parseAsc(document.getText());
      const changes = diffSchematics(last, next);
      last = next;
      webview.postMessage({ type: 'update', schematic: next, changes, fileName: path.basename(document.fileName) });
    };

    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) push();
    });
    panel.onDidDispose(() => sub.dispose());

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case 'ready':
          push();
          break;
        case 'setAttr':
          await this.setAttr(document, String(msg.id), String(msg.key), String(msg.value));
          break;
        case 'openAsText':
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          break;
      }
    });
  }

  private async setAttr(document: vscode.TextDocument, id: string, key: string, value: string) {
    const edit = symbolAttrEdit(parseAsc(document.getText()), id, key, value);
    if (!edit) return;
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const we = new vscode.WorkspaceEdit();
    if (!edit.insert) {
      we.replace(document.uri, document.lineAt(edit.line).range, edit.text);
    } else if (edit.line < document.lineCount) {
      we.insert(document.uri, new vscode.Position(edit.line, 0), edit.text + eol);
    } else {
      we.insert(document.uri, document.lineAt(document.lineCount - 1).range.end, eol + edit.text);
    }
    await vscode.workspace.applyEdit(we);
  }

  private html(webview: vscode.Webview): string {
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${media('schematic.css')}" rel="stylesheet">
  <title>LTspice Schematic</title>
</head>
<body>
  <header>
    <span id="file-name"></span>
    <span id="banner"></span>
    <button id="as-text">Open as text</button>
  </header>
  <main>
    <svg id="canvas" xmlns="http://www.w3.org/2000/svg"></svg>
    <aside>
      <h2>Components</h2>
      <table id="components"><thead><tr><th>Name</th><th>Type</th><th>Value</th></tr></thead><tbody></tbody></table>
      <h2>Directives</h2>
      <ul id="directives"></ul>
    </aside>
  </main>
  <script nonce="${nonce}" src="${media('schematic.js')}"></script>
</body>
</html>`;
  }
}
