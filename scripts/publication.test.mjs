import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { checkPublication, digest, words } from './check-publication.mjs';

const synthetic = 'fictional violet telescope measures twelve imaginary planets across a synthetic testing universe';
const manifest = { version: 1, windowWords: 8, fileHashes: [digest('synthetic whole file')],
  textHashes: [digest(words(synthetic).slice(0, 8).join(' '))] };

test('publication scanner catches renamed private content in source, fixtures and built assets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-test-'));
  try {
    for (const filename of ['source.ts', 'fixture.test.mjs', 'dist/assets/chunk.js']) {
      fs.mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
      fs.writeFileSync(path.join(root, filename), 'const text = "' + synthetic + '";');
    }
    assert.equal(checkPublication(root, manifest).length, 3);
    fs.writeFileSync(path.join(root, 'source.ts'), 'synthetic whole file');
    assert.ok(checkPublication(root, manifest).some(item => item.reason === 'Exact private file fingerprint'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('publication scanner accepts generic code but rejects prompt assets and incomplete manifests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-test-'));
  try {
    fs.writeFileSync(path.join(root, 'generic.ts'), 'export interface Result { score: number }');
    assert.deepEqual(checkPublication(root, manifest), []);
    fs.writeFileSync(path.join(root, 'promptsubagent-example-v1.md'), 'placeholder');
    assert.equal(checkPublication(root, manifest)[0].reason, 'Private prompt asset filename');
    assert.throws(() => checkPublication(root, { ...manifest, textHashes: [] }), /Invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('public backend preflight fails explicitly before compilation or deletion', () => {
  const result = spawnSync(process.execPath, [new URL('./require-private-assets.mjs', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing private evaluation assets/);
  const pkg = JSON.parse(fs.readFileSync(new URL('../web/functions/package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.scripts.build.startsWith('node ../../scripts/require-private-assets.mjs && '));
});

test('publication CLI fails closed without an external manifest', () => {
  const result = spawnSync(process.execPath, [new URL('./check-publication.mjs', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /external private fingerprint manifest/);
});
