const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {UUID_RE, atomicWrite} = require('./fsUtils');

class NoteStore {
  constructor(baseRoot) {
    this.root = path.join(baseRoot, 'notes');
    fs.mkdirSync(this.root, {recursive: true});
  }

  file(id, ext = '.json') {
    if (!UUID_RE.test(id)) throw Error('Invalid note identifier.');
    return path.join(this.root, id + ext);
  }

  read(id) {
    const n = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
    if (n.id !== id || typeof n.title !== 'string' || typeof n.content !== 'string') {
      throw Error('Invalid note record.');
    }
    if (n.revision !== undefined && n.revision !== null && !UUID_RE.test(n.revision)) {
      throw Error('Invalid note record.');
    }
    n.revision = n.revision || null;
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

  change(id, revision, action) {
    const lock = this.file(id, '.lock');
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (e) {
      if (e.code === 'EEXIST') throw Error('This note is locked by another edit. Reopen it and try again.');
      throw e;
    }
    try {
      const target = this.file(id);
      const prev = fs.existsSync(target) ? this.read(id) : null;
      if (prev && prev.revision && prev.revision !== revision) {
        throw Error('This note changed elsewhere. Reopen or refresh it before saving.');
      }
      return action(prev);
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }

  save(input) {
    const id = input.id || randomUUID();
    const expectedRevision = input.revision ?? null;
    if (input.id && expectedRevision !== null && !UUID_RE.test(expectedRevision)) {
      throw Error('Reopen the note before saving.');
    }
    const title = (typeof input.title === 'string' && input.title.trim()) ? input.title.trim() : 'Untitled note';
    const content = typeof input.content === 'string' ? input.content : '';
    return this.change(id, expectedRevision, () => {
      const record = {id, revision: randomUUID(), title, content, updatedAt: Date.now()};
      atomicWrite(this.file(id), JSON.stringify(record));
      return record;
    });
  }

  remove(id, revision = null) {
    if (revision !== null && !UUID_RE.test(revision)) throw Error('Reopen the note before deleting.');
    this.change(id, revision, prev => {
      if (prev) fs.unlinkSync(this.file(id));
    });
  }
}

module.exports = {NoteStore};
