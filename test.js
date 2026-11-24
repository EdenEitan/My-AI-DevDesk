const {describe, it, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  Store,
  NoteStore,
  OutputStore,
  SkillStore,
  normalizeSlug,
  parseSkillMarkdown,
  buildSkillMarkdown,
  categories,
  UUID_RE
} = require('./src/storage');
const {resolveStorageDir, getFontScale, legacyStorageDirs} = require('./src/host/config');
const {captureSelection, captureFile, formatSnippet} = require('./src/host/editorContext');
const {executable} = require('./src/host/adapt');
const {createMessageRouter} = require('./src/host/messageRouter');
const {PENDING_FILE, consumePendingPopOut} = require('./src/host/pendingPopout');
const {extractVariables, isMultilineVar, renderTemplate, escapeRegExp, slugify} = require('./src/webview/core');
const {splitTableRow, isTableSeparator} = require('./src/webview/markdown');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eden-hub-test-'));
}

describe('1. PromptStore (CRUD, pins, checklists, locks & legacy migration)', () => {
  let tmpBase;
  let sharedDir;
  let legacyDir;

  beforeEach(() => {
    tmpBase = makeTempDir();
    sharedDir = path.join(tmpBase, 'shared');
    legacyDir = path.join(tmpBase, 'legacy');
  });

  afterEach(() => {
    fs.rmSync(tmpBase, {recursive: true, force: true});
  });

  it('creates, reads, updates, pins, and removes prompts with attached checklists', () => {
    const store = new Store(sharedDir);
    const created = store.save({
      title: '  API Negative Test  ',
      category: categories[1],
      description: 'Check {{endpoint}} validation',
      content: 'Write a pytest for {{endpoint}} when {{field}} is invalid.',
      items: 'Verify 422 status\n- [x] Verify error message'
    });

    assert.match(created.id, UUID_RE);
    assert.match(created.revision, UUID_RE);
    assert.match(created.checklist, UUID_RE);
    assert.equal(created.title, 'API Negative Test');
    assert.equal(created.pinned, false);

    const checklistMd = fs.readFileSync(store.file(created.checklist, '.md'), 'utf8');
    assert.equal(
      checklistMd,
      '# Verify AI Output\n\n- [ ] Verify 422 status\n- [ ] Verify error message\n'
    );

    // Pin toggle
    assert.equal(store.togglePin(created.id).pinned, true);
    assert.equal(store.read(created.id).pinned, true);
    const afterPinRev = store.read(created.id).revision;

    // Update content & remove checklist
    const updated = store.save({
      id: created.id,
      revision: afterPinRev,
      title: 'API Negative Test v2',
      category: categories[1],
      description: 'Updated description',
      content: 'Updated content for {{endpoint}}',
      removeChecklist: true
    });
    assert.equal(updated.checklist, null);
    assert.equal(updated.pinned, true, 'Pin state must be preserved on edit');
    assert.equal(fs.existsSync(store.file(created.checklist, '.md')), false);

    // Delete prompt
    store.remove(updated.id, updated.revision);
    assert.equal(store.list().rows.length, 0);
  });

  it('rejects invalid inputs, stale revisions, and concurrent lock conflicts', () => {
    const store = new Store(sharedDir);
    assert.throws(
      () => store.save({title: '', category: categories[0], description: '', content: 'Body'}),
      /Enter a title, category and prompt content/
    );
    assert.throws(
      () => store.save({title: 'Valid', category: 'Unknown Category', description: '', content: 'Body'}),
      /Enter a title, category and prompt content/
    );
    assert.throws(() => store.file('../bad-id', '.json'), /Invalid record identifier/);

    const saved = store.save({
      title: 'Concurrency Check',
      category: categories[0],
      description: 'Test lock & revision',
      content: 'Prompt content'
    });

    const staleRev = saved.revision;
    const latest = store.save({
      id: saved.id,
      revision: staleRev,
      title: 'Concurrency Check Updated',
      category: categories[0],
      description: 'Newer',
      content: 'Prompt content v2'
    });

    assert.throws(
      () => store.save({
        id: saved.id,
        revision: staleRev,
        title: 'Overwrite attempt',
        category: categories[0],
        description: '',
        content: 'Lost update'
      }),
      /changed elsewhere/
    );

    // Simulate active .lock file
    const lockFile = store.file(saved.id, '.lock');
    fs.writeFileSync(lockFile, '');
    try {
      assert.throws(
        () => store.save({
          id: saved.id,
          revision: latest.revision,
          title: 'Locked edit',
          category: categories[0],
          description: '',
          content: 'Body'
        }),
        /locked by another edit/
      );
    } finally {
      fs.rmSync(lockFile, {force: true});
    }
  });

  it('migrates non-destructively from legacy directories and surfaces warnings for corrupted files', () => {
    const legacyStore = new Store(legacyDir);
    const p = legacyStore.save({
      title: 'Legacy Prompt',
      category: categories[2],
      description: 'From old globalStorage',
      content: 'Hello {{name}}',
      items: 'Check output'
    });

    const sharedStore = new Store(sharedDir);
    assert.equal(sharedStore.migrateFromIfEmpty([legacyDir]), 2);
    assert.equal(sharedStore.migrateFromIfEmpty([legacyDir]), 0, 'Must not re-migrate when non-empty');
    assert.equal(legacyStore.list().rows.length, 1, 'Legacy files must remain untouched');

    // Corrupt JSON file and missing checklist warning
    fs.writeFileSync(path.join(sharedDir, 'corrupt.json'), '{not-valid-json');
    fs.rmSync(sharedStore.file(p.checklist, '.md'), {force: true});

    const listed = sharedStore.list();
    assert.equal(listed.rows.length, 1);
    assert.equal(listed.rows[0].checklist, null);
    assert.equal(listed.warnings.length, 2);
    assert.ok(listed.warnings.some(w => w.includes('Checklist missing')));
    assert.ok(listed.warnings.some(w => w.includes('Could not read corrupt.json')));
  });
});

describe('2. NoteStore (CRUD, RTL/LTR notes, optimistic concurrency & legacy upgrade)', () => {
  let tmpBase;
  let noteStore;

  beforeEach(() => {
    tmpBase = makeTempDir();
    noteStore = new NoteStore(tmpBase);
  });

  afterEach(() => {
    fs.rmSync(tmpBase, {recursive: true, force: true});
  });

  it('saves, updates, sorts, and deletes notes with default titles and RTL/LTR content', () => {
    const n1 = noteStore.save({title: '   ', content: 'Check rating_client.py edge cases'});
    assert.equal(n1.title, 'Untitled note');
    assert.match(n1.revision, UUID_RE);

    const n2 = noteStore.save({title: 'Simulation Notes', content: 'הערה בעברית עם `pytest -q`'});
    assert.equal(noteStore.list().items.length, 2);

    const n2Updated = noteStore.save({
      id: n2.id,
      revision: n2.revision,
      title: 'Updated Simulation Notes',
      content: 'תוכן מעודכן'
    });
    assert.equal(n2Updated.id, n2.id);
    assert.notEqual(n2Updated.revision, n2.revision);
    assert.equal(noteStore.read(n2.id).title, 'Updated Simulation Notes');

    // Reject stale revision overwrite
    assert.throws(
      () => noteStore.save({id: n2.id, revision: n2.revision, title: 'Stale', content: 'Overwrite'}),
      /changed elsewhere/
    );
    assert.throws(() => noteStore.remove(n2.id, n2.revision), /changed elsewhere/);

    noteStore.remove(n1.id, n1.revision);
    assert.equal(noteStore.list().items.length, 1);
  });

  it('transparently upgrades legacy notes without a revision field on disk', () => {
    const legacyId = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(path.join(noteStore.root, legacyId + '.json'), JSON.stringify({
      id: legacyId,
      title: 'Legacy Note',
      content: 'Old format without revision',
      updatedAt: 1000
    }));

    const readLegacy = noteStore.read(legacyId);
    assert.equal(readLegacy.revision, null);

    const upgraded = noteStore.save({
      id: legacyId,
      revision: null,
      title: 'Legacy Note Upgraded',
      content: 'New format with revision'
    });
    assert.match(upgraded.revision, UUID_RE);
    noteStore.remove(legacyId, upgraded.revision);
    assert.equal(noteStore.list().items.length, 0);
  });
});

describe('3. OutputStore (Nested Markdown outputs, path-traversal guards & interactive checkboxes)', () => {
  let tmpBase;
  let outputStore;

  beforeEach(() => {
    tmpBase = makeTempDir();
    outputStore = new OutputStore(tmpBase);
  });

  afterEach(() => {
    fs.rmSync(tmpBase, {recursive: true, force: true});
  });

  it('saves and lists nested Markdown documents and blocks path traversal attempts', () => {
    const saved = outputStore.save(
      'quote/03-test-scenarios',
      '# Test Scenarios\n\n| ID | Case |\n| --- | --- |\n| S01 | Valid |\n\n- [ ] Check 422\n- [x] Check 200\n'
    );
    assert.equal(saved.relPath, 'quote/03-test-scenarios.md');
    const listed = outputStore.list();
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].folder, 'quote');
    assert.equal(listed.items[0].name, '03-test-scenarios.md');

    assert.throws(() => outputStore.save('../escape.md', 'nope'), /Invalid document path/);
    assert.throws(() => outputStore.read('../../outside.md'), /Invalid document path/);
    assert.throws(() => outputStore.save('   ', 'nope'), /Enter a document filename/);
  });

  it('toggles task list checkboxes in-place and validates line bounds', () => {
    outputStore.save('plan.md', '# Plan\n\n- [ ] First task\n- [X] Second task\nRegular line\n');
    const t1 = outputStore.toggleCheckbox('plan.md', 2);
    assert.ok(t1.content.includes('- [x] First task'));
    const t2 = outputStore.toggleCheckbox('plan.md', 3);
    assert.ok(t2.content.includes('- [ ] Second task'));

    assert.throws(() => outputStore.toggleCheckbox('plan.md', 99), /out of range/);
    assert.throws(() => outputStore.toggleCheckbox('plan.md', 4), /not a Markdown checkbox/);

    outputStore.remove('plan.md');
    assert.equal(outputStore.list().items.length, 0);
  });
});

describe('4. SkillStore (SKILL.md YAML frontmatter, CRUD, rename, checkboxes & project/global export)', () => {
  let tmpBase;
  let skillStore;

  beforeEach(() => {
    tmpBase = makeTempDir();
    skillStore = new SkillStore(tmpBase);
  });

  afterEach(() => {
    fs.rmSync(tmpBase, {recursive: true, force: true});
  });

  it('parses and serializes YAML frontmatter (folded >-, literal |, quoted, and single-line)', () => {
    assert.equal(normalizeSlug('  My Custom_Skill! 01 '), 'my-custom-skill-01');
    assert.throws(() => normalizeSlug('   '), /Enter a valid skill name/);

    const built = buildSkillMarkdown({
      name: 'db-migration-check',
      description: 'First line.\nSecond line.',
      body: '# DB Check\n\nRun alembic.'
    });
    const parsed = parseSkillMarkdown(built);
    assert.equal(parsed.name, 'db-migration-check');
    assert.equal(parsed.description, 'First line. Second line.');
    assert.equal(parsed.body, '# DB Check\n\nRun alembic.\n');

    // Quoted & literal block scalar frontmatter
    const literalRaw = [
      '---',
      'name: "quoted-skill"',
      'description: |',
      '  Keep line 1',
      '  Keep line 2',
      '---',
      '',
      '# Quoted Skill'
    ].join('\n');
    const parsedLiteral = parseSkillMarkdown(literalRaw);
    assert.equal(parsedLiteral.name, 'quoted-skill');
    assert.equal(parsedLiteral.description, 'Keep line 1\nKeep line 2');
    assert.equal(parsedLiteral.body, '# Quoted Skill');
  });

  it('supports structured and raw SKILL.md saves, renames, checkbox toggling, and 1-click export', () => {
    const saved = skillStore.save({
      name: 'API Contract Validator!',
      description: 'Use this skill when validating FastAPI endpoints and negative 422 contracts.',
      body: '# API Contract Validator\n\n## Steps\n\n- [ ] Run pytest contract suite\n- [x] Inspect OpenAPI schema\n'
    });
    assert.equal(saved.slug, 'api-contract-validator');
    assert.equal(skillStore.list().items.length, 1);

    // Rename skill removes old folder
    const renamed = skillStore.save({
      previousSlug: 'api-contract-validator',
      name: 'fastapi-contract-validator',
      description: 'Updated description for FastAPI contracts.',
      body: skillStore.read('api-contract-validator').body
    });
    assert.equal(renamed.slug, 'fastapi-contract-validator');
    assert.equal(skillStore.list().items.length, 1);
    assert.throws(() => skillStore.read('api-contract-validator'), /Skill not found/);

    // Raw SKILL.md edit
    const rawSaved = skillStore.save({
      slug: 'fastapi-contract-validator',
      previousSlug: 'fastapi-contract-validator',
      rawContent: '---\nname: fastapi-contract-validator\ndescription: Single line trigger\n---\n\n# Raw Edited\n\n- [ ] Verify raw edit\n'
    });
    const afterRaw = skillStore.read(rawSaved.slug);
    assert.equal(afterRaw.description, 'Single line trigger');

    // Toggle checkbox
    const lines = afterRaw.content.split(/\r?\n/);
    const cbLine = lines.findIndex(l => l.includes('- [ ] Verify raw edit'));
    const toggled = skillStore.toggleCheckbox('fastapi-contract-validator', cbLine);
    assert.ok(toggled.content.includes('- [x] Verify raw edit'));

    // Export to project & global directories
    const exportRoot = path.join(tmpBase, 'workspace', '.agents', 'skills');
    const exported = skillStore.exportToDir('fastapi-contract-validator', exportRoot);
    assert.ok(fs.existsSync(exported.exportedPath));
    assert.equal(fs.readFileSync(exported.exportedPath, 'utf8'), toggled.content);

    skillStore.remove('fastapi-contract-validator');
    assert.equal(skillStore.list().items.length, 0);
  });
});

describe('5. Host Config, EditorContext, Adapt CLI Resolution & PendingPopout', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpBase, {recursive: true, force: true});
  });

  it('resolves storage directory (~ expansion & defaults), font scale, and legacy dirs', () => {
    const fakeVscode = (storagePath, fontScale) => ({
      workspace: {
        getConfiguration: () => ({
          get: (key, def) => (key === 'storagePath' ? storagePath : (fontScale ?? def))
        })
      }
    });

    assert.equal(resolveStorageDir(fakeVscode('', 'md')), path.join(os.homedir(), '.edens-prompt-hub'));
    assert.equal(resolveStorageDir(fakeVscode('~/custom-hub', 'md')), path.join(os.homedir(), 'custom-hub'));
    assert.equal(getFontScale(fakeVscode('', 'lg')), 'lg');
    assert.equal(getFontScale(fakeVscode('', 'invalid-scale')), 'md');

    const legacy = legacyStorageDirs({globalStorageUri: {fsPath: path.join(tmpBase, 'global')}});
    assert.ok(Array.isArray(legacy) && legacy.length >= 1);
    assert.equal(legacy[0], path.join(tmpBase, 'global'));
  });

  it('captures editor selections, active files, and escapes nested backtick code fences', () => {
    assert.equal(captureSelection({}, null), null);
    assert.equal(captureFile(null), '');
    assert.equal(captureFile({document: {uri: {scheme: 'untitled', fsPath: 'Untitled-1'}}}), '');
    assert.equal(captureFile({document: {uri: {scheme: 'file', fsPath: '/repo/app.py'}}}), '/repo/app.py');

    const fakeEditor = {
      selection: {isEmpty: false, start: {line: 9}, end: {line: 14}},
      document: {
        uri: {scheme: 'file', fsPath: '/repo/src/auth.py'},
        isUntitled: false,
        languageId: 'python',
        getText: () => 'def login():\n    return True'
      }
    };
    const fakeVscode = {workspace: {asRelativePath: () => 'src/auth.py'}};
    const captured = captureSelection(fakeVscode, fakeEditor);
    assert.deepEqual(captured, {
      text: 'def login():\n    return True',
      fileName: 'src/auth.py',
      languageId: 'python',
      startLine: 10,
      endLine: 15
    });

    const single = formatSnippet({fileName: 'a.py', languageId: 'python', startLine: 5, endLine: 5, text: 'x = 1'});
    assert.equal(single, 'File: `a.py` (line 5)\n```python\nx = 1\n```');

    const nested = formatSnippet({fileName: 'doc.md', languageId: 'markdown', startLine: 1, endLine: 3, text: '```py\nx\n```'});
    assert.ok(nested.startsWith('File: `doc.md` (lines 1-3)\n````markdown\n'));
    assert.ok(nested.endsWith('\n````'));

    assert.match(executable(undefined), /^codex(\.exe)?$/);
  });

  it('consumes pending pop-out marker once for matching workspace and expires old markers', () => {
    const popFile = path.join(tmpBase, PENDING_FILE);
    const targetFolder = path.join(tmpBase, 'project-a');

    fs.writeFileSync(popFile, JSON.stringify({folder: targetFolder, createdAt: 100000}));
    assert.equal(consumePendingPopOut(tmpBase, [path.join(tmpBase, 'other')], 105000), false);
    assert.equal(fs.existsSync(popFile), true);
    assert.equal(consumePendingPopOut(tmpBase, [targetFolder], 105000), true);
    assert.equal(fs.existsSync(popFile), false);

    fs.writeFileSync(popFile, JSON.stringify({folder: targetFolder, createdAt: 100000}));
    assert.equal(consumePendingPopOut(tmpBase, [targetFolder], 250000), false);
    assert.equal(fs.existsSync(popFile), false);
  });
});

describe('6. MessageRouter End-to-End Dispatch (Prompts, Notes, Outputs, Skills & Clipboard)', () => {
  let tmpBase;
  let store;
  let noteStore;
  let outputStore;
  let skillStore;
  let posted;
  let clipboardText;
  let projectDir;
  let globalDir;
  let router;

  beforeEach(() => {
    tmpBase = makeTempDir();
    const hubDir = path.join(tmpBase, 'hub');
    projectDir = path.join(tmpBase, 'workspace-proj');
    globalDir = path.join(tmpBase, 'global-gemini');
    fs.mkdirSync(projectDir, {recursive: true});

    store = new Store(hubDir);
    noteStore = new NoteStore(hubDir);
    outputStore = new OutputStore(hubDir);
    skillStore = new SkillStore(hubDir);
    posted = [];
    clipboardText = '---\nname: pasted-skill\ndescription: From clipboard\n---\n\n# Pasted Skill';

    router = createMessageRouter({
      vscode: {
        env: {
          clipboard: {
            writeText: async t => { clipboardText = t; },
            readText: async () => clipboardText
          }
        },
        workspace: {
          workspaceFolders: [{uri: {scheme: 'file', fsPath: projectDir}}],
          textDocuments: [],
          getConfiguration: () => ({update: async () => {}})
        },
        window: {
          showWarningMessage: async () => 'Delete',
          activeTextEditor: null
        },
        ConfigurationTarget: {Global: 1},
        commands: {
          getCommands: async () => ['antigravity.panel.focus'],
          executeCommand: async () => {}
        },
        extensions: {getExtension: () => ({extensionPath: tmpBase})}
      },
      globalConfigRoot: globalDir,
      getStore: () => store,
      getNoteStore: () => noteStore,
      getOutputStore: () => outputStore,
      getSkillStore: () => skillStore,
      getLastSelection: () => ({fileName: 'main.py', languageId: 'python', startLine: 1, endLine: 2, text: 'pass'}),
      getLastFile: () => '',
      setLastFile: () => {},
      broadcast: msg => posted.push(msg),
      refreshLibrary: () => {},
      refreshNotes: () => {},
      refreshOutputs: () => {},
      refreshSkills: () => {},
      refreshAll: () => {},
      ensureDashboard: () => {},
      verify: async () => {}
    }, {postMessage: msg => posted.push(msg)});
  });

  afterEach(() => {
    router.dispose();
    fs.rmSync(tmpBase, {recursive: true, force: true});
  });

  it('dispatches prompt, note, output, and skill lifecycle actions and reports errors cleanly', async () => {
    // Save & pin prompt
    await router.dispatch({
      type: 'save',
      title: 'Router Prompt',
      category: categories[0],
      description: 'Desc',
      content: 'Test {{var}}'
    });
    assert.equal(store.list().rows.length, 1);
    assert.ok(posted.some(m => m.type === 'done' && m.action === 'save'));

    const promptId = store.list().rows[0].id;
    await router.dispatch({type: 'togglePin', id: promptId});
    assert.ok(posted.some(m => m.type === 'pinToggled' && m.pinned === true));

    // Save & delete note
    await router.dispatch({type: 'saveNote', title: 'Quick Note', content: 'Body'});
    const savedNoteMsg = posted.find(m => m.type === 'noteSaved');
    assert.ok(savedNoteMsg);
    await router.dispatch({type: 'deleteNote', id: savedNoteMsg.note.id, revision: savedNoteMsg.note.revision});
    assert.ok(posted.some(m => m.type === 'noteDeleted'));

    // Save, read, toggle checkbox & delete output
    await router.dispatch({type: 'saveOutput', relPath: 'specs/api.md', content: '# API\n\n- [ ] Item 1\n'});
    assert.ok(posted.some(m => m.type === 'outputSaved' && m.relPath === 'specs/api.md'));
    await router.dispatch({type: 'toggleOutputCheckbox', relPath: 'specs/api.md', lineIndex: 2, target: 'split'});
    assert.ok(posted.some(m => m.type === 'outputContent' && m.target === 'split' && m.content.includes('- [x] Item 1')));
    await router.dispatch({type: 'deleteOutput', relPath: 'specs/api.md'});
    assert.ok(posted.some(m => m.type === 'outputDeleted'));

    // Save, read, paste, export (project + global) & delete skill
    await router.dispatch({
      type: 'saveSkill',
      name: 'router-test-skill',
      description: 'Use when testing messageRouter skill handlers.',
      body: '# Router Skill\n\n- [ ] Check export\n'
    });
    assert.ok(posted.some(m => m.type === 'skillSaved' && m.slug === 'router-test-skill'));

    await router.dispatch({type: 'exportSkill', slug: 'router-test-skill', target: 'project', folder: projectDir});
    assert.ok(fs.existsSync(path.join(projectDir, '.agents', 'skills', 'router-test-skill', 'SKILL.md')));

    await router.dispatch({type: 'exportSkill', slug: 'router-test-skill', target: 'global'});
    assert.ok(fs.existsSync(path.join(globalDir, 'skills', 'router-test-skill', 'SKILL.md')));

    await router.dispatch({type: 'pasteSkillFromClipboard'});
    assert.ok(posted.some(m => m.type === 'clipboardForSkill' && m.content.includes('pasted-skill')));

    await router.dispatch({type: 'deleteSkill', slug: 'router-test-skill'});
    assert.ok(posted.some(m => m.type === 'skillDeleted' && m.slug === 'router-test-skill'));

    // Selection insertion & error handling
    await router.dispatch({type: 'insertSelection', target: 'draft'});
    assert.ok(posted.some(m => m.type === 'selectionInserted' && m.snippet.includes('main.py')));

    await router.dispatch({type: 'readSkill', slug: 'non-existent-skill'});
    assert.ok(posted.some(m => m.type === 'error' && /Skill not found/.test(m.message)));
  });
});

describe('7. Webview Pure Helpers (Variables, Templates, Slugify & Markdown Table Parsing)', () => {
  it('extracts unique template variables, detects multiline variables, and renders templates', () => {
    assert.deepEqual(
      extractVariables('Hello {{endpoint}} and {{ my_prompt }} and {{endpoint}}!'),
      ['endpoint', 'my_prompt']
    );
    assert.equal(isMultilineVar('my_prompt'), true);
    assert.equal(isMultilineVar('study_material'), true);
    assert.equal(isMultilineVar('code_snippet'), true);
    assert.equal(isMultilineVar('endpoint_slug'), false);

    assert.equal(
      renderTemplate('Test {{a}} -> {{b}}', {a: 'POST /orders', b: ''}),
      'Test POST /orders -> {{b}}'
    );
    assert.equal(escapeRegExp('a+b*c?'), 'a\\+b\\*c\\?');
    assert.equal(slugify('03. Test Scenario Design!'), '03-test-scenario-design');
    assert.equal(slugify('   '), 'output');
  });

  it('parses Markdown table rows and alignment separators accurately', () => {
    assert.deepEqual(splitTableRow('| ID | Scenario | Expected |'), ['ID', 'Scenario', 'Expected']);
    assert.deepEqual(splitTableRow('ID | Scenario'), ['ID', 'Scenario']);
    assert.equal(isTableSeparator('| --- | :---: | ---: |'), true);
    assert.equal(isTableSeparator('| :--- | --- |'), true);
    assert.equal(isTableSeparator('| ID | Status |'), false);
    assert.equal(isTableSeparator('---'), false);
  });
});

describe('8. Static Security, CSP Nonce & Webview Asset Contract', () => {
  const repoRoot = __dirname;
  const html = fs.readFileSync(path.join(repoRoot, 'src', 'webview', 'index.html'), 'utf8');
  const extJs = fs.readFileSync(path.join(repoRoot, 'extension.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  it('enforces a strict Content-Security-Policy with nonce and zero innerHTML across webview scripts', () => {
    assert.match(html, /default-src 'none'; style-src WEB_SOURCE; script-src 'nonce-NONCE_VALUE'/);

    const webviewDir = path.join(repoRoot, 'src', 'webview');
    const jsFiles = fs.readdirSync(webviewDir).filter(f => f.endsWith('.js'));
    assert.ok(jsFiles.length >= 8);
    for (const file of jsFiles) {
      const source = fs.readFileSync(path.join(webviewDir, file), 'utf8');
      assert.equal(
        /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b/.test(source),
        false,
        `Webview script ${file} must not use innerHTML/outerHTML (pure DOM required for XSS safety)`
      );
    }
  });

  it('wires all index.html URI placeholders in extension.js and validates package.json entrypoints', () => {
    const placeholders = [
      'WEB_SOURCE',
      'NONCE_VALUE',
      'STYLE_URI',
      'SCRIPT_CORE_URI',
      'SCRIPT_MARKDOWN_URI',
      'SCRIPT_PROMPTS_URI',
      'SCRIPT_NOTES_URI',
      'SCRIPT_OUTPUTS_URI',
      'SCRIPT_SKILLS_URI',
      'SCRIPT_SPLIT_URI',
      'SCRIPT_MAIN_URI',
      'VIEW_MODE'
    ];
    for (const token of placeholders) {
      assert.ok(html.includes(token), `index.html missing placeholder ${token}`);
      assert.ok(extJs.includes(token), `extension.js missing replacement for ${token}`);
    }
    assert.equal(pkg.main, './extension.js');
    assert.ok(fs.existsSync(path.join(repoRoot, pkg.main)));
  });
});
