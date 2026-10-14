// Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { toBlocks, inline, splitPages, toPlainText, buildMobi, epubFiles } from './core.js';

test('paragraph continued across a page joins, and its footnote waits until it closes', () => {
  const pages = ['# Unu\n\nLa hundo kuris tra la ⟦↪⟧\n\n[nota] Noto pri hundo.', '⟦↩⟧parko kaj bojis.\n\nNova alineo.'];
  assert.deepEqual(toBlocks(pages), [
    { type: 'h2', text: 'Unu' },
    { type: 'p', text: 'La hundo kuris tra la parko kaj bojis.' },
    { type: 'note', text: 'Noto pri hundo.' },
    { type: 'p', text: 'Nova alineo.' },
  ]);
});

test('a word split across pages joins without a space', () => {
  assert.equal(toBlocks(['Ŝi ven⟦↪⟧', '⟦↩⟧is hejmen.'])[0].text, 'Ŝi venis hejmen.');
});

test('unpaired markers are dropped, Parto headings are h1, asterisk lines are scene breaks', () => {
  assert.deepEqual(toBlocks(['# Parto 1\n\n* * *\n\nFino ⟦↪⟧', 'Ne daŭrigo.']).map(b => [b.type, b.text]),
    [['h1', 'Parto 1'], ['hr', ''], ['p', 'Fino'], ['p', 'Ne daŭrigo.']]);
});

test('emphasis converts only when balanced; output never has stray asterisks or raw <', () => {
  assert.equal(inline('**forte** kaj *kursive* <x>'), '<b>forte</b> kaj <i>kursive</i> &lt;x&gt;');
  assert.equal(inline('*nefermita kaj **forte**'), 'nefermita kaj forte');
  assert.equal(inline('**a *b** c*'), 'a b c');
  assert.equal(inline('**a *b* c**'), '<b>a <i>b</i> c</b>');
  for (const s of ['*', '**', '***', 'a*b**c', '****x', '**a *b** c*', '*a **b* c**']) {
    const h = inline(s);
    assert.ok(!h.includes('*'), s);
    const tags = [...h.matchAll(/<(\/?)(b|i)>/g)], st = [];
    for (const [, close, t] of tags) close ? assert.equal(st.pop(), t, s) : st.push(t);
    assert.equal(st.length, 0, s);
  }
});

test('splitPages makes exactly n pages and loses no text', () => {
  const text = Array.from({ length: 200 }, (_, i) => 'linio ' + i).join('\n');
  for (const n of [1, 3, 7, 50, 300]) {
    const p = splitPages(text, n);
    assert.equal(p.length, n);
    assert.equal(p.filter(x => x !== '').join('\n'), text);
  }
});

test('plain text has no markup left', () => {
  const t = toPlainText(['# Parto 1\n\n**Bold** ⟦↪⟧', '⟦↩⟧ *it*\n\n[nota] n']);
  assert.equal(t, 'PARTO 1\n\nBold it\n\n    n\n');
});

test('MOBI: PalmDB record table, text records under 4096 bytes, text round-trips', () => {
  const pages = Array.from({ length: 40 }, (_, i) => `# Ĉapitro ${i}\n\n` + 'Ĉu ŝi ĝojas? '.repeat(300));
  const b = buildMobi(pages, { title: 'Testo', author: 'A', lang: 'eo', time: 0 });
  const v = new DataView(b.buffer);
  assert.equal(new TextDecoder().decode(b.subarray(60, 68)), 'BOOKMOBI');
  const n = v.getUint16(76), off = i => v.getUint32(78 + 8 * i);
  const r0 = off(0), textLen = v.getUint32(r0 + 4), count = v.getUint16(r0 + 8);
  assert.equal(n, count + 2);
  assert.equal(new TextDecoder().decode(b.subarray(r0 + 16, r0 + 20)), 'MOBI');
  const parts = [];
  for (let i = 1; i <= count; i++) { assert.ok(off(i + 1) - off(i) <= 4096); parts.push(b.subarray(off(i), off(i + 1))); }
  const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let p = 0;
  for (const x of parts) { all.set(x, p); p += x.length; }
  assert.equal(all.length, textLen);
  const html = new TextDecoder('utf-8', { fatal: true }).decode(all);
  assert.match(html, /^<html>.*<h2>Ĉapitro 39<\/h2>.*<\/html>$/s);
  assert.deepEqual([...b.subarray(off(n - 1))], [0xe9, 0x8e, 0x0d, 0x0a]);
});

test('EPUB: one section per heading, manifest lists every section', () => {
  const f = epubFiles(['Antaŭparolo.\n\n# Unu\n\nA.\n\n# Du\n\nB.'], { title: 'T', author: 'A', uuid: '00000000-0000-0000-0000-000000000000', modified: '2026-01-01T00:00:00Z' });
  const secs = Object.keys(f).filter(k => /s\d+\.xhtml$/.test(k));
  assert.equal(secs.length, 3);
  for (const s of secs) assert.ok(f['OEBPS/content.opf'].includes(s.slice(6)));
  assert.match(f['OEBPS/nav.xhtml'], /<a href="s0001.xhtml">Unu<\/a>/);
});
