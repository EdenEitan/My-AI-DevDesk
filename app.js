'use strict';
const api = acquireVsCodeApi();
const el = id => document.getElementById(id);
const send = (type, data = {}) => api.postMessage({type, ...data});

const ALL = '__ALL__';
const symbols = ['⌘', '✓', '✦', '◇', '☀'];

let request = 0;
let adapting = false;
let rows = [];
let categories = [];
let selected = ALL;
let editing = null;
let pending = false;

let customTemplate = '';
let draftManuallyEdited = false;
let varValues = {};

function node(tag, text, cls) {
  const n = document.createElement(tag);
  n.textContent = text;
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

function screen(id) {
  for (const name of ['browse', 'editor', 'custom', 'reader']) el(name).hidden = name !== id;
  el('status').textContent = '';
  document.body.classList.toggle('working', id !== 'browse');
}

function openReader(p) {
  el('readTitle').textContent = p.title;
  el('readDescription').textContent = p.description;
  el('readContent').textContent = p.content;
  el('readCopy').onclick = () => { send('copy', {text: p.content}); flashCopied(el('readCopy')); };
  el('readAntigravity').onclick = () => send('openAntigravity', {text: p.content});
  el('readCustomize').onclick = () => openCustom(p);
  el('readEdit').onclick = () => edit(p);
  el('readVerify').hidden = !p.checklist;
  el('readVerify').onclick = () => send('verify', {id: p.id});
  screen('reader');
  el('readTitle').focus();
}

function openCustom(p) {
  resetAI();
  el('customTitle').textContent = p.title;
  customTemplate = p.content;
  draftManuallyEdited = false;
  varValues = {};
  el('draft').value = p.content;

  const vars = extractVariables(p.content);
  const panel = el('varsPanel');
  const grid = el('varsGrid');
  if (vars.length) {
    grid.replaceChildren(...vars.map(name => {
      const wrap = node('label', name, 'varField');
      const input = document.createElement('input');
      input.type = 'text';
      input.dir = 'auto';
      input.placeholder = 'Value for {{' + name + '}}';
      input.oninput = () => {
        varValues[name] = input.value;
        if (!draftManuallyEdited) {
          el('draft').value = renderTemplate(customTemplate, varValues);
        } else if (input.value) {
          const pattern = new RegExp('\\{\\{\\s*' + escapeRegExp(name) + '\\s*\\}\\}', 'g');
          el('draft').value = el('draft').value.replace(pattern, input.value);
        }
      };
      wrap.append(input);
      return wrap;
    }));
    panel.hidden = false;
  } else {
    grid.replaceChildren();
    panel.hidden = true;
  }

  screen('custom');
  if (vars.length) {
    grid.querySelector('input')?.focus();
  } else {
    el('draft').focus();
  }
}

function render() {
  const navItems = [];
  const allBtn = button('', () => { selected = ALL; el('search').value = ''; screen('browse'); render(); });
  allBtn.setAttribute('aria-pressed', String(selected === ALL));
  allBtn.className = 'category allTone';
  allBtn.append(node('span', '◈', 'glyph'), node('span', 'All prompts'), node('small', String(rows.length)));
  navItems.push(allBtn);

  categories.forEach((c, i) => {
    const b = button('', () => { selected = c; el('search').value = ''; screen('browse'); render(); });
    b.setAttribute('aria-pressed', String(selected === c));
    b.className = 'category tone' + i;
    b.append(node('span', symbols[i], 'glyph'), node('span', c), node('small', String(rows.filter(p => p.category === c).length)));
    navItems.push(b);
  });
  el('categories').replaceChildren(...navItems);

  const query = el('search').value.trim().toLowerCase();
  el('name').textContent = query ? 'Search results' : (selected === ALL ? 'All prompts' : selected);

  const visible = rows.filter(p => {
    if (query) return [p.title, p.description, p.content, p.category].some(x => x.toLowerCase().includes(query));
    return selected === ALL || p.category === selected;
  });

  el('cards').replaceChildren(...visible.map(p => {
    const card = node('article', '');
    const actions = node('footer', '');
    const heading = node('h3', '');
    const link = button(p.title, () => openReader(p), 'readLink');
    link.dir = 'auto';
    heading.append(link);
    card.onclick = e => { if (!e.target.closest('button,footer')) openReader(p); };

    const preview = node('p', p.description || p.content);
    preview.dir = 'auto';
    card.append(node('small', p.category, 'tag tone' + categories.indexOf(p.category)), heading, preview);

    const copyBtn = button('Copy', () => { send('copy', {text: p.content}); flashCopied(copyBtn); });
    actions.append(
      button('Customize', () => openCustom(p), 'use'),
      copyBtn,
      button('Antigravity ↗', () => send('openAntigravity', {text: p.content})),
      button('Edit', () => edit(p)),
      button('Delete', () => send('delete', {id: p.id, revision: p.revision}))
    );
    if (p.checklist) actions.append(button('Verify AI Output ↗', () => send('verify', {id: p.id})));
    card.append(actions);
    return card;
  }));

  if (!visible.length) {
    const box = node('div', '', 'empty');
    const icon = query ? '⌕' : (selected === ALL ? '◈' : (symbols[categories.indexOf(selected)] || '◇'));
    const headingText = query ? 'No matching prompts' : 'Your first prompt goes here';
    const subText = query
      ? 'Try another title, phrase or category.'
      : (selected === ALL ? 'Save a reusable prompt template to get started.' : 'Save a reusable template in ' + selected + '.');
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
  el('category').value = p?.category || (selected === ALL ? categories[0] : selected);
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
  const start = appendAtEnd ? area.value.length : (area.selectionStart ?? area.value.length);
  const end = appendAtEnd ? area.value.length : (area.selectionEnd ?? area.value.length);
  const before = area.value.slice(0, start);
  const after = area.value.slice(end);
  const prefix = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
  const suffix = after && !after.startsWith('\n') ? '\n\n' : '';
  const inserted = prefix + snippet + suffix;
  area.value = before + inserted + after;
  if (!draftManuallyEdited && start === end && after === '') {
    customTemplate += (customTemplate && !customTemplate.endsWith('\n\n') ? '\n\n' : '') + snippet;
  } else {
    draftManuallyEdited = true;
  }
  const pos = start + inserted.length;
  area.focus();
  area.setSelectionRange(pos, pos);
}

el('back').onclick = () => screen('browse');
el('search').oninput = render;
el('expand').onclick = () => send('expand');
el('new').onclick = () => edit(null);
el('cancel').onclick = () => { if (!pending) screen('browse'); };
el('discard').onclick = () => { resetAI(); el('draft').value = ''; screen('browse'); };
el('draft').oninput = () => { draftManuallyEdited = true; };
el('copyDraft').onclick = () => { send('copy', {text: el('draft').value}); flashCopied(el('copyDraft')); };
el('openAntigravity').onclick = () => send('openAntigravity', {text: el('draft').value});
el('openCodex').onclick = () => send('openCodex', {text: el('draft').value});
el('insertSelection').onclick = () => send('insertSelection');

el('editor').onsubmit = e => {
  e.preventDefault();
  if (pending) return;
  pending = true;
  el('save').disabled = true;
  const fields = Object.fromEntries(['title', 'content', 'description', 'items', 'category'].map(key => [key, el(key).value]));
  send('save', {...fields, id: editing?.id, revision: editing?.revision, removeChecklist: el('remove').checked});
};

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

window.addEventListener('message', ({data: m}) => {
  if (m.type === 'library') {
    const folders = m.folders || [];
    const prev = el('project').value;
    el('project').replaceChildren(...(folders.length ? folders : ['']).map(f => new Option(f || 'Open a local project to use AI', f)));
    if (folders.includes(prev)) el('project').value = prev;
    el('adapt').disabled = adapting || !folders.length;
    rows = m.rows;
    categories = m.categories;
    if (selected !== ALL && !categories.includes(selected)) selected = ALL;
    el('alerts').textContent = m.warnings.join(' ');
    render();
  } else if (m.type === 'selectionInserted') {
    insertIntoDraft(m.snippet);
    el('status').textContent = 'Selected code inserted.';
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
    el('status').textContent = m.message;
  } else if (m.type === 'done' && m.action === 'save') {
    pending = false;
    el('save').disabled = false;
    if (selected !== ALL) selected = el('category').value;
    el('search').value = '';
    screen('browse');
    render();
    el('status').textContent = 'Template saved.';
  } else if (m.type === 'done' && m.action === 'openAntigravity') {
    el('status').textContent = 'Prompt copied. Paste it into Antigravity and send when ready.';
  } else if (m.type === 'done' && m.action === 'openCodex') {
    el('status').textContent = 'Prompt copied. Paste it into Codex and send when ready.';
  } else if (m.type === 'done' && m.action === 'copy') {
    el('status').textContent = 'Copied to clipboard.';
  }
});

send('ready');
