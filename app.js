'use strict';
const api = acquireVsCodeApi();
const el = id => document.getElementById(id);
const send = (type, data = {}) => api.postMessage({type, ...data});

const ALL = '__ALL__';
const symbols = ['⌘', '✓', '✦', '◇', '☀'];
const savedState = api.getState() || {};

let activeModule = savedState.activeModule || 'prompts';
let splitOpen = Boolean(savedState.splitOpen);
let splitTab = savedState.splitTab === 'outputs' ? 'outputs' : 'notes';
let activePromptScreen = 'browse';
let fontScale = 'md';
let request = 0;
let adapting = false;
let rows = [];
let categories = [];
let selectedCategory = ALL;
let editing = null;
let pending = false;
let outputsPath = '';

// Customize state
let activeCustomPrompt = null;
let customTemplate = '';
let draftManuallyEdited = false;
let varValues = {};
let varInputs = {};
let outputDest = 'project';

// Notes state
let notes = [];
let activeNoteId = null;
let noteSaveTimer = null;
let noteDirty = false;

// Split pane state
let splitNoteId = null;
let splitNoteSaveTimer = null;
let splitNoteDirty = false;
let splitOutputPath = null;
let splitOutputFullPath = '';
let splitOutputContent = '';

// Outputs state
let outputs = [];
let activeOutputPath = null;
let activeOutputFullPath = '';
let activeOutputContent = '';
let outputViewMode = 'rendered'; // 'rendered' | 'raw'

let statusTimer = null;

function persistUiState() {
  api.setState({activeModule, splitOpen, splitTab});
}

function showStatus(msg) {
  clearTimeout(statusTimer);
  el('status').textContent = msg || '';
  if (msg) {
    statusTimer = setTimeout(() => {
      if (el('status').textContent === msg) el('status').textContent = '';
    }, 3500);
  }
}

function node(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined && text !== null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

function button(label, fn, cls) {
  const b = node('button', label, cls);
  b.type = 'button';
  b.onclick = fn;
  return b;
}

function flashCopied(btn) {
  if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  clearTimeout(btn._copyTimer);
  btn.textContent = 'Copied ✓';
  btn.classList.add('copied');
  btn._copyTimer = setTimeout(() => {
    btn.textContent = btn.dataset.label;
    btn.classList.remove('copied');
  }, 1500);
}

function formatTime(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return '';
  }
}

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'output';
}

function applyScale(scale) {
  fontScale = ['sm', 'md', 'lg'].includes(scale) ? scale : 'md';
  document.body.classList.remove('scale-sm', 'scale-md', 'scale-lg');
  document.body.classList.add('scale-' + fontScale);
  el('scaleSm').setAttribute('aria-pressed', String(fontScale === 'sm'));
  el('scaleMd').setAttribute('aria-pressed', String(fontScale === 'md'));
  el('scaleLg').setAttribute('aria-pressed', String(fontScale === 'lg'));
}

function switchModule(mod) {
  if (activeModule === 'notes') flushNoteSave();
  if (activeModule === 'prompts') flushSplitNoteSave();
  activeModule = mod;
  persistUiState();
  el('promptsWorkspace').hidden = mod !== 'prompts';
  el('notesModule').hidden = mod !== 'notes';
  el('outputsModule').hidden = mod !== 'outputs';
  el('toggleSplit').hidden = mod !== 'prompts';
  el('tabPrompts').setAttribute('aria-selected', String(mod === 'prompts'));
  el('tabNotes').setAttribute('aria-selected', String(mod === 'notes'));
  el('tabOutputs').setAttribute('aria-selected', String(mod === 'outputs'));
  if (mod === 'outputs' || (mod === 'prompts' && splitOpen && splitTab === 'outputs')) {
    send('refreshOutputs');
  }
}

function extractVariables(text) {
  const seen = new Set();
  const list = [];
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const key = match[1].trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      list.push(key);
    }
  }
  return list;
}

function isMultilineVar(name) {
  return /(prompt|content|material|text|draft|list|tasks|code|notes|body|pasted)/i.test(name);
}

function renderTemplate(template, values) {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (raw, name) => {
    const key = name.trim();
    const val = values[key];
    return val ? val : raw;
  });
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function insertTextAtCursor(area, text) {
  const start = area.selectionStart ?? area.value.length;
  const end = area.selectionEnd ?? area.value.length;
  const before = area.value.slice(0, start);
  const after = area.value.slice(end);
  const prefix = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
  const suffix = after && !after.startsWith('\n') ? '\n\n' : '';
  const inserted = prefix + text + suffix;
  area.value = before + inserted + after;
  const pos = start + inserted.length;
  area.focus();
  area.setSelectionRange(pos, pos);
  return {start, end, after, inserted};
}

/* ==================== PROMPTS MODULE ==================== */

function screen(id) {
  activePromptScreen = id;
  for (const name of ['browse', 'editor', 'custom', 'reader']) el(name).hidden = name !== id;
  showStatus('');
  document.body.classList.toggle('working', id !== 'browse');
  updateSplitInsertButtons();
}

let activeReaderId = null;

function openReader(p) {
  activeReaderId = p.id;
  el('readTitle').textContent = p.title;
  el('readDescription').textContent = p.description;
  el('readContent').textContent = p.content;
  el('readPin').textContent = p.pinned ? '★ Pinned' : '☆ Pin';
  el('readPin').setAttribute('aria-pressed', String(Boolean(p.pinned)));
  el('readPin').onclick = () => send('togglePin', {id: p.id});
  el('readCopy').onclick = () => { send('copy', {text: p.content}); flashCopied(el('readCopy')); };
  el('readAntigravity').onclick = () => send('openAntigravity', {text: p.content});
  el('readCustomize').onclick = () => openCustom(p);
  el('readEdit').onclick = () => edit(p);
  el('readVerify').hidden = !p.checklist;
  el('readVerify').onclick = () => send('verify', {id: p.id});
  screen('reader');
  el('readTitle').focus();
}

function suggestedHubOutputFile() {
  const folderSlug = (varValues.endpoint_slug || '').trim();
  const fileSlug = slugify(activeCustomPrompt?.title || 'output');
  const sep = outputsPath.includes('\\') ? '\\' : '/';
  const base = outputsPath ? outputsPath.replace(/[\\/]+$/, '') : '~/.edens-prompt-hub/outputs';
  if (folderSlug) {
    return base + sep + slugify(folderSlug) + sep + fileSlug + '.md';
  }
  return base + sep + fileSlug + '.md';
}

function buildHubModeInstruction() {
  const target = suggestedHubOutputFile();
  return `Save the Markdown output to "${target}" (do NOT create Markdown files inside the project repo)`;
}

function updateOutputDestUI() {
  const hasOutputModeVar = Boolean(varInputs.output_mode);
  el('destHub').setAttribute('aria-pressed', String(outputDest === 'hub'));
  el('destProject').setAttribute('aria-pressed', String(outputDest === 'project'));
  el('destChat').setAttribute('aria-pressed', String(outputDest === 'chat'));

  if (outputDest === 'hub') {
    el('destHint').textContent = 'Target: ' + suggestedHubOutputFile();
    el('appendHubDirective').hidden = hasOutputModeVar;
  } else if (outputDest === 'chat') {
    el('destHint').textContent = 'Output stays in chat only (no Markdown files created).';
    el('appendHubDirective').hidden = true;
  } else {
    el('destHint').textContent = hasOutputModeVar
      ? 'Uses the prompt’s default project docs path.'
      : 'Default prompt behavior (no extra output directive).';
    el('appendHubDirective').hidden = true;
  }
}

function applyOutputDestination(dest) {
  outputDest = dest;
  const input = varInputs.output_mode;
  if (input) {
    let val = '';
    if (dest === 'hub') val = buildHubModeInstruction();
    else if (dest === 'chat') val = 'chat only';
    input.value = val;
    varValues.output_mode = val;
    if (!draftManuallyEdited) {
      el('draft').value = renderTemplate(customTemplate, varValues);
    } else if (val) {
      el('draft').value = el('draft').value.replace(/\{\{\s*output_mode\s*\}\}/g, val);
    }
  }
  updateOutputDestUI();
}

function openCustom(p) {
  resetAI();
  activeCustomPrompt = p;
  el('customTitle').textContent = p.title;
  customTemplate = p.content;
  draftManuallyEdited = false;
  varValues = {};
  varInputs = {};
  outputDest = 'project';
  el('draft').value = p.content;

  const vars = extractVariables(p.content);
  const panel = el('varsPanel');
  const grid = el('varsGrid');
  if (vars.length) {
    grid.replaceChildren(...vars.map(name => {
      const wrap = node('label', name, 'varField');
      const isLong = isMultilineVar(name);
      const field = document.createElement(isLong ? 'textarea' : 'input');
      if (isLong) {
        field.rows = 3;
      } else {
        field.type = 'text';
      }
      field.dir = 'auto';
      field.placeholder = 'Value for {{' + name + '}}';
      varInputs[name] = field;
      field.oninput = () => {
        varValues[name] = field.value;
        if (name === 'endpoint_slug' && outputDest === 'hub' && varInputs.output_mode) {
          const updatedInst = buildHubModeInstruction();
          varValues.output_mode = updatedInst;
          varInputs.output_mode.value = updatedInst;
          updateOutputDestUI();
        }
        if (!draftManuallyEdited) {
          el('draft').value = renderTemplate(customTemplate, varValues);
        } else if (field.value) {
          const pattern = new RegExp('\\{\\{\\s*' + escapeRegExp(name) + '\\s*\\}\\}', 'g');
          el('draft').value = el('draft').value.replace(pattern, field.value);
        }
      };
      wrap.append(field);
      return wrap;
    }));
    panel.hidden = false;
  } else {
    grid.replaceChildren();
    panel.hidden = true;
  }

  updateOutputDestUI();
  screen('custom');
  if (vars.length) {
    grid.querySelector('input, textarea')?.focus();
  } else {
    el('draft').focus();
  }
}

function renderPrompts() {
  el('countPrompts').textContent = String(rows.length);

  const navItems = [];
  const allBtn = button('', () => { selectedCategory = ALL; el('search').value = ''; screen('browse'); renderPrompts(); });
  allBtn.setAttribute('aria-pressed', String(selectedCategory === ALL));
  allBtn.className = 'category allTone';
  allBtn.append(node('span', '◈', 'glyph'), node('span', 'All prompts'), node('small', String(rows.length)));
  navItems.push(allBtn);

  categories.forEach((c, i) => {
    const b = button('', () => { selectedCategory = c; el('search').value = ''; screen('browse'); renderPrompts(); });
    b.setAttribute('aria-pressed', String(selectedCategory === c));
    b.className = 'category tone' + i;
    b.append(node('span', symbols[i], 'glyph'), node('span', c), node('small', String(rows.filter(p => p.category === c).length)));
    navItems.push(b);
  });
  el('categories').replaceChildren(...navItems);

  const pinned = rows.filter(p => p.pinned);
  if (pinned.length) {
    el('pinnedList').replaceChildren(...pinned.map(p => {
      const item = button('', () => openCustom(p), 'pinnedItem');
      item.title = 'Open "' + p.title + '" in Customize';
      const label = node('span', p.title, 'pinnedLabel');
      label.dir = 'auto';
      item.append(node('span', '★', 'pinnedStar'), label);
      return item;
    }));
  } else {
    el('pinnedList').replaceChildren(node('div', 'Click ☆ on any prompt to pin it here.', 'subtleHint'));
  }

  const query = el('search').value.trim().toLowerCase();
  el('name').textContent = query ? 'Search results' : (selectedCategory === ALL ? 'All prompts' : selectedCategory);

  const visible = rows.filter(p => {
    if (query) return [p.title, p.description, p.content, p.category].some(x => x.toLowerCase().includes(query));
    return selectedCategory === ALL || p.category === selectedCategory;
  });

  el('cards').replaceChildren(...visible.map(p => {
    const card = node('article', '', 'promptCard');
    const metaRow = node('div', '', 'cardMetaRow');
    metaRow.append(node('small', p.category, 'tag tone' + categories.indexOf(p.category)));

    const varsCount = extractVariables(p.content).length;
    if (varsCount) metaRow.append(node('span', varsCount + (varsCount === 1 ? ' var' : ' vars'), 'metaBadge'));
    if (p.checklist) metaRow.append(node('span', '✓ Checklist', 'metaBadge'));
    const pinBtn = button(p.pinned ? '★' : '☆', () => send('togglePin', {id: p.id}), 'pinBtn');
    pinBtn.setAttribute('aria-pressed', String(Boolean(p.pinned)));
    pinBtn.title = p.pinned ? 'Unpin prompt' : 'Pin prompt under Categories';
    metaRow.append(pinBtn);

    const heading = node('h3', '');
    const link = button(p.title, () => openReader(p), 'readLink');
    link.dir = 'auto';
    heading.append(link);
    card.onclick = e => { if (!e.target.closest('button,.cardFooter')) openReader(p); };

    const preview = node('p', p.description || p.content);
    preview.dir = 'auto';

    const footer = node('footer', '', 'cardFooter');
    const primary = node('div', '', 'cardPrimary');
    const secondary = node('div', '', 'cardSecondary');

    const copyBtn = button('Copy', () => { send('copy', {text: p.content}); flashCopied(copyBtn); });
    primary.append(
      button('Customize', () => openCustom(p), 'use'),
      button('Antigravity ↗', () => send('openAntigravity', {text: p.content})),
      copyBtn
    );

    if (p.checklist) secondary.append(button('Verify ↗', () => send('verify', {id: p.id})));
    secondary.append(
      button('Edit', () => edit(p)),
      button('Delete', () => send('delete', {id: p.id, revision: p.revision}), 'dangerBtn')
    );

    footer.append(primary, secondary);
    card.append(metaRow, heading, preview, footer);
    return card;
  }));

  if (!visible.length) {
    const box = node('div', '', 'empty');
    const icon = query ? '⌕' : (selectedCategory === ALL ? '◈' : (symbols[categories.indexOf(selectedCategory)] || '◇'));
    const headingText = query ? 'No matching prompts' : 'Your first prompt goes here';
    const subText = query
      ? 'Try another title, phrase or category.'
      : (selectedCategory === ALL ? 'Save a reusable prompt template to get started.' : 'Save a reusable template in ' + selectedCategory + '.');
    box.append(node('div', icon, 'emptyIcon'), node('h3', headingText), node('p', subText));
    if (!query) box.append(button('Create a prompt', () => edit(null), 'use'));
    el('cards').append(box);
  }
}

function edit(p) {
  editing = p;
  el('editor').reset();
  el('formTitle').textContent = p ? 'Edit saved template' : 'New prompt';
  el('category').replaceChildren(...categories.map(c => new Option(c, c)));
  for (const key of ['title', 'content', 'description']) el(key).value = p?.[key] || '';
  el('category').value = p?.category || (selectedCategory === ALL ? categories[0] : selectedCategory);
  el('itemsLabel').hidden = Boolean(p?.checklist);
  el('removeLabel').hidden = !p?.checklist;
  screen('editor');
  el('title').focus();
}

function resetAI() {
  if (adapting) send('stopAdapt');
  request++;
  adapting = false;
  el('stopAdapt').hidden = true;
  el('adapt').disabled = !el('project').value;
  el('proposal').hidden = true;
  el('suggestion').value = '';
  el('aiStatus').textContent = '';
}

function insertIntoDraft(snippet) {
  const area = el('draft');
  const appendAtEnd = !draftManuallyEdited && area.value.length > 0 && area.selectionStart === 0 && area.selectionEnd === 0;
  if (appendAtEnd) area.setSelectionRange(area.value.length, area.value.length);
  const res = insertTextAtCursor(area, snippet);
  if (!draftManuallyEdited && res.start === res.end && res.after === '') {
    customTemplate += (customTemplate && !customTemplate.endsWith('\n\n') ? '\n\n' : '') + snippet;
  } else {
    draftManuallyEdited = true;
  }
}

/* ==================== DOCKED SPLIT COMPANION PANE (NOTES & OUTPUTS ALONGSIDE PROMPTS) ==================== */

function updateSplitInsertButtons() {
  const canInsert = activePromptScreen === 'custom' || activePromptScreen === 'editor';
  const label = activePromptScreen === 'editor' ? '＋ Insert into prompt' : '＋ Insert into draft';
  el('splitInsertNote').hidden = !canInsert;
  el('splitInsertNote').textContent = label;
  el('splitInsertOutputPath').hidden = !canInsert;
  el('splitInsertOutputContent').hidden = !canInsert;
}

function insertTextIntoActivePrompt(text, label) {
  if (!text) return;
  if (activePromptScreen === 'custom') {
    insertIntoDraft(text);
    showStatus(label + ' inserted into draft.');
  } else if (activePromptScreen === 'editor') {
    insertTextAtCursor(el('content'), text);
    showStatus(label + ' inserted into prompt.');
  }
}

function setSplitNoteBadge(state) {
  const badge = el('splitNoteSaveState');
  badge.classList.toggle('saved', state === 'saved');
  badge.textContent = state === 'saving' ? 'Saving…' : 'Saved ✓';
}

function flushSplitNoteSave() {
  if (!splitNoteDirty || !splitNoteId) return;
  clearTimeout(splitNoteSaveTimer);
  splitNoteSaveTimer = null;
  splitNoteDirty = false;
  send('saveNote', {
    id: splitNoteId,
    title: el('splitNoteTitle').value,
    content: el('splitNoteBody').value
  });
}

function scheduleSplitNoteSave() {
  if (!splitNoteId) return;
  splitNoteDirty = true;
  setSplitNoteBadge('saving');
  clearTimeout(splitNoteSaveTimer);
  splitNoteSaveTimer = setTimeout(flushSplitNoteSave, 450);
}

function selectSplitNote(id) {
  if (splitNoteId && splitNoteId !== id) flushSplitNoteSave();
  splitNoteId = id;
  const note = notes.find(n => n.id === id);
  if (!note) {
    el('splitNoteEmpty').hidden = false;
    el('splitNoteEditor').hidden = true;
    return;
  }
  el('splitNoteEmpty').hidden = true;
  el('splitNoteEditor').hidden = false;
  el('splitNoteSelect').value = note.id;
  if (!splitNoteDirty) {
    el('splitNoteTitle').value = note.title;
    el('splitNoteBody').value = note.content;
    setSplitNoteBadge('saved');
  }
}

function syncSplitNotes() {
  const sel = el('splitNoteSelect');
  if (!notes.length) {
    splitNoteId = null;
    sel.replaceChildren(new Option('No notes yet', ''));
    el('splitNoteEmpty').hidden = false;
    el('splitNoteEditor').hidden = true;
    return;
  }
  sel.replaceChildren(...notes.map(n => new Option(n.title, n.id)));
  if (!splitNoteId || !notes.some(n => n.id === splitNoteId)) {
    splitNoteId = notes[0].id;
  }
  selectSplitNote(splitNoteId);
}

function syncSplitOutputs() {
  const sel = el('splitOutputSelect');
  if (!outputs.length) {
    splitOutputPath = null;
    splitOutputFullPath = '';
    splitOutputContent = '';
    sel.replaceChildren(new Option('No saved outputs yet', ''));
    el('splitOutputEmpty').hidden = false;
    el('splitOutputViewer').hidden = true;
    return;
  }
  sel.replaceChildren(...outputs.map(o => new Option(o.relPath, o.relPath)));
  if (!splitOutputPath || !outputs.some(o => o.relPath === splitOutputPath)) {
    splitOutputPath = outputs[0].relPath;
  }
  sel.value = splitOutputPath;
  el('splitOutputEmpty').hidden = true;
  el('splitOutputViewer').hidden = false;
  if (splitOpen && splitTab === 'outputs') {
    send('readOutput', {relPath: splitOutputPath, target: 'split'});
  }
}

function applySplitState() {
  el('promptsWorkspace').classList.toggle('splitOpen', splitOpen);
  el('splitPane').hidden = !splitOpen;
  el('toggleSplit').setAttribute('aria-pressed', String(splitOpen));
  el('splitTabNotes').setAttribute('aria-pressed', String(splitTab === 'notes'));
  el('splitTabOutputs').setAttribute('aria-pressed', String(splitTab === 'outputs'));
  el('splitNotesBody').hidden = splitTab !== 'notes';
  el('splitOutputsBody').hidden = splitTab !== 'outputs';
  updateSplitInsertButtons();
  if (splitOpen) {
    if (splitTab === 'notes') syncSplitNotes();
    else {
      syncSplitOutputs();
      send('refreshOutputs');
    }
  }
}

/* ==================== MODULE A: QUICK NOTES ==================== */

function setNoteSaveBadge(state) {
  const badge = el('noteSaveState');
  badge.classList.toggle('saved', state === 'saved');
  badge.textContent = state === 'saving' ? 'Saving…' : 'Saved ✓';
}

function flushNoteSave() {
  if (!noteDirty || !activeNoteId) return;
  clearTimeout(noteSaveTimer);
  noteSaveTimer = null;
  noteDirty = false;
  send('saveNote', {
    id: activeNoteId,
    title: el('noteTitle').value,
    content: el('noteBody').value
  });
}

function scheduleNoteSave() {
  if (!activeNoteId) return;
  noteDirty = true;
  setNoteSaveBadge('saving');
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(flushNoteSave, 450);
}

function selectNote(id) {
  if (activeNoteId && activeNoteId !== id) flushNoteSave();
  activeNoteId = id;
  const note = notes.find(n => n.id === id);
  if (!note) {
    el('noteEmpty').hidden = false;
    el('noteEditorWrap').hidden = true;
    renderNotesList();
    return;
  }
  el('noteEmpty').hidden = true;
  el('noteEditorWrap').hidden = false;
  el('noteTitle').value = note.title;
  el('noteBody').value = note.content;
  noteDirty = false;
  setNoteSaveBadge('saved');
  renderNotesList();
}

function renderNotesList() {
  el('countNotes').textContent = String(notes.length);
  const q = el('noteSearch').value.trim().toLowerCase();
  const visible = notes.filter(n => !q || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q));
  el('noteList').replaceChildren(...visible.map(n => {
    const b = button('', () => selectNote(n.id), 'listItem');
    b.setAttribute('aria-current', String(n.id === activeNoteId));
    const title = node('div', n.title, 'listItemTitle');
    title.dir = 'auto';
    const snippet = (n.content || '').split(/\r?\n/).find(l => l.trim()) || 'Empty note';
    const sub = node('div', formatTime(n.updatedAt) + ' · ' + snippet.slice(0, 60), 'listItemSub');
    sub.dir = 'auto';
    b.append(title, sub);
    return b;
  }));
  if (!visible.length) {
    el('noteList').append(node('div', q ? 'No matching notes.' : 'No notes yet.', 'subtleHint'));
  }
  syncSplitNotes();
}

function createNewNote() {
  flushNoteSave();
  send('saveNote', {title: 'Untitled note', content: ''});
}

/* ==================== MODULE E: OUTPUTS / DOCS + SAFE MARKDOWN RENDERER ==================== */

function appendInlineMarkdown(parent, text) {
  const tokenRe = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g;
  let last = 0;
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('`') && tok.endsWith('`')) {
      parent.append(node('code', tok.slice(1, -1)));
    } else if (tok.startsWith('**') && tok.endsWith('**')) {
      const strong = document.createElement('strong');
      appendInlineMarkdown(strong, tok.slice(2, -2));
      parent.append(strong);
    } else if (tok.startsWith('*') && tok.endsWith('*')) {
      const em = document.createElement('em');
      appendInlineMarkdown(em, tok.slice(1, -1));
      parent.append(em);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map(cell => cell.trim());
}

function isTableSeparator(line) {
  if (!line || !line.includes('|')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every(c => /^:?-{3,}:?$/.test(c));
}

function renderMarkdown(container, text, onToggleCheckbox) {
  container.replaceChildren();
  const lines = (text || '').split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (!line.trim()) { i++; continue; }

    // Fenced code block
    const fenceMatch = line.match(/^(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const pre = document.createElement('pre');
      pre.dir = 'ltr';
      pre.append(node('code', codeLines.join('\n')));
      container.append(pre);
      continue;
    }

    // Heading
    const headMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headMatch) {
      const h = document.createElement('h' + headMatch[1].length);
      h.dir = 'auto';
      appendInlineMarkdown(h, headMatch[2].trim());
      container.append(h);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      container.append(document.createElement('hr'));
      i++;
      continue;
    }

    // Markdown table
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableRow(line);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      const wrap = node('div', '', 'mdTableWrap');
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const htr = document.createElement('tr');
      for (const h of headers) {
        const th = document.createElement('th');
        appendInlineMarkdown(th, h);
        htr.append(th);
      }
      thead.append(htr);
      table.append(thead);

      const tbody = document.createElement('tbody');
      for (const row of bodyRows) {
        const tr = document.createElement('tr');
        for (let c = 0; c < headers.length; c++) {
          const td = document.createElement('td');
          appendInlineMarkdown(td, row[c] || '');
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      wrap.append(table);
      container.append(wrap);
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const bq = document.createElement('blockquote');
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const p = document.createElement('p');
      p.dir = 'auto';
      appendInlineMarkdown(p, quoteLines.join(' '));
      bq.append(p);
      container.append(bq);
      continue;
    }

    // Task list (- [ ] / - [x])
    if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) {
      const ul = node('ul', '', 'mdTaskList');
      while (i < lines.length && /^\s*[-*+]\s+\[[ xX]\]\s+/.test(lines[i])) {
        const lineIdx = i;
        const m = lines[i].match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
        const checked = m[1].toLowerCase() === 'x';
        const li = node('li', '', 'mdTaskItem' + (checked ? ' checked' : ''));
        const lbl = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        cb.onchange = () => onToggleCheckbox(lineIdx);
        const span = document.createElement('span');
        span.dir = 'auto';
        appendInlineMarkdown(span, m[2]);
        lbl.append(cb, span);
        li.append(lbl);
        ul.append(li);
        i++;
      }
      container.append(ul);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const ul = document.createElement('ul');
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]) && !/^\s*[-*+]\s+\[[ xX]\]\s+/.test(lines[i])) {
        const li = document.createElement('li');
        li.dir = 'auto';
        appendInlineMarkdown(li, lines[i].replace(/^\s*[-*+]\s+/, ''));
        ul.append(li);
        i++;
      }
      container.append(ul);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const ol = document.createElement('ol');
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const li = document.createElement('li');
        li.dir = 'auto';
        appendInlineMarkdown(li, lines[i].replace(/^\s*\d+\.\s+/, ''));
        ol.append(li);
        i++;
      }
      container.append(ol);
      continue;
    }

    // Paragraph
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|`{3,}|~{3,}|\s*[-*+]\s|\s*\d+\.\s|\s*>\s?|\s*(?:---+|\*\*\*+|___+)\s*$)/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    const p = document.createElement('p');
    p.dir = 'auto';
    appendInlineMarkdown(p, paraLines.join(' '));
    container.append(p);
  }
}

function setOutputViewMode(mode) {
  outputViewMode = mode;
  el('outputModeView').setAttribute('aria-pressed', String(mode === 'rendered'));
  el('outputModeRaw').setAttribute('aria-pressed', String(mode === 'raw'));
  el('outputRendered').hidden = mode !== 'rendered';
  el('outputRawWrap').hidden = mode !== 'raw';
  if (mode === 'raw') {
    el('outputRawEditor').value = activeOutputContent;
    el('outputRawEditor').focus();
  }
}

function showOutputPane(which) {
  el('outputEmpty').hidden = which !== 'empty';
  el('outputCreateForm').hidden = which !== 'create';
  el('outputDetailWrap').hidden = which !== 'detail';
}

function renderOutputsList() {
  el('countOutputs').textContent = String(outputs.length);
  el('outputsFolderLabel').textContent = outputsPath;
  const q = el('outputSearch').value.trim().toLowerCase();
  const visible = outputs.filter(o => !q || o.relPath.toLowerCase().includes(q));
  el('outputList').replaceChildren(...visible.map(o => {
    const b = button('', () => {
      activeOutputPath = o.relPath;
      outputViewMode = 'rendered';
      send('readOutput', {relPath: o.relPath});
      renderOutputsList();
    }, 'listItem');
    b.setAttribute('aria-current', String(o.relPath === activeOutputPath));
    b.append(
      node('div', o.name, 'listItemTitle'),
      node('div', (o.folder ? o.folder + ' · ' : '') + formatTime(o.updatedAt), 'listItemSub')
    );
    return b;
  }));
  if (!visible.length) {
    el('outputList').append(node('div', q ? 'No matching outputs.' : 'No saved outputs yet.', 'subtleHint'));
  }
}

function suggestFilenameFromMarkdown(content) {
  const heading = (content || '').match(/^#\s+(.+)$/m);
  if (heading) return slugify(heading[1]) + '.md';
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `output-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.md`;
}

function openCreateOutputForm(initialContent) {
  el('outputCreateName').value = suggestFilenameFromMarkdown(initialContent);
  el('outputCreateContent').value = initialContent || '';
  showOutputPane('create');
  el('outputCreateName').focus();
  el('outputCreateName').select();
}

/* ==================== EVENT WIRING ==================== */

// Topbar
el('tabPrompts').onclick = () => switchModule('prompts');
el('tabNotes').onclick = () => switchModule('notes');
el('tabOutputs').onclick = () => switchModule('outputs');
el('scaleSm').onclick = () => { applyScale('sm'); send('setFontScale', {scale: 'sm'}); };
el('scaleMd').onclick = () => { applyScale('md'); send('setFontScale', {scale: 'md'}); };
el('scaleLg').onclick = () => { applyScale('lg'); send('setFontScale', {scale: 'lg'}); };
el('expand').onclick = () => send('expand');
el('popOut').onclick = () => send('popOut');
el('toggleSplit').onclick = () => {
  if (splitOpen) flushSplitNoteSave();
  splitOpen = !splitOpen;
  persistUiState();
  applySplitState();
};
el('closeSplit').onclick = () => {
  flushSplitNoteSave();
  splitOpen = false;
  persistUiState();
  applySplitState();
};
el('splitTabNotes').onclick = () => {
  splitTab = 'notes';
  persistUiState();
  applySplitState();
};
el('splitTabOutputs').onclick = () => {
  flushSplitNoteSave();
  splitTab = 'outputs';
  persistUiState();
  applySplitState();
};
el('splitNoteSelect').onchange = () => selectSplitNote(el('splitNoteSelect').value);
el('splitNewNote').onclick = () => {
  flushSplitNoteSave();
  send('saveNote', {title: 'Untitled note', content: ''});
};
el('splitNoteTitle').oninput = scheduleSplitNoteSave;
el('splitNoteBody').oninput = scheduleSplitNoteSave;
el('splitNoteTitle').onblur = flushSplitNoteSave;
el('splitNoteBody').onblur = flushSplitNoteSave;
el('splitCopyNote').onclick = () => { send('copy', {text: el('splitNoteBody').value}); flashCopied(el('splitCopyNote')); };
el('splitInsertNote').onclick = () => insertTextIntoActivePrompt(el('splitNoteBody').value, 'Note');

el('splitOutputSelect').onchange = () => {
  splitOutputPath = el('splitOutputSelect').value;
  if (splitOutputPath) send('readOutput', {relPath: splitOutputPath, target: 'split'});
};
el('splitRefreshOutputs').onclick = () => { send('refreshOutputs'); showStatus('Outputs refreshed.'); };
el('splitCopyOutputPath').onclick = () => { send('copy', {text: splitOutputFullPath}); flashCopied(el('splitCopyOutputPath')); };
el('splitOpenOutputIde').onclick = () => { if (splitOutputPath) send('openOutputInEditor', {relPath: splitOutputPath}); };
el('splitInsertOutputPath').onclick = () => insertTextIntoActivePrompt(splitOutputFullPath, 'Output path');
el('splitInsertOutputContent').onclick = () => insertTextIntoActivePrompt(splitOutputContent, 'Output text');

// Prompts navigation & actions
el('back').onclick = () => screen('browse');
el('editorBack').onclick = () => { if (!pending) screen('browse'); };
el('customBack').onclick = () => { resetAI(); screen('browse'); };
el('search').oninput = renderPrompts;
el('new').onclick = () => edit(null);
el('cancel').onclick = () => { if (!pending) screen('browse'); };
el('discard').onclick = () => { resetAI(); el('draft').value = ''; screen('browse'); };
el('draft').oninput = () => { draftManuallyEdited = true; };
el('copyDraft').onclick = () => { send('copy', {text: el('draft').value}); flashCopied(el('copyDraft')); };
el('openAntigravity').onclick = () => send('openAntigravity', {text: el('draft').value});
el('openCodex').onclick = () => send('openCodex', {text: el('draft').value});
el('insertSelection').onclick = () => send('insertSelection', {target: 'draft'});

// Output destination buttons in Customize
el('destHub').onclick = () => applyOutputDestination('hub');
el('destProject').onclick = () => applyOutputDestination('project');
el('destChat').onclick = () => applyOutputDestination('chat');
el('appendHubDirective').onclick = () => {
  const directive = 'Output file rule: ' + buildHubModeInstruction() + '.';
  insertIntoDraft(directive);
  showStatus('Hub Output destination added to draft.');
};

el('editor').onsubmit = e => {
  e.preventDefault();
  if (pending) return;
  pending = true;
  el('save').disabled = true;
  const fields = Object.fromEntries(['title', 'content', 'description', 'items', 'category'].map(key => [key, el(key).value]));
  send('save', {...fields, id: editing?.id, revision: editing?.revision, removeChecklist: el('remove').checked});
};

// Codex AI Adaptation
el('adapt').onclick = () => {
  if (adapting || !el('project').value) return;
  adapting = true;
  el('adapt').disabled = true;
  el('stopAdapt').hidden = false;
  el('proposal').hidden = true;
  el('aiStatus').textContent = 'Reading project context and drafting a suggestion…';
  send('adapt', {request: ++request, folder: el('project').value, text: el('draft').value});
};
el('project').onchange = resetAI;
el('stopAdapt').onclick = resetAI;
el('useSuggestion').onclick = () => {
  el('draft').value = el('suggestion').value;
  draftManuallyEdited = true;
  resetAI();
  el('draft').focus();
};

// Notes wiring
el('newNote').onclick = createNewNote;
el('emptyNewNote').onclick = createNewNote;
el('noteSearch').oninput = renderNotesList;
el('noteTitle').oninput = scheduleNoteSave;
el('noteBody').oninput = scheduleNoteSave;
el('noteTitle').onblur = flushNoteSave;
el('noteBody').onblur = flushNoteSave;
el('noteInsertSelection').onclick = () => send('insertSelection', {target: 'note'});
el('noteCopy').onclick = () => { send('copy', {text: el('noteBody').value}); flashCopied(el('noteCopy')); };
el('noteOpenAntigravity').onclick = () => send('openAntigravity', {text: el('noteBody').value});
el('noteDelete').onclick = () => { if (activeNoteId) send('deleteNote', {id: activeNoteId}); };

// Outputs wiring
el('pasteOutput').onclick = () => send('pasteOutputFromClipboard');
el('emptyPasteOutput').onclick = () => send('pasteOutputFromClipboard');
el('newOutput').onclick = () => openCreateOutputForm('');
el('emptyNewOutput').onclick = () => openCreateOutputForm('');
el('refreshOutputs').onclick = () => { send('refreshOutputs'); showStatus('Outputs refreshed.'); };
el('outputSearch').oninput = renderOutputsList;
el('copyOutputsFolder').onclick = () => { send('copy', {text: outputsPath}); flashCopied(el('copyOutputsFolder')); };
el('outputCreateCancel').onclick = () => showOutputPane(activeOutputPath ? 'detail' : 'empty');
el('outputCreateCancel2').onclick = () => showOutputPane(activeOutputPath ? 'detail' : 'empty');
el('outputCreateForm').onsubmit = e => {
  e.preventDefault();
  send('saveOutput', {
    relPath: el('outputCreateName').value,
    content: el('outputCreateContent').value
  });
};
el('outputModeView').onclick = () => setOutputViewMode('rendered');
el('outputModeRaw').onclick = () => setOutputViewMode('raw');
el('outputCancelRaw').onclick = () => setOutputViewMode('rendered');
el('outputSaveRaw').onclick = () => {
  if (!activeOutputPath) return;
  send('saveOutput', {relPath: activeOutputPath, content: el('outputRawEditor').value});
};
el('outputCopyPath').onclick = () => { send('copy', {text: activeOutputFullPath}); flashCopied(el('outputCopyPath')); };
el('outputCopyMd').onclick = () => { send('copy', {text: activeOutputContent}); flashCopied(el('outputCopyMd')); };
el('outputOpenIde').onclick = () => { if (activeOutputPath) send('openOutputInEditor', {relPath: activeOutputPath}); };
el('outputDelete').onclick = () => { if (activeOutputPath) send('deleteOutput', {relPath: activeOutputPath}); };

/* ==================== EXTENSION MESSAGES ==================== */

window.addEventListener('message', ({data: m}) => {
  if (m.type === 'library') {
    const folders = m.folders || [];
    const prev = el('project').value;
    el('project').replaceChildren(...(folders.length ? folders : ['']).map(f => new Option(f || 'Open a local project to use AI', f)));
    if (folders.includes(prev)) el('project').value = prev;
    el('adapt').disabled = adapting || !folders.length;
    rows = m.rows;
    categories = m.categories;
    outputsPath = m.outputsPath || outputsPath;
    if (m.fontScale) applyScale(m.fontScale);
    if (selectedCategory !== ALL && !categories.includes(selectedCategory)) selectedCategory = ALL;
    el('alerts').textContent = (m.warnings || []).join(' ');
    renderPrompts();
    if (activeCustomPrompt) updateOutputDestUI();
  } else if (m.type === 'fontScale') {
    applyScale(m.scale);
  } else if (m.type === 'pinToggled') {
    if (activeReaderId === m.id) {
      el('readPin').textContent = m.pinned ? '★ Pinned' : '☆ Pin';
      el('readPin').setAttribute('aria-pressed', String(Boolean(m.pinned)));
    }
    showStatus(m.pinned ? 'Prompt pinned.' : 'Prompt unpinned.');
  } else if (m.type === 'notes') {
    notes = m.items || [];
    if (activeNoteId && !notes.some(n => n.id === activeNoteId)) activeNoteId = notes[0]?.id || null;
    if (!activeNoteId && notes.length) {
      selectNote(notes[0].id);
    } else {
      renderNotesList();
      if (!activeNoteId) {
        el('noteEmpty').hidden = false;
        el('noteEditorWrap').hidden = true;
      }
    }
  } else if (m.type === 'noteSaved') {
    const saved = m.note;
    if (activeModule === 'prompts' && splitOpen && splitTab === 'notes') {
      const isNewSplit = splitNoteId !== saved.id;
      splitNoteId = saved.id;
      setSplitNoteBadge('saved');
      if (isNewSplit) {
        el('splitNoteEmpty').hidden = true;
        el('splitNoteEditor').hidden = false;
        el('splitNoteTitle').value = saved.title;
        el('splitNoteBody').value = saved.content;
        el('splitNoteTitle').focus();
        el('splitNoteTitle').select();
      }
    } else {
      const isNew = activeNoteId !== saved.id;
      activeNoteId = saved.id;
      setNoteSaveBadge('saved');
      if (isNew) {
        el('noteEmpty').hidden = true;
        el('noteEditorWrap').hidden = false;
        el('noteTitle').value = saved.title;
        el('noteBody').value = saved.content;
        el('noteTitle').focus();
        el('noteTitle').select();
      }
    }
  } else if (m.type === 'noteDeleted') {
    if (activeNoteId === m.id) {
      activeNoteId = null;
      el('noteEmpty').hidden = false;
      el('noteEditorWrap').hidden = true;
    }
    if (splitNoteId === m.id) splitNoteId = null;
    showStatus('Note deleted.');
  } else if (m.type === 'outputs') {
    outputs = m.items || [];
    outputsPath = m.outputsPath || outputsPath;
    renderOutputsList();
    syncSplitOutputs();
    if (activeOutputPath && outputs.some(o => o.relPath === activeOutputPath)) {
      if (outputViewMode === 'rendered' && el('outputCreateForm').hidden) {
        send('readOutput', {relPath: activeOutputPath, target: 'main'});
      }
    } else if (!activeOutputPath && outputs.length && el('outputCreateForm').hidden) {
      activeOutputPath = outputs[0].relPath;
      send('readOutput', {relPath: activeOutputPath, target: 'main'});
      renderOutputsList();
    } else if (activeOutputPath && !outputs.some(o => o.relPath === activeOutputPath)) {
      activeOutputPath = null;
      if (el('outputCreateForm').hidden) showOutputPane('empty');
    }
  } else if (m.type === 'outputContent' || m.type === 'outputSaved') {
    if (m.target === 'split') {
      splitOutputPath = m.relPath;
      splitOutputFullPath = m.fullPath;
      splitOutputContent = m.content;
      el('splitOutputEmpty').hidden = true;
      el('splitOutputViewer').hidden = false;
      renderMarkdown(el('splitOutputRendered'), m.content, lineIndex => {
        send('toggleOutputCheckbox', {relPath: splitOutputPath, lineIndex, target: 'split'});
      });
    } else {
      activeOutputPath = m.relPath;
      activeOutputFullPath = m.fullPath;
      activeOutputContent = m.content;
      el('outputTitle').textContent = m.relPath;
      el('outputMeta').textContent = m.fullPath;
      renderMarkdown(el('outputRendered'), m.content, lineIndex => {
        send('toggleOutputCheckbox', {relPath: activeOutputPath, lineIndex, target: 'main'});
      });
      setOutputViewMode('rendered');
      showOutputPane('detail');
      renderOutputsList();
      if (m.type === 'outputSaved') showStatus('Output saved: ' + m.relPath);
      if (splitOpen && splitTab === 'outputs' && splitOutputPath === m.relPath) {
        splitOutputFullPath = m.fullPath;
        splitOutputContent = m.content;
        renderMarkdown(el('splitOutputRendered'), m.content, lineIndex => {
          send('toggleOutputCheckbox', {relPath: splitOutputPath, lineIndex, target: 'split'});
        });
      }
    }
  } else if (m.type === 'outputDeleted') {
    if (activeOutputPath === m.relPath) {
      activeOutputPath = null;
      showOutputPane('empty');
    }
    if (splitOutputPath === m.relPath) splitOutputPath = null;
    showStatus('Output deleted.');
  } else if (m.type === 'clipboardForOutput') {
    openCreateOutputForm(m.content || '');
  } else if (m.type === 'selectionInserted') {
    if (m.target === 'note' && activeNoteId) {
      insertTextAtCursor(el('noteBody'), m.snippet);
      scheduleNoteSave();
      showStatus('Selected code inserted into note.');
    } else {
      insertIntoDraft(m.snippet);
      showStatus('Selected code inserted.');
    }
  } else if ((m.type === 'adapted' || m.type === 'adaptFailed') && m.request === request) {
    adapting = false;
    el('stopAdapt').hidden = true;
    el('adapt').disabled = !el('project').value;
    el('aiStatus').textContent = m.message || '';
    if (m.type === 'adapted') {
      el('suggestion').value = m.text;
      el('proposal').hidden = false;
    }
  } else if (m.type === 'error') {
    pending = false;
    el('save').disabled = false;
    showStatus(m.message);
  } else if (m.type === 'done' && m.action === 'save') {
    pending = false;
    el('save').disabled = false;
    if (selectedCategory !== ALL) selectedCategory = el('category').value;
    el('search').value = '';
    screen('browse');
    renderPrompts();
    showStatus('Template saved.');
  } else if (m.type === 'done' && m.action === 'openAntigravity') {
    showStatus('Copied. Paste into Antigravity and send when ready.');
  } else if (m.type === 'done' && m.action === 'openCodex') {
    showStatus('Copied. Paste into Codex and send when ready.');
  } else if (m.type === 'done' && m.action === 'copy') {
    showStatus('Copied to clipboard.');
  }
});

switchModule(activeModule);
applySplitState();
send('ready');
