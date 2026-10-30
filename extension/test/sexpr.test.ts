import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  escapeString,
  findChildList,
  findChildLists,
  getAtomAt,
  getListTag,
  parseSExpr,
  printSExpr,
  quoteString,
  SExprAtom,
} from '../src/kicad/sexpr';

test('parses atoms, numbers, and quoted strings with escapes', () => {
  const source = '(test 123 -45.67 "hello \\"world\\"\\n" unquoted_sym)';
  const ast = parseSExpr(source);

  assert.equal(ast.type, 'list');
  assert.equal(ast.children.length, 5);
  assert.equal((ast.children[0] as SExprAtom).value, 'test');
  assert.equal((ast.children[1] as SExprAtom).value, '123');
  assert.equal((ast.children[2] as SExprAtom).value, '-45.67');
  assert.equal((ast.children[3] as SExprAtom).value, 'hello "world"\n');
  assert.equal((ast.children[3] as SExprAtom).isQuoted, true);
  assert.equal((ast.children[4] as SExprAtom).value, 'unquoted_sym');
  assert.equal((ast.children[4] as SExprAtom).isQuoted, false);
});

test('tracks source positions accurately', () => {
  const source = '  (property "Reference" "R1" (at 10 20 0))  ';
  const ast = parseSExpr(source);

  assert.equal(ast.start, 2);
  assert.equal(ast.end, 42);
  assert.equal(source.slice(ast.start, ast.end), '(property "Reference" "R1" (at 10 20 0))');

  const refVal = ast.children[2] as SExprAtom;
  assert.equal(refVal.value, 'R1');
  assert.equal(source.slice(refVal.start, refVal.end), '"R1"');
});

test('round-trip keeps source text byte-identical', () => {
  const source = `(kicad_sch
	(version 20250610)
	(generator "eeschema")
	(uuid "965d9afc-0787-45ba-b7bc-21944b47b74d")
	(paper "A4")
	(symbol
		(lib_id "Device:R")
		(at 100 100 0)
		(property "Reference" "R1"
			(at 100 95 0)
			(effects (font (size 1.27 1.27)))
		)
		(property "Value" "10k"
			(at 100 105 0)
			(effects (font (size 1.27 1.27)))
		)
	)
)`;

  const ast = parseSExpr(source);
  const printed = printSExpr(ast, source);
  assert.equal(printed, source);
});

test('AST helpers findChildList and findChildLists work correctly', () => {
  const source = `(root
    (item (id 1))
    (item (id 2))
    (other (val 3))
  )`;
  const ast = parseSExpr(source);

  assert.equal(getListTag(ast), 'root');
  const items = findChildLists(ast, 'item');
  assert.equal(items.length, 2);
  assert.equal(findChildList(ast, 'other') !== undefined, true);
  assert.equal(findChildList(ast, 'missing'), undefined);
});
