import { toPlainText, splitPages, epubFiles, printDoc, buildMobi, elementToMarkup } from './core.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['inPdf', 'inText', 'prev', 'next', 'prevEdit', 'nextEdit', 'pageNo', 'pageCount', 'editCount', 'zoom',
  'mTitle', 'mAuthor', 'mLang', 'clearAll', 'status', 'canvas', 'noPdf', 'imgPane', 'editor', 'diff', 'diffStat', 'pullUp', 'pushDown', 'revert', 'saveBack',
  'overlay', 'inOverlay', 'ovOn', 'ovOpacity', 'ovBlend', 'ovOffset', 'ovClear'].map(k => [k, $(k)]));

// Project: orig = imported text, edit = current text, one string per page.
const ovDefaults = { on: true, opacity: 0.5, blend: 'normal', offset: 0 };
let P = { name: 'book', title: '', author: '', lang: 'eo', uuid: crypto.randomUUID(), orig: [''], edit: [''], cur: 0, overlay: { ...ovDefaults } };
let pdf = null, ovPdf = null;

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
  saveTimer = setTimeout(() => put('project', P).then(() => { if (!/^Save(d)? back/.test(ui.status.textContent)) status('Saved'); }, e => status('Save failed: ' + e)), 400);  // the browser autosave must not hide the result of a save back
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

const tasks = new Map();
// Render one page of doc onto canvas c at css width w, scaled to exactly w x h when h is given.
async function draw(doc, n, c, w, h) {
  tasks.get(c)?.cancel();
  if (!doc || n < 0 || n >= doc.numPages) { c.width = 0; c.height = 0; return 0; }
  const page = await doc.getPage(n + 1);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: w * devicePixelRatio / base.width });
  c.width = vp.width; c.height = h ? h * devicePixelRatio : vp.height;
  const ctx = c.getContext('2d');
  if (h) ctx.scale(1, c.height / vp.height); // stretch the overlay page to the scan page's height
  const t = page.render({ canvasContext: ctx, viewport: vp });
  tasks.set(c, t);
  try { await t.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') status('Render error: ' + e); }
  return vp.height / devicePixelRatio;
}

async function renderImage() {
  ui.noPdf.hidden = !!pdf;
  const w = (ui.imgPane.clientWidth - 16) * +ui.zoom.value;
  ui.canvas.style.width = w + 'px';
  const h = await draw(pdf, P.cur, ui.canvas, w);
  applyOverlayStyle();
  await draw(ovPdf && P.overlay.on ? ovPdf : null, P.cur + P.overlay.offset, ui.overlay, w, h || undefined);
}

// ---- overlay: a second PDF drawn over the scan with transparency, page n + offset over scan page n
function applyOverlayStyle() {
  const o = P.overlay;
  ui.overlay.style.opacity = o.opacity;
  ui.overlay.style.mixBlendMode = o.blend;
  ui.overlay.hidden = !o.on;
  ui.ovOn.checked = o.on; ui.ovOpacity.value = o.opacity; ui.ovBlend.value = o.blend; ui.ovOffset.value = o.offset;
}
ui.inOverlay.onchange = async () => {
  const f = ui.inOverlay.files[0]; if (!f) return;
  ovPdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
  await put('overlay', f);
  P.overlay.on = true; save(); renderImage();
  status(`Overlay PDF: ${ovPdf.numPages} pages`);
};
ui.ovOn.onchange = () => { P.overlay.on = ui.ovOn.checked; save(); renderImage(); };
ui.ovOpacity.oninput = () => { P.overlay.opacity = +ui.ovOpacity.value; save(); applyOverlayStyle(); };
ui.ovBlend.onchange = () => { P.overlay.blend = ui.ovBlend.value; save(); applyOverlayStyle(); };
ui.ovOffset.onchange = () => { P.overlay.offset = Math.trunc(+ui.ovOffset.value) || 0; save(); renderImage(); };
ui.ovClear.onclick = async () => { ovPdf = null; await kv('readwrite', s => s.delete('overlay')); renderImage(); status('Overlay removed'); };

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
  P = { ...P, name, orig: pages, edit: [...pages], cur: 0, save: null,
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
  if (e.altKey && e.key.toLowerCase() === 'o') { e.preventDefault(); P.overlay.on = !P.overlay.on; save(); renderImage(); }
});

function syncMeta() { ui.saveBack.hidden = !P.save; ui.saveBack.textContent = P.save ? `Save back (${P.save.split('/').pop()})` : 'Save back'; ui.mTitle.value = P.title; ui.mAuthor.value = P.author; ui.mLang.value = P.lang; }
for (const [k, el] of [['title', ui.mTitle], ['author', ui.mAuthor], ['lang', ui.mLang]]) el.oninput = () => { P[k] = el.value; save(); };
ui.clearAll.onclick = async () => {
  if (!confirm('Close this project? Its text, edits and PDF are removed from this browser. Export first if you need them.')) return;
  await kv('readwrite', s => s.clear()); location.reload();
};

// ---- save back: send the edited pages to the server the book was opened from (?save=<url>; the last part of the url names the pass the text came from)
ui.saveBack.onclick = async () => {
  const pages = {};
  for (const i of edited()) pages[i] = P.edit[i];
  if (!Object.keys(pages).length) return status('No edits to save back');
  status('Saving back…');
  try {
    const r = await fetch(P.save, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pages }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    const pg = a => a.map(i => i + 1).join(', ');
    status(`Saved back to "${d.pass}": ${d.applied.length} page(s) applied` + (d.already.length ? `, ${d.already.length} already saved` : '')
      + (d.conflicts.length ? `; NOT saved (the server's text changed after that pass): page ${pg(d.conflicts)}` : '')
      + (d.tags_lost.length ? `; layout tags lost on page ${pg(d.tags_lost)}` : ''));
  } catch (e) { status('Save back failed: ' + e.message); }
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

// ---- start: restore the last project and PDF, or open the files named in the address: ?pdf=<url>&text=<url>[&name=<name>]
// (text = pages joined by form feeds). The links are for a server that hosts the files next to this page, so opening is instant.
async function openFromUrl(q) {
  const [pdfRes, textRes] = await Promise.all([q.get('pdf') ? fetch(q.get('pdf')) : null, fetch(q.get('text'))]);
  if (!textRes.ok || (pdfRes && !pdfRes.ok)) throw new Error('could not fetch the files');
  const pages = (await textRes.text()).replace(/\r\n?/g, '\n').split('\f');
  if (pdfRes) { const f = await pdfRes.blob(); await openPdf(await f.arrayBuffer()); await put('pdf', f); }
  const name = q.get('name') || 'book';
  P = { ...P, name, title: name, orig: pages, edit: [...pages], cur: 0, uuid: crypto.randomUUID(), save: q.get('save') };
  ensurePages(pdf?.numPages || 0);
}
(async () => {
  const q = new URLSearchParams(location.search);
  let saved = await get('project');
  if (saved) P = { ...saved, overlay: { ...ovDefaults, ...saved.overlay } }; // projects saved before the overlay existed
  const f = await get('pdf');
  if (f) await openPdf(await f.arrayBuffer());
  const ov = await get('overlay');
  if (ov) ovPdf = await pdfjsLib.getDocument({ data: await ov.arrayBuffer() }).promise;
  if (q.get('text') && (!edited().length || confirm('Open the linked book? Your edits on the current text will be lost (export a .patch first to keep them).'))) {
    status('Opening…');
    try { await openFromUrl(q); saved = null; history.replaceState(null, '', location.pathname); } catch (e) { status('Open failed: ' + e.message); }
  }
  syncMeta(); go(P.cur);
  if (!ui.status.textContent.startsWith('Open failed')) status(saved ? 'Restored last project' : 'Import a scanned PDF and its text (TXT or EPUB)');
})();
