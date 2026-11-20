const fs = require('node:fs');
const path = require('node:path');
const {atomicWrite} = require('./fsUtils');

class OutputStore {
  constructor(baseRoot) {
    this.root = path.resolve(path.join(baseRoot, 'outputs'));
    fs.mkdirSync(this.root, {recursive: true});
  }

  normalizeRelPath(raw) {
    if (typeof raw !== 'string') throw Error('Enter a document filename.');
    const cleaned = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleaned) throw Error('Enter a document filename.');
    const segments = cleaned.split('/').filter(Boolean).map(seg => {
      if (seg === '.' || seg === '..') throw Error('Invalid document path.');
      const safe = seg.replace(/[<>:"|?*\x00-\x1f]/g, '-').trim();
      if (!safe || safe === '.' || safe === '..') throw Error('Invalid document path.');
      return safe;
    });
    if (!segments.length) throw Error('Enter a document filename.');
    let rel = segments.join('/');
    if (!rel.toLowerCase().endsWith('.md')) rel += '.md';
    return rel;
  }

  safePath(relPath) {
    const normalized = this.normalizeRelPath(relPath);
    const full = path.resolve(this.root, normalized);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw Error('Invalid document path.');
    }
    return {relPath: normalized, fullPath: full};
  }

  list() {
    const items = [];
    const walk = (dir, prefix) => {
      let entries;
      try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.endsWith('.tmp')) continue;
        const abs = path.join(dir, entry.name);
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          walk(abs, rel);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          try {
            const st = fs.statSync(abs);
            items.push({
              relPath: rel,
              fullPath: abs,
              name: entry.name,
              folder: prefix,
              size: st.size,
              updatedAt: st.mtimeMs
            });
          } catch { /* skip transient file */ }
        }
      }
    };
    walk(this.root, '');
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return {items, outputsPath: this.root};
  }

  read(relPath) {
    const {relPath: norm, fullPath} = this.safePath(relPath);
    if (!fs.existsSync(fullPath)) throw Error('Output document not found.');
    return {relPath: norm, fullPath, content: fs.readFileSync(fullPath, 'utf8')};
  }

  save(relPath, content) {
    const {relPath: norm, fullPath} = this.safePath(relPath);
    atomicWrite(fullPath, typeof content === 'string' ? content : '');
    return {relPath: norm, fullPath};
  }

  toggleCheckbox(relPath, lineIndex) {
    const {relPath: norm, fullPath} = this.safePath(relPath);
    if (!fs.existsSync(fullPath)) throw Error('Output document not found.');
    const raw = fs.readFileSync(fullPath, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) {
      throw Error('Checkbox line out of range.');
    }
    const line = lines[lineIndex];
    const match = line.match(/^(\s*[-*+]\s+\[)([ xX])(\]\s.*)$/);
    if (!match) throw Error('Selected line is not a Markdown checkbox.');
    const nextMark = match[2].toLowerCase() === 'x' ? ' ' : 'x';
    lines[lineIndex] = match[1] + nextMark + match[3];
    const updated = lines.join(eol);
    atomicWrite(fullPath, updated);
    return {relPath: norm, fullPath, content: updated};
  }

  remove(relPath) {
    const {fullPath} = this.safePath(relPath);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }
}

module.exports = {OutputStore};
