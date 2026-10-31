import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { mcpEntry, registerInFile, removeServer, unregisterInFile, upsertServer } from '../src/agent/mcpConfigFile';

test('upsertServer adds eide and keeps other servers', () => {
  const before = JSON.stringify({ mcpServers: { sfp: { command: 'python', args: ['x.py'] } } });
  const after = JSON.parse(upsertServer(before, mcpEntry(5000, 'abc')));
  assert.deepEqual(after.mcpServers.sfp, { command: 'python', args: ['x.py'] });
  assert.equal(after.mcpServers.eide.serverUrl, 'http://127.0.0.1:5000/mcp');
  assert.equal(after.mcpServers.eide.headers.Authorization, 'Bearer abc');
});

test('upsertServer replaces a stale eide entry and handles an empty file', () => {
  const stale = upsertServer('', mcpEntry(1, 'old'));
  const fresh = JSON.parse(upsertServer(stale, mcpEntry(2, 'new')));
  assert.equal(fresh.mcpServers.eide.url, 'http://127.0.0.1:2/mcp');
  assert.equal(Object.keys(fresh.mcpServers).length, 1);
});

test('removeServer drops only eide', () => {
  const text = upsertServer(JSON.stringify({ mcpServers: { sfp: {} } }), mcpEntry(1, 't'));
  assert.deepEqual(JSON.parse(removeServer(text)).mcpServers, { sfp: {} });
});

test('registerInFile and unregisterInFile round-trip on disk', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eide-mcp-')), 'sub', 'mcp_config.json');
  registerInFile(file, 4242, 'tok');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.eide.url, 'http://127.0.0.1:4242/mcp');
  unregisterInFile(file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers, {});
});
