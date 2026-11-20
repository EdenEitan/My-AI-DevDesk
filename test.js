const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Store, NoteStore, OutputStore, categories} = require('./store');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-hub-test-'));
try {
  // 1. Store: CRUD, checklist, and non-destructive migration
  const legacyDir = path.join(tmpBase, 'legacy');
  const sharedDir = path.join(tmpBase, 'shared');

  const legacyStore = new Store(legacyDir);
  const created = legacyStore.save({
    title: 'API Negative Test',
    category: categories[1],
    description: 'Check {{endpoint}} validation',
    content: 'Write a pytest for {{endpoint}} when {{field}} is invalid.',
    items: 'Verify 422 status\nVerify error message'
  });
  assert.ok(created.id);
  assert.ok(created.checklist);

  const sharedStore = new Store(sharedDir);
  assert.equal(sharedStore.migrateFromIfEmpty([legacyDir]), 2);
  const listed = sharedStore.list();
  assert.equal(listed.warnings.length, 0);
  assert.equal(listed.rows.length, 1);
  assert.equal(listed.rows[0].pinned, false);
  const pinnedOnce = sharedStore.togglePin(created.id);
  assert.equal(pinnedOnce.pinned, true);
  assert.equal(sharedStore.read(created.id).pinned, true);
  const unpinned = sharedStore.togglePin(created.id);
  assert.equal(unpinned.pinned, false);
  assert.equal(sharedStore.migrateFromIfEmpty([legacyDir]), 0);
  assert.equal(legacyStore.list().rows.length, 1);

  const md = fs.readFileSync(sharedStore.file(created.checklist, '.md'), 'utf8');
  assert.ok(md.startsWith('# Verify AI Output\n\n- [ ] Verify 422 status\n- [ ] Verify error message\n'));

  // 2. NoteStore: CRUD, default title, RTL/LTR content preservation
  const noteStore = new NoteStore(sharedDir);
  const n1 = noteStore.save({title: '', content: 'Check rating_client.py edge cases'});
  assert.equal(n1.title, 'Untitled note');
  const n2 = noteStore.save({title: 'Simulation Notes', content: 'הערה לדוגמה עם `pytest`'});
  assert.equal(noteStore.list().items.length, 2);
  const n2Updated = noteStore.save({id: n2.id, title: 'Updated Notes', content: 'Updated body'});
  assert.equal(n2Updated.id, n2.id);
  assert.equal(noteStore.read(n2.id).title, 'Updated Notes');
  noteStore.remove(n1.id);
  assert.equal(noteStore.list().items.length, 1);

  // 3. OutputStore: nested Markdown files, path traversal protection, checkbox toggling
  const outputStore = new OutputStore(sharedDir);
  const savedOut = outputStore.save('quote/03-test-scenarios', '# Test Scenarios\n\n| ID | Case |\n| --- | --- |\n| S01 | Valid |\n\n- [ ] Check 422\n- [x] Check 200\n');
  assert.equal(savedOut.relPath, 'quote/03-test-scenarios.md');
  assert.equal(outputStore.list().items.length, 1);

  // Path traversal must be rejected
  assert.throws(() => outputStore.save('../escape.md', 'nope'), /Invalid document path/);
  assert.throws(() => outputStore.read('../../outside.md'), /Invalid document path/);

  // Checkbox toggle (- [ ] -> - [x] -> - [ ])
  const toggled1 = outputStore.toggleCheckbox('quote/03-test-scenarios.md', 6);
  assert.ok(toggled1.content.includes('- [x] Check 422'));
  const toggled2 = outputStore.toggleCheckbox('quote/03-test-scenarios.md', 6);
  assert.ok(toggled2.content.includes('- [ ] Check 422'));

  outputStore.remove('quote/03-test-scenarios.md');
  assert.equal(outputStore.list().items.length, 0);

  console.log('ALL TESTS PASSED');
} finally {
  fs.rmSync(tmpBase, {recursive: true, force: true});
}
