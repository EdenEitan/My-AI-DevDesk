const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Store, categories} = require('./store');

// 1. Verify store CRUD + checklist + non-destructive migration
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-hub-test-'));
try {
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
  const copied = sharedStore.migrateFromIfEmpty([legacyDir]);
  assert.equal(copied, 2, 'Should copy both JSON prompt and MD checklist');

  const listed = sharedStore.list();
  assert.equal(listed.warnings.length, 0);
  assert.equal(listed.rows.length, 1);
  assert.equal(listed.rows[0].title, 'API Negative Test');

  // Re-running migration on non-empty store should be a no-op
  assert.equal(sharedStore.migrateFromIfEmpty([legacyDir]), 0);

  // Verify original legacy files are untouched
  assert.equal(legacyStore.list().rows.length, 1);

  // Verify checklist markdown is in English
  const md = fs.readFileSync(sharedStore.file(created.checklist, '.md'), 'utf8');
  assert.ok(md.startsWith('# Verify AI Output\n\n- [ ] Verify 422 status\n- [ ] Verify error message\n'));

  console.log('ALL TESTS PASSED');
} finally {
  fs.rmSync(tmpBase, {recursive: true, force: true});
}
