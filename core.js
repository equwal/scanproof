// Pure functions shared by the browser app and the Node tests: no DOM, no globals.
//
// Page markup: one block per line. "# " heading, "[nota] " footnote, *italic*, **bold**,
// a line of asterisks is a scene break. "⟦↪⟧" ends a paragraph that continues on the next
// page; "⟦↩⟧" starts the continuation there.

const CONT_OUT = '⟦↪⟧', CONT_IN = '⟦↩⟧';

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Join pages into blocks {type: h1|h2|p|note|hr, text}. Footnotes met while a paragraph
// is still open (it continues on the next page) are held until that paragraph closes.
export function toBlocks(pages) {
  const out = [];
  let open = null, held = [];
  const flush = () => { open = null; out.push(...held); held = []; };
  for (const page of pages) {
    for (const raw of page.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith(CONT_IN) && open) {
        const rest = line.slice(CONT_IN.length);
        const gap = /\s$/.test(open.text.split(CONT_OUT)[0]) || /^\s/.test(rest) ? ' ' : '';
        open.text = open.text.replace(/\s*⟦↪⟧\s*$/, '') + gap + rest.trim();
        if (!open.text.endsWith(CONT_OUT)) flush();
        continue;
      }
      let b;
      if (line.startsWith('# ')) b = { type: /\bparto\b/i.test(line) ? 'h1' : 'h2', text: line.slice(2).trim() };
      else if (line.startsWith('[nota]')) b = { type: 'note', text: line.slice(6).trim() };
      else if (/^(\*\s*){3,}$/.test(line)) b = { type: 'hr', text: '' };
      else b = { type: 'p', text: line };
      if (b.type === 'note' && open) { held.push(b); continue; }
      if (open) flush();
      out.push(b);
      if (b.type === 'p' && b.text.endsWith(CONT_OUT)) open = b;
    }
  }
  flush();
  for (const b of out) b.text = b.text.replaceAll(CONT_OUT, '').replaceAll(CONT_IN, '').trim();
  return out;
}

// Markup to HTML for one block. Emphasis converts only when its markers nest properly;
// otherwise all asterisks are dropped, so the output is always valid XHTML.
export function inline(text) {
  const parts = escapeHtml(text).split(/(\*\*|\*)/);
  const stack = [];
  const out = parts.map((p, i) => {
    if (i % 2 === 0) return p;
    const tag = p === '**' ? 'b' : 'i';
    if (stack.at(-1) === tag) { stack.pop(); return `</${tag}>`; }
    if (stack.includes(tag)) return null; // closes across another tag
    stack.push(tag); return `<${tag}>`;
  });
  if (stack.length || out.includes(null)) return parts.filter((_, i) => i % 2 === 0).join('');
  return out.join('').replace(/<(b|i)><\/\1>/g, '');
}

export function plain(text) {
  return text.replace(/\*/g, '');
}

export function blockHtml(b) {
  if (b.type === 'hr') return '<p class="scene">* * *</p>';
  if (b.type === 'note') return `<p class="note">${inline(b.text)}</p>`;
  return `<${b.type}>${inline(b.text)}</${b.type}>`;
}

// Sections start at each heading; text before the first heading is its own section.
export function toSections(blocks) {
  const secs = [];
  for (const b of blocks) {
    if (b.type === 'h1' || b.type === 'h2' || !secs.length) secs.push({ title: b.type[0] === 'h' ? plain(b.text) : '', level: b.type === 'h1' ? 1 : 2, blocks: [] });
    secs[secs.length - 1].blocks.push(b);
  }
  return secs;
}

export function toPlainText(pages) {
  return toBlocks(pages).map(b =>
    b.type === 'hr' ? '* * *' : b.type === 'note' ? '    ' + plain(b.text) : b.type === 'h1' ? plain(b.text).toUpperCase() : plain(b.text)
  ).join('\n\n') + '\n';
}

// Text without page breaks to n pages, cut at line ends, sized by character count.
export function splitPages(text, n) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const total = text.length, pages = [];
  let cur = [], size = 0;
  for (const l of lines) {
    cur.push(l); size += l.length + 1;
    if (pages.length < n - 1 && size >= (total / n) * (pages.length + 1)) { pages.push(cur.join('\n')); cur = []; }
  }
  pages.push(cur.join('\n'));
  while (pages.length < n) pages.push('');
  return pages;
}

const CSS = `body{font-family:serif;line-height:1.45}
p{margin:0;text-indent:1.5em;text-align:justify}
h1,h2{text-align:center;margin:1.5em 0 1em}
p.scene{text-align:center;text-indent:0;margin:1em 0}
p.note{font-size:.85em;text-indent:0;margin:.5em 0 .5em 1.5em}`;

// EPUB 3 as a map of path -> string. The caller zips it, with "mimetype" stored first.
export function epubFiles(pages, meta) {
  const secs = toSections(toBlocks(pages));
  const lang = escapeHtml(meta.lang || 'eo'), title = escapeHtml(meta.title || 'Untitled');
  const xhtml = (t, body) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head><meta charset="utf-8"/><title>${t}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>
`;
  const f = {
    'mimetype': 'application/epub+zip',
    'META-INF/container.xml': `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`,
    'OEBPS/style.css': CSS,
  };
  const names = secs.map((_, i) => `s${String(i).padStart(4, '0')}.xhtml`);
  secs.forEach((s, i) => { f['OEBPS/' + names[i]] = xhtml(escapeHtml(s.title || meta.title || ''), s.blocks.map(blockHtml).join('\n')); });
  const toc = secs.map((s, i) => s.title ? `<li><a href="${names[i]}">${escapeHtml(s.title)}</a></li>` : '').join('\n');
  f['OEBPS/nav.xhtml'] = xhtml(title, `<nav epub:type="toc" id="toc"><h1>${title}</h1><ol>\n${toc || `<li><a href="${names[0]}">${title}</a></li>`}\n</ol></nav>`);
  const modified = (meta.modified || new Date().toISOString()).replace(/\.\d+Z$/, 'Z');
  f['OEBPS/content.opf'] = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:${meta.uuid}</dc:identifier>
<dc:title>${title}</dc:title>
<dc:creator>${escapeHtml(meta.author || '')}</dc:creator>
<dc:language>${lang}</dc:language>
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
${names.map((n, i) => `<item id="s${i}" href="${n}" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine>
${names.map((_, i) => `<itemref idref="s${i}"/>`).join('\n')}
</spine>
</package>
`;
  return f;
}

// One HTML document for print-to-PDF and for MOBI.
export function bookHtml(pages, meta, pageBreak) {
  const secs = toSections(toBlocks(pages));
  return secs.map(s => s.blocks.map(blockHtml).join('\n')).join('\n' + pageBreak + '\n');
}

export function printDoc(pages, meta) {
  return `<!doctype html><html lang="${escapeHtml(meta.lang || 'eo')}"><head><meta charset="utf-8"><title>${escapeHtml(meta.title || '')}</title>
<style>${CSS}
@page{size:A5;margin:18mm 16mm}
body{font-size:11pt}
.brk{break-after:page}</style></head><body>
${bookHtml(pages, meta, '<div class="brk"></div>')}
</body></html>`;
}

// MOBI 6 (PalmDB, uncompressed text records). Old format, but every Kindle opens it.
export function buildMobi(pages, meta) {
  const enc = new TextEncoder();
  const html = `<html><head><guide></guide></head><body>${bookHtml(pages, meta, '<mbp:pagebreak/>')}</body></html>`;
  const text = enc.encode(html);
  const chunks = [];
  for (let pos = 0; pos < text.length;) {
    let end = Math.min(pos + 4096, text.length);
    while (end < text.length && (text[end] & 0xc0) === 0x80) end--; // never split a UTF-8 character
    chunks.push(text.subarray(pos, end)); pos = end;
  }
  const exthRecs = [[100, meta.author || ''], [503, meta.title || ''], [524, meta.lang || 'eo']]
    .map(([t, v]) => { const d = enc.encode(v); const r = new Uint8Array(8 + d.length); const dv = new DataView(r.buffer); dv.setUint32(0, t); dv.setUint32(4, r.length); r.set(d, 8); return r; });
  const exthLen = 12 + exthRecs.reduce((a, r) => a + r.length, 0);
  const exthPad = (4 - exthLen % 4) % 4;
  const name = enc.encode(meta.title || 'Untitled');
  const rec0Len = 16 + 232 + exthLen + exthPad + name.length;
  const rec0 = new Uint8Array(rec0Len + 2 + (4 - (rec0Len + 2) % 4) % 4);
  const v = new DataView(rec0.buffer);
  v.setUint16(0, 1); v.setUint32(4, text.length); v.setUint16(8, chunks.length); v.setUint16(10, 4096);
  const M = 16;
  rec0.set(enc.encode('MOBI'), M);
  v.setUint32(M + 4, 232); v.setUint32(M + 8, 2); v.setUint32(M + 12, 65001);
  v.setUint32(M + 16, (meta.uid ?? 0) >>> 0); v.setUint32(M + 20, 6);
  for (let o = 24; o <= 60; o += 4) v.setUint32(M + o, 0xffffffff);
  v.setUint32(M + 64, chunks.length + 1);
  v.setUint32(M + 68, 16 + 232 + exthLen + exthPad); v.setUint32(M + 72, name.length);
  v.setUint32(M + 88, 6); v.setUint32(M + 92, 0xffffffff);
  v.setUint32(M + 112, 0x40);
  v.setUint32(M + 148, 0xffffffff); v.setUint32(M + 152, 0xffffffff);
  v.setUint16(M + 176, 1); v.setUint16(M + 178, chunks.length); v.setUint32(M + 180, 1);
  for (const o of [184, 188, 192, 196, 208, 216, 220, 228]) v.setUint32(M + o, 0xffffffff);
  v.setUint32(M + 188, 1); v.setUint32(M + 196, 1); v.setUint32(M + 212, 0);
  let p = M + 232;
  rec0.set(enc.encode('EXTH'), p); v.setUint32(p + 4, exthLen); v.setUint32(p + 8, exthRecs.length); p += 12;
  for (const r of exthRecs) { rec0.set(r, p); p += r.length; }
  p += exthPad;
  rec0.set(name, p);
  const eof = new Uint8Array([0xe9, 0x8e, 0x0d, 0x0a]);
  const recs = [rec0, ...chunks, eof];
  const head = 78 + 8 * recs.length + 2;
  const out = new Uint8Array(head + recs.reduce((a, r) => a + r.length, 0));
  const h = new DataView(out.buffer);
  const pdbName = (meta.title || 'book').normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/ /g, '_').slice(0, 31);
  out.set(enc.encode(pdbName), 0);
  const now = Math.floor((meta.time ?? Date.now()) / 1000);
  h.setUint32(36, now); h.setUint32(40, now);
  out.set(enc.encode('BOOKMOBI'), 60);
  h.setUint32(68, 2 * recs.length - 1); h.setUint16(76, recs.length);
  let off = head;
  recs.forEach((r, i) => { h.setUint32(78 + 8 * i, off); h.setUint32(78 + 8 * i + 4, 2 * i); out.set(r, off); off += r.length; });
  return out;
}

// EPUB import: XHTML body elements to page markup, one block per line.
export function elementToMarkup(el) {
  const out = [];
  const inl = n => [...n.childNodes].map(c => {
    if (c.nodeType === 3) return c.nodeValue.replace(/\s+/g, ' ');
    if (c.nodeType !== 1) return '';
    const t = c.localName, inner = inl(c);
    if (t === 'b' || t === 'strong') return inner.trim() ? `**${inner}**` : inner;
    if (t === 'i' || t === 'em') return inner.trim() ? `*${inner}*` : inner;
    if (t === 'br') return ' ';
    return inner;
  }).join('');
  const walk = n => {
    for (const c of n.children) {
      const t = c.localName, cls = (c.getAttribute('class') || '') + ' ' + (c.getAttribute('epub:type') || '');
      if (/^h[1-6]$/.test(t)) out.push('# ' + inl(c).trim());
      else if (t === 'hr') out.push('* * *');
      else if (t === 'p' || t === 'li' || t === 'blockquote' && !c.children.length) {
        const s = inl(c).trim();
        if (/scene/.test(cls)) out.push('* * *');
        else if (s) out.push((/note/.test(cls) ? '[nota] ' : '') + s);
      } else if (t === 'nav' && /toc/.test(cls)) continue;
      else if (c.children.length) walk(c);
      else { const s = inl(c).trim(); if (s) out.push(s); }
    }
  };
  walk(el);
  return out.join('\n\n');
}
