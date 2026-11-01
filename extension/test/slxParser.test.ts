import { describe, it, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parseSlx, diffSlxModels, readZipEntries, parseSystemXml, portPosition, parseBinding, parseGaugeBounds } from '../src/simulink/slxParser';

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

describe('slxParser line routing, annotations, and ports', () => {
  // Shape taken from a real R2025 model: a branch that itself branches, Points as relative offsets.
  const xml = `
  <Block BlockType="Constant" Name="Src" SID="1"><P Name="Position">[0, 40, 20, 60]</P></Block>
  <Block BlockType="Gain" Name="A" SID="2"><P Name="Position">[100, 0, 120, 20]</P></Block>
  <Block BlockType="SubSystem" Name="B" SID="3"><PortCounts in="2" out="1"/><P Name="Position">[100, 80, 140, 120]</P></Block>
  <Block BlockType="Gain" Name="C" SID="4"><P Name="Position">[100, 140, 120, 160]</P><P Name="BlockRotation">90</P></Block>
  <Line>
    <P Name="Src">1#out:1</P>
    <P Name="Points">[40, 0]</P>
    <Branch>
      <P Name="Points">[0, -40]</P>
      <Branch>
        <P Name="Points">[20, 0]</P>
        <P Name="Dst">2#in:1</P>
      </Branch>
      <Branch>
        <P Name="Points">[0, -5]</P>
        <P Name="Dst">3#in:1</P>
      </Branch>
    </Branch>
    <Branch>
      <P Name="Points">[0, 40]</P>
      <P Name="Dst">3#in:2</P>
    </Branch>
  </Line>
  <Annotation SID="9">
    <P Name="Name">LIVE PV DASHBOARD &amp; notes</P>
    <P Name="Position">[-290, -150, 185, -130]</P>
    <P Name="FontSize">16</P>
    <P Name="FontWeight">bold</P>
  </Annotation>`;
  const sys = parseSystemXml(xml);

  it('keeps every destination of nested branches', () => {
    assert.deepEqual(sys.lines.map((l) => `${l.dst!.sid}:${l.dst!.portNumber}`).sort(), ['2:1', '3:1', '3:2']);
  });

  it('routes along the saved points from the source port to the destination port', () => {
    const toA = sys.lines.find((l) => l.dst!.sid === '2')!;
    assert.deepEqual(toA.points, [
      { x: 20, y: 50 },
      { x: 60, y: 50 },
      { x: 60, y: 10 },
      { x: 80, y: 10 },
      { x: 100, y: 10 },
    ]);
    const toB2 = sys.lines.find((l) => l.dst!.sid === '3' && l.dst!.portNumber === 2)!;
    assert.deepEqual(toB2.points!.slice(-1)[0], { x: 100, y: 110 });
  });

  it('reads PortCounts and annotations', () => {
    assert.deepEqual(sys.blocks.find((b) => b.sid === '3')!.ports, { in: 2, out: 1, lconn: 0, rconn: 0 });
    assert.equal(sys.annotations!.length, 1);
    assert.equal(sys.annotations![0].text, 'LIVE PV DASHBOARD & notes');
    assert.equal(sys.annotations![0].bold, true);
    assert.equal(sys.annotations![0].fontSize, 16);
  });

  it('moves ports with block rotation', () => {
    const c = sys.blocks.find((b) => b.sid === '4')!;
    assert.equal(c.rotation, 90);
    assert.deepEqual(portPosition(c, 'in', 1), { x: 110, y: 140 });
    assert.deepEqual(portPosition(c, 'out', 1), { x: 110, y: 160 });
  });
});

test('parseBinding reads the bound block, SID and signal from a BindingPersistence object', () => {
  const buf = Buffer.concat([
    Buffer.from('MCOS\0\0SignalName_\0\x01\x02'),
    Buffer.from('16d1f318-b2b4-42e0-ba20-56dc3af52ce0\0Stage4_Output_Conditioning\0' + '95\0P_pv (W)\0BlockPath_\0'),
  ]);
  assert.deepEqual(parseBinding(buf), { source: 'Stage4_Output_Conditioning', sid: '95', signal: 'P_pv (W)' });
  assert.equal(parseBinding(Buffer.from('no digits here')), undefined);
});

test('parseGaugeBounds reads scale limits in any key order', () => {
  assert.deepEqual(parseGaugeBounds('{"components":[{"settings":{"bounds":{"max":15,"min":0,"tickInterval":"auto"}}}]}'), { min: 0, max: 15 });
  assert.deepEqual(parseGaugeBounds('{"bounds":{"min":-2.5,"max":1e3}}'), { min: -2.5, max: 1000 });
  assert.equal(parseGaugeBounds('{"bounds":{"min":5,"max":5}}'), undefined);
  assert.equal(parseGaugeBounds(undefined), undefined);
});
