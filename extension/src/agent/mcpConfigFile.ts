// Keeps the "eide" entry in Antigravity's mcp_config.json pointing at this session's
// server. Port and token change every launch, so copying them by hand goes stale.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const SERVER_NAME = 'eide';

export function defaultConfigPath(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json');
}

export function mcpEntry(port: number, token: string) {
  const url = `http://127.0.0.1:${port}/mcp`;
  // Antigravity reads serverUrl for HTTP servers; other clients read url.
  return { serverUrl: url, url, headers: { Authorization: `Bearer ${token}` } };
}

// Returns the new file text with only our entry changed; other servers are left untouched.
export function upsertServer(text: string, entry: object): string {
  const config = text.trim() ? JSON.parse(text) : {};
  config.mcpServers = { ...(config.mcpServers ?? {}), [SERVER_NAME]: entry };
  return JSON.stringify(config, null, 2) + '\n';
}

export function removeServer(text: string): string {
  const config = JSON.parse(text);
  if (config.mcpServers) delete config.mcpServers[SERVER_NAME];
  return JSON.stringify(config, null, 2) + '\n';
}

export function registerInFile(file: string, port: number, token: string): void {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, upsertServer(text, mcpEntry(port, token)));
}

export function unregisterInFile(file: string): void {
  if (!fs.existsSync(file)) return;
  fs.writeFileSync(file, removeServer(fs.readFileSync(file, 'utf8')));
}
