const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {UUID_RE} = require('./fsUtils');

const categories = [
  'Software Development',
  'Testing & Automation',
  'AI & Prompt Engineering',
  'Learning & University',
  'Personal & Everyday'
];

class Store {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, {recursive: true});
  }

  file(id, ext) {
    if (!UUID_RE.test(id)) throw Error('Invalid record identifier.');
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
    if (p.id !== id || !UUID_RE.test(p.revision) || (p.checklist !== null && !UUID_RE.test(p.checklist))) {
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
    if (input.id && !UUID_RE.test(input.revision)) throw Error('Reopen the template before saving.');
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
    if (!UUID_RE.test(revision)) throw Error('Reopen the template before deleting.');
    this.change(id, revision, p => {
      fs.unlinkSync(this.file(id, '.json'));
      if (p.checklist) fs.rmSync(this.file(p.checklist, '.md'), {force: true});
    });
  }
}

module.exports = {Store, categories};
