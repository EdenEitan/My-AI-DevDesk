const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

const categories = [
  'Software Development',
  'Testing & Automation',
  'AI & Prompt Engineering',
  'Learning & University',
  'Personal & Everyday'
];
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

function atomicWrite(targetPath, data) {
  fs.mkdirSync(path.dirname(targetPath), {recursive: true});
  const tmp = targetPath + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, data, {flag: 'wx', encoding: 'utf8'});
    fs.renameSync(tmp, targetPath);
  } catch (e) {
    fs.rmSync(tmp, {force: true});
    throw e;
  }
}

class Store {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, {recursive: true});
  }

  file(id, ext) {
    if (!uuid.test(id)) throw Error('Invalid record identifier.');
    return path.join(this.root, id + ext);
  }

  migrateFromIfEmpty(legacyDirs = []) {
    const existing = fs.readdirSync(this.root).filter(x => x.endsWith('.json'));
    if (existing.length > 0) return 0;
    let copied = 0;
    for (const dir of legacyDirs) {
      if (!dir || path.resolve(dir) === path.resolve(this.root) || !fs.existsSync(dir)) continue;
      let entries;
      try { entries = fs.readdirSync(dir); } catch { continue; }
      const files = entries.filter(x => x.endsWith('.json') || x.endsWith('.md'));
      if (!files.some(x => x.endsWith('.json'))) continue;
      for (const name of files) {
        const dest = path.join(this.root, name);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(path.join(dir, name), dest);
          copied++;
        }
      }
      if (copied > 0) break;
    }
    return copied;
  }

  validate(p) {
    if (!categories.includes(p.category) || typeof p.title !== 'string' || !p.title.trim() ||
        typeof p.content !== 'string' || !p.content.trim() || typeof p.description !== 'string') {
      throw Error('Enter a title, category and prompt content.');
    }
  }

  read(id) {
    const p = JSON.parse(fs.readFileSync(this.file(id, '.json'), 'utf8'));
    this.validate(p);
    if (p.id !== id || !uuid.test(p.revision) || (p.checklist !== null && !uuid.test(p.checklist))) {
      throw Error('Invalid saved record.');
    }
    p.pinned = Boolean(p.pinned);
    return p;
  }

  list() {
    const rows = [], warnings = [];
    for (const name of fs.readdirSync(this.root).filter(x => x.endsWith('.json'))) {
      try {
        const p = this.read(name.slice(0, -5));
        if (p.checklist && !fs.existsSync(this.file(p.checklist, '.md'))) {
          warnings.push('Checklist missing for ' + p.title + '. Edit the template to attach a replacement.');
          p.checklist = null;
        }
        rows.push(p);
      } catch {
        warnings.push('Could not read ' + name + '. Its file has been preserved.');
      }
    }
    return {rows: rows.sort((a, b) => a.title.localeCompare(b.title)), warnings};
  }

  change(id, revision, action) {
    const lock = this.file(id, '.lock');
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (e) {
      if (e.code === 'EEXIST') throw Error('This prompt is locked by another edit. Reopen it and try again.');
      throw e;
    }
    try {
      const prev = revision ? this.read(id) : null;
      if (prev && prev.revision !== revision) {
        throw Error('This prompt changed elsewhere. Reopen the template before saving.');
      }
      return action(prev);
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }

  save(input) {
    this.validate(input);
    const id = input.id || randomUUID();
    if (input.id && !uuid.test(input.revision)) throw Error('Reopen the template before saving.');
    return this.change(id, input.revision, prev => {
      let checklist = prev?.checklist || null;
      if (input.removeChecklist) checklist = null;
      if (input.items?.trim()) {
        if (checklist && fs.existsSync(this.file(checklist, '.md'))) {
          throw Error('Edit the existing checklist in its Markdown tab.');
        }
        checklist = randomUUID();
        const lines = input.items
          .split(/\r?\n/)
          .map(x => x.trim())
          .filter(Boolean)
          .map(x => '- [ ] ' + x.replace(/^(?:-\s*)?\[[ xX]\]\s*/, ''));
        fs.writeFileSync(this.file(checklist, '.md'), '# Verify AI Output\n\n' + lines.join('\n') + '\n', {flag: 'wx'});
      }
      const p = {
        id,
        revision: randomUUID(),
        title: input.title.trim(),
        category: input.category,
        description: input.description.trim(),
        content: input.content,
        checklist,
        pinned: input.pinned !== undefined ? Boolean(input.pinned) : Boolean(prev?.pinned)
      };
      const tmp = this.file(p.revision, '.tmp');
      try {
        fs.writeFileSync(tmp, JSON.stringify(p), {flag: 'wx'});
        fs.renameSync(tmp, this.file(id, '.json'));
      } catch (e) {
        fs.rmSync(tmp, {force: true});
        if (checklist && checklist !== prev?.checklist) fs.rmSync(this.file(checklist, '.md'), {force: true});
        throw e;
      }
      if (prev?.checklist && prev.checklist !== checklist) fs.rmSync(this.file(prev.checklist, '.md'), {force: true});
      return p;
    });
  }

  togglePin(id) {
    const current = this.read(id);
    return this.change(id, current.revision, prev => {
      const updated = {...prev, revision: randomUUID(), pinned: !prev.pinned};
      const tmp = this.file(updated.revision, '.tmp');
      try {
        fs.writeFileSync(tmp, JSON.stringify(updated), {flag: 'wx'});
        fs.renameSync(tmp, this.file(id, '.json'));
      } catch (e) {
        fs.rmSync(tmp, {force: true});
        throw e;
      }
      return updated;
    });
  }

  remove(id, revision) {
    if (!uuid.test(revision)) throw Error('Reopen the template before deleting.');
    this.change(id, revision, p => {
      fs.unlinkSync(this.file(id, '.json'));
      if (p.checklist) fs.rmSync(this.file(p.checklist, '.md'), {force: true});
    });
  }
}

class NoteStore {
  constructor(baseRoot) {
    this.root = path.join(baseRoot, 'notes');
    fs.mkdirSync(this.root, {recursive: true});
  }

  file(id) {
    if (!uuid.test(id)) throw Error('Invalid note identifier.');
    return path.join(this.root, id + '.json');
  }

  read(id) {
    const n = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
    if (n.id !== id || typeof n.title !== 'string' || typeof n.content !== 'string') {
      throw Error('Invalid note record.');
    }
    return n;
  }

  list() {
    const items = [], warnings = [];
    for (const name of fs.readdirSync(this.root).filter(x => x.endsWith('.json'))) {
      try {
        items.push(this.read(name.slice(0, -5)));
      } catch {
        warnings.push('Could not read note ' + name + '.');
      }
    }
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return {items, warnings};
  }

  save(input) {
    const id = input.id || randomUUID();
    const title = (typeof input.title === 'string' && input.title.trim()) ? input.title.trim() : 'Untitled note';
    const content = typeof input.content === 'string' ? input.content : '';
    const record = {id, title, content, updatedAt: Date.now()};
    atomicWrite(this.file(id), JSON.stringify(record));
    return record;
  }

  remove(id) {
    const target = this.file(id);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
}

class OutputStore {
  constructor(baseRoot) {
    this.root = path.resolve(path.join(baseRoot, 'outputs'));
    fs.mkdirSync(this.root, {recursive: true});
  }

  normalizeRelPath(raw) {
    if (typeof raw !== 'string') throw Error('Enter a document filename.');
    let cleaned = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '');
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

module.exports = {Store, NoteStore, OutputStore, categories};
