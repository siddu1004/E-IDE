import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parseSlx, diffSlxModels, readZipEntries } from '../src/simulink/slxParser';

describe('slxParser with real R2026a Simulink fixture', () => {
  const fixturePath = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'simulink', 'rc_circuit.slx');

  it('reads zip entries using pure Node extractor', () => {
    const buf = fs.readFileSync(fixturePath);
    const entries = readZipEntries(buf);
    assert.ok(entries['simulink/blockdiagram.xml']);
    assert.ok(entries['simulink/systems/system_root.xml']);
    assert.ok(entries['[Content_Types].xml']);
  });

  it('extracts blocks with positions, types, and parameters', () => {
    const buf = fs.readFileSync(fixturePath);
    const model = parseSlx(buf, 'rc_circuit');

    assert.equal(model.name, 'rc_circuit');
    assert.ok(model.uuid);
    assert.equal(model.rootSystem.blocks.length, 4);

    const stepBlock = model.rootSystem.blocks.find(b => b.name === 'Step');
    assert.ok(stepBlock);
    assert.equal(stepBlock.type, 'Step');
    assert.equal(stepBlock.sid, '1');
    assert.deepEqual(stepBlock.position, { left: 50, top: 100, right: 80, bottom: 130 });

    const filterBlock = model.rootSystem.blocks.find(b => b.name === 'RC_Filter');
    assert.ok(filterBlock);
    assert.equal(filterBlock.type, 'TransferFcn');
    assert.equal(filterBlock.sid, '2');
    assert.equal(filterBlock.parameters['Denominator'], '[0.1 1]');
  });

  it('extracts signal lines including branch connections', () => {
    const buf = fs.readFileSync(fixturePath);
    const model = parseSlx(buf, 'rc_circuit');

    // Expected lines:
    // 1. Step (1#out:1) -> RC_Filter (2#in:1)
    // 2. RC_Filter (2#out:1) -> Scope (3#in:1)
    // 3. RC_Filter (2#out:1) -> Out1 (4#in:1)
    assert.equal(model.rootSystem.lines.length, 3);

    const line1 = model.rootSystem.lines.find(l => l.src?.sid === '1' && l.dst?.sid === '2');
    assert.ok(line1);

    const branchScope = model.rootSystem.lines.find(l => l.src?.sid === '2' && l.dst?.sid === '3');
    assert.ok(branchScope);

    const branchOut = model.rootSystem.lines.find(l => l.src?.sid === '2' && l.dst?.sid === '4');
    assert.ok(branchOut);
  });

  it('computes diffs when block parameters or connections change', () => {
    const buf = fs.readFileSync(fixturePath);
    const orig = parseSlx(buf, 'rc_circuit');

    // Clone and mutate model
    const modified = JSON.parse(JSON.stringify(orig));
    const filter = modified.rootSystem.blocks.find((b: any) => b.name === 'RC_Filter');
    filter.parameters['Denominator'] = '[0.2 1]';

    const diff = diffSlxModels(orig, modified);
    assert.deepEqual(diff.changedBlockSids, ['2']);
    assert.equal(diff.addedBlockSids.length, 0);
    assert.equal(diff.removedBlockSids.length, 0);
  });
});
