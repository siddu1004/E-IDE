// Agent tool surface for E-IDE.
// Exposes functions an AI agent can call directly or via an MCP server.
// All edits flow through VS Code's WorkspaceEdit so that they are live,
// undoable, and immediately visible in the open schematic editor.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AscSchematic, parseAsc, symbolAttrEdit } from '../ltspice/ascParser';
import { findLtspice, runLtspiceSimulation, SimulationRunResult } from '../ltspice/ltspiceRunner';

async function getDocument(filePath: string): Promise<vscode.TextDocument> {
  const uri = vscode.Uri.file(path.resolve(filePath));
  const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.toLowerCase() === uri.fsPath.toLowerCase());
  if (openDoc) return openDoc;
  return await vscode.workspace.openTextDocument(uri);
}

// 1. Get parsed schematic
export async function getSchematic(filePath: string): Promise<AscSchematic> {
  const doc = await getDocument(filePath);
  return parseAsc(doc.getText());
}

// 2. Set component value (flows through WorkspaceEdit so open editors update live)
export async function setComponentValue(filePath: string, id: string, value: string): Promise<boolean> {
  const doc = await getDocument(filePath);
  const schematic = parseAsc(doc.getText());
  const edit = symbolAttrEdit(schematic, id, 'Value', value);
  if (!edit) {
    throw new Error(`Symbol '${id}' not found in ${filePath} or invalid attribute`);
  }

  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const we = new vscode.WorkspaceEdit();

  if (!edit.insert) {
    we.replace(doc.uri, doc.lineAt(edit.line).range, edit.text);
  } else if (edit.line < doc.lineCount) {
    we.insert(doc.uri, new vscode.Position(edit.line, 0), edit.text + eol);
  } else {
    we.insert(doc.uri, doc.lineAt(doc.lineCount - 1).range.end, eol + edit.text);
  }

  const success = await vscode.workspace.applyEdit(we);
  return success;
}

// 3. Run LTspice simulation
export async function runSimulation(filePath: string): Promise<SimulationRunResult> {
  const config = vscode.workspace.getConfiguration('eide.ltspice');
  const customPath = config.get<string>('path');
  const timeoutSec = config.get<number>('timeout', 60);

  const exe = findLtspice(customPath);
  if (!exe) {
    throw new Error('LTspice executable not found. Please set eide.ltspice.path in settings.');
  }

  const doc = await getDocument(filePath);
  const ascContent = doc.getText();

  return await runLtspiceSimulation({
    executablePath: exe,
    ascPath: doc.uri.fsPath,
    ascContent,
    timeoutMs: timeoutSec * 1000,
  });
}

// 4. Get simulation measurements (.meas results from LTspice log)
export async function getMeasurements(filePath: string): Promise<Record<string, number>> {
  const result = await runSimulation(filePath);
  return result.log.measurements;
}

