import { toPlainText, splitPages, epubFiles, printDoc, buildMobi, elementToMarkup } from './core.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['inPdf', 'inText', 'prev', 'next', 'prevEdit', 'nextEdit', 'pageNo', 'pageCount', 'editCount', 'zoom',
  'mTitle', 'mAuthor', 'mLang', 'clearAll', 'status', 'canvas', 'noPdf', 'imgPane', 'editor', 'diff', 'diffStat', 'pullUp', 'pushDown', 'revert'].map(k => [k, $(k)]));

// Project: orig = imported text, edit = current text, one string per page.
let P = { name: 'book', title: '', author: '', lang: 'eo', uuid: crypto.randomUUID(), orig: [''], edit: [''], cur: 0 };
let pdf = null;

// ---- storage: IndexedDB keeps the project and the PDF across reloads (localStorage is too small)
const db = new Promise((ok, fail) => {
  const r = indexedDB.open('scanproof', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
});
const kv = async (mode, fn) => { const d = await db; return new Promise((ok, fail) => { const t = d.transaction('kv', mode); const r = fn(t.objectStore('kv')); t.oncomplete = () => ok(r?.result); t.onerror = () => fail(t.error); }); };
const put = (k, v) => kv('readwrite', s => s.put(v, k));
const get = k => kv('readonly', s => s.get(k));
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => put('project', P).then(() => status('Saved'), e => status('Save failed: ' + e)), 400);
}
function status(s) { ui.status.textContent = s; }

// ---- pages
const pageTotal = () => Math.max(P.edit.length, pdf?.numPages || 0);
function ensurePages(n) { while (P.edit.length < n) { P.edit.push(''); P.orig.push(''); } }
function edited() { return P.edit.map((t, i) => t !== P.orig[i] ? i : -1).filter(i => i >= 0); }

function go(n) {
  P.cur = Math.max(0, Math.min(pageTotal() - 1, n));
  ensurePages(P.cur + 1);
  ui.editor.value = P.edit[P.cur];
  ui.pageNo.value = P.cur + 1;
  ui.pageCount.textContent = '/ ' + pageTotal();
  showDiff(); renderImage(); save();
}

function showDiff() {
  const a = P.orig[P.cur], b = P.edit[P.cur];
  ui.diff.replaceChildren(...Diff.diffWordsWithSpace(a, b).map(p => {
    const el = document.createElement(p.added ? 'ins' : p.removed ? 'del' : 'span');
    el.textContent = p.value; return el;
  }));
  const n = edited().length;
  ui.editCount.textContent = n ? `${n} page${n > 1 ? 's' : ''} edited` : '';
  ui.diffStat.textContent = a === b ? 'no changes' : 'edited';
}

let renderTask = null;
async function renderImage() {
  ui.noPdf.hidden = !!pdf;
  if (!pdf || P.cur >= pdf.numPages) { ui.canvas.width = 0; return; }
  const page = await pdf.getPage(P.cur + 1);
  const cssW = (ui.imgPane.clientWidth - 16) * +ui.zoom.value;
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: cssW * devicePixelRatio / base.width });
  renderTask?.cancel();
  const c = ui.canvas;
  c.width = vp.width; c.height = vp.height; c.style.width = cssW + 'px';
  renderTask = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
  try { await renderTask.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') status('Render error: ' + e); }
}

// ---- import
ui.inPdf.onchange = async () => {
  const f = ui.inPdf.files[0]; if (!f) return;
  status('Loading PDF…');
  await openPdf(await f.arrayBuffer());
  await put('pdf', f);
  if (!P.title) P.title = f.name.replace(/\.pdf$/i, '');
  ensurePages(pdf.numPages); syncMeta(); go(P.cur);
  status(`PDF: ${pdf.numPages} pages`);
};
async function openPdf(buf) { pdf = await pdfjsLib.getDocument({ data: buf }).promise; }

ui.inText.onchange = async () => {
  const f = ui.inText.files[0]; if (!f) return;
  if (edited().length && !confirm('Replace the current text? Your edits on this text will be lost (export a .patch first to keep them).')) return;
  let text, meta = {};
  if (/\.epub$/i.test(f.name)) ({ text, meta } = await readEpub(f));
  else text = (await f.text()).replace(/\r\n?/g, '\n');
  const pages = text.includes('\f') ? text.split('\f') : splitPages(text, pdf?.numPages || Math.max(1, Math.ceil(text.length / 2000)));
  const name = f.name.replace(/(\.pages)?\.[^.]+$/, '');
  P = { ...P, name, orig: pages, edit: [...pages], cur: 0,
    title: meta.title || P.title || name, author: meta.author || P.author, lang: meta.lang || P.lang };
  syncMeta(); go(0);
  status(`Text: ${pages.length} pages${text.includes('\f') ? '' : ' (split by length: use the line buttons to fix page ends)'}`);
};

async function readEpub(f) {
  const zip = await JSZip.loadAsync(f);
  const xml = async p => new DOMParser().parseFromString(await zip.file(p).async('string'), 'application/xml');
  const opfPath = (await xml('META-INF/container.xml')).querySelector('rootfile').getAttribute('full-path');
  const opf = await xml(opfPath), dir = opfPath.replace(/[^/]*$/, '');
  const items = Object.fromEntries([...opf.querySelectorAll('manifest > item')].map(i => [i.getAttribute('id'), i.getAttribute('href')]));
  const parts = [];
  for (const ref of opf.querySelectorAll('spine > itemref')) {
    const path = decodeURIComponent(dir + items[ref.getAttribute('idref')]);
    const doc = await xml(path);
    if (doc.querySelector('nav')?.getAttribute('epub:type') === 'toc') continue;
    const body = doc.querySelector('body') || (new DOMParser().parseFromString(await zip.file(path).async('string'), 'text/html')).body;
    parts.push(elementToMarkup(body));
  }
  const md = n => opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', n)[0]?.textContent?.trim();
  return { text: parts.filter(Boolean).join('\n\n'), meta: { title: md('title'), author: md('creator'), lang: md('language') } };
}

// ---- editing
ui.editor.oninput = () => { P.edit[P.cur] = ui.editor.value; showDiff(); save(); };
ui.revert.onclick = () => { P.edit[P.cur] = P.orig[P.cur]; go(P.cur); };
// Re-pagination moves a line in both the original and the edit, so it does not count as an edit.
function moveLine(from, to, first) {
  if (to < 0 || to >= pageTotal()) return;
  ensurePages(to + 1);
  for (const arr of [P.orig, P.edit]) {
    const lines = arr[from].split('\n');
    while (lines.length && !lines[first ? 0 : lines.length - 1].trim()) first ? lines.shift() : lines.pop();
    if (!lines.length) continue;
    const l = first ? lines.shift() : lines.pop();
    arr[from] = lines.join('\n');
    arr[to] = first ? arr[to].replace(/\s*$/, '') + '\n\n' + l + '\n' : l + '\n\n' + arr[to].replace(/^\s*/, '');
  }
  go(P.cur);
}
ui.pullUp.onclick = () => moveLine(P.cur, P.cur - 1, true);
ui.pushDown.onclick = () => moveLine(P.cur, P.cur + 1, false);

ui.prev.onclick = () => go(P.cur - 1);
ui.next.onclick = () => go(P.cur + 1);
ui.pageNo.onchange = () => go(+ui.pageNo.value - 1);
ui.prevEdit.onclick = () => { const e = edited().filter(i => i < P.cur); if (e.length) go(e.at(-1)); };
ui.nextEdit.onclick = () => { const e = edited().find(i => i > P.cur); if (e !== undefined) go(e); };
ui.zoom.oninput = () => renderImage();
addEventListener('resize', () => renderImage());
addEventListener('keydown', e => {
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); go(P.cur - 1); }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); go(P.cur + 1); }
});

function syncMeta() { ui.mTitle.value = P.title; ui.mAuthor.value = P.author; ui.mLang.value = P.lang; }
for (const [k, el] of [['title', ui.mTitle], ['author', ui.mAuthor], ['lang', ui.mLang]]) el.oninput = () => { P[k] = el.value; save(); };
ui.clearAll.onclick = async () => {
  if (!confirm('Close this project? Its text, edits and PDF are removed from this browser. Export first if you need them.')) return;
  await kv('readwrite', s => s.clear()); location.reload();
};

// ---- export
function download(data, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const meta = () => ({ title: P.title, author: P.author, lang: P.lang, uuid: P.uuid });
const exporters = {
  async epub() {
    const zip = new JSZip(), files = epubFiles(P.edit, meta());
    zip.file('mimetype', files.mimetype, { compression: 'STORE' });
    for (const [p, c] of Object.entries(files)) if (p !== 'mimetype') zip.file(p, c);
    download(await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' }), P.name + '.epub', 'application/epub+zip');
  },
  mobi() { download(buildMobi(P.edit, meta()), P.name + '.mobi', 'application/x-mobipocket-ebook'); },
  pdf() {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;width:0;height:0;border:0';
    f.srcdoc = printDoc(P.edit, meta());
    f.onload = () => { f.contentWindow.print(); setTimeout(() => f.remove(), 60000); };
    document.body.append(f);
  },
  txt() { download(toPlainText(P.edit), P.name + '.txt', 'text/plain;charset=utf-8'); },
  pages() { download(P.edit.join('\f'), P.name + '.pages.txt', 'text/plain;charset=utf-8'); },
  // Patch against the paged text (pages joined by form feeds), so `patch` applies it to the imported .pages.txt.
  patch() { download(Diff.createTwoFilesPatch(`a/${P.name}.pages.txt`, `b/${P.name}.pages.txt`, P.orig.join('\f'), P.edit.join('\f')), P.name + '.patch', 'text/x-diff'); },
};
document.querySelectorAll('[data-export]').forEach(b => b.onclick = async () => {
  b.closest('details').open = false;
  status('Exporting ' + b.dataset.export + '…');
  try { await exporters[b.dataset.export](); status('Exported ' + b.dataset.export); } catch (e) { status('Export failed: ' + e); }
});

// ---- start: restore the last project and PDF
(async () => {
  const saved = await get('project');
  if (saved) P = saved;
  const f = await get('pdf');
  if (f) await openPdf(await f.arrayBuffer());
  syncMeta(); go(P.cur);
  status(saved ? 'Restored last project' : 'Import a scanned PDF and its text (TXT or EPUB)');
})();
