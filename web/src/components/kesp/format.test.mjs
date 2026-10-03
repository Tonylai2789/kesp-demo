import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fmtDur } from './format.ts';
import { redactKespDemoText, resetKespDemoRedactionState } from '../../lib/kespDemoRedaction.ts';

test('durations use whole elapsed minutes and seconds, including fractional boundaries', () => {
  for (const [seconds, expected] of [
    [0, '0:00'], [0.99, '0:00'], [9.9, '0:09'], [59.999, '0:59'],
    [60, '1:00'], [60.999, '1:00'], [133.123456789, '2:13'],
    [3599.999, '59:59'], [3600, '60:00'],
  ]) assert.equal(fmtDur(seconds), expected);
});

test('invalid, negative and unsafe durations use the unavailable placeholder', () => {
  for (const seconds of [NaN, Infinity, -Infinity, -1, -0.1, undefined, null, '133.5', Number.MAX_VALUE]) {
    assert.equal(fmtDur(seconds), '\u2014', String(seconds));
  }
});

test('fractional durations survive the unchanged demo redactor while identifiers stay masked', () => {
  resetKespDemoRedactionState();
  assert.equal(redactKespDemoText('2:13.123456789'), '2:13.*ID CLIENTE*');
  assert.equal(redactKespDemoText(fmtDur(133.123456789)), '2:13');
  assert.equal(redactKespDemoText('123456789'), '*ID CLIENTE*');
});

test('the actual Calls page uses the shared duration formatter', () => {
  const source = readFileSync(new URL('../../pages/kesp/LlamadasPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /import \{ fmtDur \} from '@\/components\/kesp\/format'/);
  assert.match(source, /<span>\{fmtDur\(c.duration\)\}<\/span>/);
});
