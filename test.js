const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Store, NoteStore, OutputStore, SkillStore, parseSkillMarkdown, buildSkillMarkdown, categories} = require('./src/storage');
const {formatSnippet} = require('./src/host/editorContext');
const {createMessageRouter} = require('./src/host/messageRouter');
const {PENDING_FILE, consumePendingPopOut} = require('./src/host/pendingPopout');
const {extractVariables, isMultilineVar, renderTemplate, slugify} = require('./src/webview/core');
const {splitTableRow, isTableSeparator} = require('./src/webview/markdown');

async function run() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-hub-test-'));
  try {
    // 1. Prompt Store: CRUD, pin toggle, checklist, and non-destructive migration
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
    assert.equal(sharedStore.togglePin(created.id).pinned, true);
    assert.equal(sharedStore.read(created.id).pinned, true);
    assert.equal(sharedStore.togglePin(created.id).pinned, false);
    assert.equal(sharedStore.migrateFromIfEmpty([legacyDir]), 0);
    assert.equal(legacyStore.list().rows.length, 1);

    const md = fs.readFileSync(sharedStore.file(created.checklist, '.md'), 'utf8');
    assert.ok(md.startsWith('# Verify AI Output\n\n- [ ] Verify 422 status\n- [ ] Verify error message\n'));

    // 2. NoteStore: CRUD, default title, RTL/LTR content, and optimistic concurrency (revision + lock)
    const noteStore = new NoteStore(sharedDir);
    const n1 = noteStore.save({title: '', content: 'Check rating_client.py edge cases'});
    assert.equal(n1.title, 'Untitled note');
    assert.ok(n1.revision);
    const n2 = noteStore.save({title: 'Simulation Notes', content: 'הערה לדוגמה עם `pytest`'});
    assert.equal(noteStore.list().items.length, 2);
    const n2Updated = noteStore.save({id: n2.id, revision: n2.revision, title: 'Updated Notes', content: 'Updated body'});
    assert.equal(n2Updated.id, n2.id);
    assert.notEqual(n2Updated.revision, n2.revision);
    assert.equal(noteStore.read(n2.id).title, 'Updated Notes');

    // Stale revision from another window must be rejected without overwriting newer edits
    assert.throws(
      () => noteStore.save({id: n2.id, revision: n2.revision, title: 'Stale Overwrite', content: 'Lost edit'}),
      /changed elsewhere/
    );
    assert.equal(noteStore.read(n2.id).title, 'Updated Notes');
    assert.throws(() => noteStore.remove(n2.id, n2.revision), /changed elsewhere/);

    // Legacy note without a revision field on disk still reads and upgrades cleanly
    const legacyId = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(path.join(noteStore.root, legacyId + '.json'), JSON.stringify({
      id: legacyId, title: 'Legacy Note', content: 'Old format', updatedAt: 1000
    }));
    const legacyRead = noteStore.read(legacyId);
    assert.equal(legacyRead.revision, null);
    const legacyUpgraded = noteStore.save({id: legacyId, revision: null, title: 'Legacy Note', content: 'Upgraded'});
    assert.ok(legacyUpgraded.revision);
    noteStore.remove(legacyId, legacyUpgraded.revision);

    noteStore.remove(n1.id, n1.revision);
    assert.equal(noteStore.list().items.length, 1);

    // 3. OutputStore: nested Markdown files, path traversal protection, checkbox toggling
    const outputStore = new OutputStore(sharedDir);
    const savedOut = outputStore.save('quote/03-test-scenarios', '# Test Scenarios\n\n| ID | Case |\n| --- | --- |\n| S01 | Valid |\n\n- [ ] Check 422\n- [x] Check 200\n');
    assert.equal(savedOut.relPath, 'quote/03-test-scenarios.md');
    assert.equal(outputStore.list().items.length, 1);
    assert.throws(() => outputStore.save('../escape.md', 'nope'), /Invalid document path/);
    assert.throws(() => outputStore.read('../../outside.md'), /Invalid document path/);

    const toggled1 = outputStore.toggleCheckbox('quote/03-test-scenarios.md', 6);
    assert.ok(toggled1.content.includes('- [x] Check 422'));
    const toggled2 = outputStore.toggleCheckbox('quote/03-test-scenarios.md', 6);
    assert.ok(toggled2.content.includes('- [ ] Check 422'));

    // 3b. SkillStore: SKILL.md YAML frontmatter, CRUD, rename, checkbox toggle, and 1-click export
    const skillStore = new SkillStore(sharedDir);
    const savedSkill = skillStore.save({
      name: 'API Contract Validator!',
      description: 'Use this skill when validating FastAPI endpoints and negative 422 contracts.',
      body: '# API Contract Validator\n\n## Steps\n\n- [ ] Run pytest contract suite\n- [x] Inspect OpenAPI schema\n'
    });
    assert.equal(savedSkill.slug, 'api-contract-validator');
    assert.equal(skillStore.list().items.length, 1);

    const readSkill = skillStore.read('api-contract-validator');
    assert.equal(readSkill.name, 'api-contract-validator');
    assert.equal(readSkill.description, 'Use this skill when validating FastAPI endpoints and negative 422 contracts.');
    assert.ok(readSkill.content.startsWith('---\nname: api-contract-validator\ndescription: >-\n'));
    assert.ok(readSkill.body.startsWith('# API Contract Validator'));

    // Frontmatter parse & build round-trip
    const parsedFm = parseSkillMarkdown(buildSkillMarkdown({
      name: 'db-migration-check',
      description: 'Line one.\nLine two.',
      body: '# DB Check\n\nRun alembic.'
    }));
    assert.equal(parsedFm.name, 'db-migration-check');
    assert.equal(parsedFm.description, 'Line one. Line two.');
    assert.equal(parsedFm.body, '# DB Check\n\nRun alembic.\n');

    // Rename skill removes old slug directory cleanly
    const renamedSkill = skillStore.save({
      previousSlug: 'api-contract-validator',
      name: 'fastapi-contract-validator',
      description: 'Updated description for FastAPI contracts.',
      body: readSkill.body
    });
    assert.equal(renamedSkill.slug, 'fastapi-contract-validator');
    assert.equal(skillStore.list().items.length, 1);
    assert.throws(() => skillStore.read('api-contract-validator'), /Skill not found/);

    // Checkbox toggle inside SKILL.md
    const skillLines = skillStore.read('fastapi-contract-validator').content.split(/\r?\n/);
    const cbIdx = skillLines.findIndex(l => l.includes('- [ ] Run pytest contract suite'));
    assert.ok(cbIdx > 0);
    const toggledSkill = skillStore.toggleCheckbox('fastapi-contract-validator', cbIdx);
    assert.ok(toggledSkill.content.includes('- [x] Run pytest contract suite'));

    // Export skill to project .agents/skills and global ~/.gemini/config/skills
    const fakeProjectDir = path.join(tmpBase, 'my-project');
    const fakeGlobalDir = path.join(tmpBase, 'global-config');
    const exportedProj = skillStore.exportToDir('fastapi-contract-validator', path.join(fakeProjectDir, '.agents', 'skills'));
    assert.ok(fs.existsSync(exportedProj.exportedPath));
    assert.equal(fs.readFileSync(exportedProj.exportedPath, 'utf8'), toggledSkill.content);

    // 4. editorContext: formatSnippet (single line, range, backtick fence escaping)
    const single = formatSnippet({fileName: 'a.py', languageId: 'python', startLine: 5, endLine: 5, text: 'x = 1'});
    assert.equal(single, 'File: `a.py` (line 5)\n```python\nx = 1\n```');
    const nested = formatSnippet({fileName: 'doc.md', languageId: 'markdown', startLine: 1, endLine: 3, text: '```py\nx\n```'});
    assert.ok(nested.includes('````markdown'));

    // 5. messageRouter: dispatch smoke test
    const posted = [];
    let refreshedLib = 0;
    const router = createMessageRouter({
      vscode: {
        env: {clipboard: {writeText: async () => {}}},
        workspace: {workspaceFolders: [{uri: {scheme: 'file', fsPath: fakeProjectDir}}]}
      },
      globalConfigRoot: fakeGlobalDir,
      getStore: () => sharedStore,
      getNoteStore: () => noteStore,
      getOutputStore: () => outputStore,
      getSkillStore: () => skillStore,
      refreshLibrary: () => { refreshedLib++; },
      refreshNotes: () => {},
      refreshOutputs: () => {},
      refreshSkills: () => {},
      refreshAll: () => {}
    }, {postMessage: msg => posted.push(msg)});

    await router.dispatch({type: 'togglePin', id: created.id});
    assert.equal(refreshedLib, 1);
    assert.equal(posted[0].type, 'pinToggled');
    assert.equal(posted[0].pinned, true);

    await router.dispatch({type: 'readOutput', relPath: 'quote/03-test-scenarios.md', target: 'split'});
    assert.equal(posted[1].type, 'outputContent');
    assert.equal(posted[1].target, 'split');

    await router.dispatch({type: 'exportSkill', slug: 'fastapi-contract-validator', target: 'global'});
    assert.equal(posted[2].type, 'skillExported');
    assert.equal(posted[2].target, 'global');
    assert.ok(fs.existsSync(path.join(fakeGlobalDir, 'skills', 'fastapi-contract-validator', 'SKILL.md')));

    outputStore.remove('quote/03-test-scenarios.md');
    assert.equal(outputStore.list().items.length, 0);
    skillStore.remove('fastapi-contract-validator');
    assert.equal(skillStore.list().items.length, 0);

    // 6. Webview pure helpers: template variables & Markdown table parsing
    assert.deepEqual(extractVariables('Hello {{endpoint}} and {{my_prompt}} and {{endpoint}}'), ['endpoint', 'my_prompt']);
    assert.equal(isMultilineVar('my_prompt'), true);
    assert.equal(isMultilineVar('endpoint_slug'), false);
    assert.equal(renderTemplate('Test {{a}} -> {{b}}', {a: 'POST /orders'}), 'Test POST /orders -> {{b}}');
    assert.equal(slugify('03. Test Scenario Design!'), '03-test-scenario-design');
    assert.deepEqual(splitTableRow('| ID | Status |'), ['ID', 'Status']);
    assert.equal(isTableSeparator('| --- | :---: |'), true);
    assert.equal(isTableSeparator('| ID | Status |'), false);

    // 7. pendingPopout: matches target workspace once, ignores mismatch & expired entries
    const popFile = path.join(sharedDir, PENDING_FILE);
    const targetFolder = path.join(tmpBase, 'sim-2');
    fs.writeFileSync(popFile, JSON.stringify({folder: targetFolder, createdAt: 100000}));
    assert.equal(consumePendingPopOut(sharedDir, [path.join(tmpBase, 'other')], 105000), false);
    assert.equal(fs.existsSync(popFile), true, 'Non-matching window must not consume pending pop-out');
    assert.equal(consumePendingPopOut(sharedDir, [targetFolder], 105000), true);
    assert.equal(fs.existsSync(popFile), false, 'Matching window must consume pending pop-out once');
    fs.writeFileSync(popFile, JSON.stringify({folder: targetFolder, createdAt: 100000}));
    assert.equal(consumePendingPopOut(sharedDir, [targetFolder], 200000), false, 'Expired entry must be ignored');
    assert.equal(fs.existsSync(popFile), false);

    console.log('ALL TESTS PASSED');
  } finally {
    fs.rmSync(tmpBase, {recursive: true, force: true});
  }
}

run().catch(e => { console.error(e); process.exit(1); });
