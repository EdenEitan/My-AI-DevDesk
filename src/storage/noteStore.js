const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {UUID_RE, atomicWrite} = require('./fsUtils');

class NoteStore {
  constructor(baseRoot) {
    this.root = path.join(baseRoot, 'notes');
    fs.mkdirSync(this.root, {recursive: true});
  }

  file(id) {
    if (!UUID_RE.test(id)) throw Error('Invalid note identifier.');
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

module.exports = {NoteStore};
