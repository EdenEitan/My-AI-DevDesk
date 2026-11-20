'use strict';

(function (app) {
  const {
    state, el, send, node, button, showStatus, flashCopied, slugify,
    extractVariables, isMultilineVar, renderTemplate, escapeRegExp, insertTextAtCursor
  } = app;

  function screen(id) {
    state.activePromptScreen = id;
    for (const name of ['browse', 'editor', 'custom', 'reader']) el(name).hidden = name !== id;
    showStatus('');
    document.body.classList.toggle('working', id !== 'browse');
    app.updateSplitInsertButtons?.();
  }

  function openReader(p) {
    state.activeReaderId = p.id;
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
    const folderSlug = (state.varValues.endpoint_slug || '').trim();
    const fileSlug = slugify(state.activeCustomPrompt?.title || 'output');
    const sep = state.outputsPath.includes('\\') ? '\\' : '/';
    const base = state.outputsPath ? state.outputsPath.replace(/[\\/]+$/, '') : '~/.edens-prompt-hub/outputs';
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
    const hasOutputModeVar = Boolean(state.varInputs.output_mode);
    el('destHub').setAttribute('aria-pressed', String(state.outputDest === 'hub'));
    el('destProject').setAttribute('aria-pressed', String(state.outputDest === 'project'));
    el('destChat').setAttribute('aria-pressed', String(state.outputDest === 'chat'));

    if (state.outputDest === 'hub') {
      el('destHint').textContent = 'Target: ' + suggestedHubOutputFile();
      el('appendHubDirective').hidden = hasOutputModeVar;
    } else if (state.outputDest === 'chat') {
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
    state.outputDest = dest;
    const input = state.varInputs.output_mode;
    if (input) {
      let val = '';
      if (dest === 'hub') val = buildHubModeInstruction();
      else if (dest === 'chat') val = 'chat only';
      input.value = val;
      state.varValues.output_mode = val;
      if (!state.draftManuallyEdited) {
        el('draft').value = renderTemplate(state.customTemplate, state.varValues);
      } else if (val) {
        el('draft').value = el('draft').value.replace(/\{\{\s*output_mode\s*\}\}/g, val);
      }
    }
    updateOutputDestUI();
  }

  function syncAdaptButtons() {
    el('adapt').disabled = state.adapting || !el('project').value;
    el('adaptFile').disabled = state.adapting || !el('targetFile').value;
  }

  function resetAI() {
    if (state.adapting) send('stopAdapt');
    state.request++;
    state.adapting = false;
    el('stopAdapt').hidden = true;
    syncAdaptButtons();
    el('proposal').hidden = true;
    el('suggestion').value = '';
    el('aiStatus').textContent = '';
  }

  function openCustom(p) {
    resetAI();
    state.activeCustomPrompt = p;
    el('customTitle').textContent = p.title;
    state.customTemplate = p.content;
    state.draftManuallyEdited = false;
    state.varValues = {};
    state.varInputs = {};
    state.outputDest = 'project';
    el('draft').value = p.content;

    const vars = extractVariables(p.content);
    const panel = el('varsPanel');
    const grid = el('varsGrid');
    if (vars.length) {
      grid.replaceChildren(...vars.map(name => {
        const wrap = node('label', name, 'varField');
        const isLong = isMultilineVar(name);
        const field = document.createElement(isLong ? 'textarea' : 'input');
        if (isLong) field.rows = 3;
        else field.type = 'text';
        field.dir = 'auto';
        field.placeholder = 'Value for {{' + name + '}}';
        state.varInputs[name] = field;
        field.oninput = () => {
          state.varValues[name] = field.value;
          if (name === 'endpoint_slug' && state.outputDest === 'hub' && state.varInputs.output_mode) {
            const updatedInst = buildHubModeInstruction();
            state.varValues.output_mode = updatedInst;
            state.varInputs.output_mode.value = updatedInst;
            updateOutputDestUI();
          }
          if (!state.draftManuallyEdited) {
            el('draft').value = renderTemplate(state.customTemplate, state.varValues);
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
    if (vars.length) grid.querySelector('input, textarea')?.focus();
    else el('draft').focus();
  }

  function renderPrompts() {
    el('countPrompts').textContent = String(state.rows.length);

    const navItems = [];
    const allBtn = button('', () => { state.selectedCategory = state.ALL; el('search').value = ''; screen('browse'); renderPrompts(); });
    allBtn.setAttribute('aria-pressed', String(state.selectedCategory === state.ALL));
    allBtn.className = 'category allTone';
    allBtn.append(node('span', '◈', 'glyph'), node('span', 'All prompts'), node('small', String(state.rows.length)));
    navItems.push(allBtn);

    state.categories.forEach((c, i) => {
      const b = button('', () => { state.selectedCategory = c; el('search').value = ''; screen('browse'); renderPrompts(); });
      b.setAttribute('aria-pressed', String(state.selectedCategory === c));
      b.className = 'category tone' + i;
      b.append(node('span', state.symbols[i], 'glyph'), node('span', c), node('small', String(state.rows.filter(p => p.category === c).length)));
      navItems.push(b);
    });
    el('categories').replaceChildren(...navItems);

    const pinned = state.rows.filter(p => p.pinned);
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
    el('name').textContent = query ? 'Search results' : (state.selectedCategory === state.ALL ? 'All prompts' : state.selectedCategory);

    const visible = state.rows.filter(p => {
      if (query) return [p.title, p.description, p.content, p.category].some(x => x.toLowerCase().includes(query));
      return state.selectedCategory === state.ALL || p.category === state.selectedCategory;
    });

    el('cards').replaceChildren(...visible.map(p => {
      const card = node('article', '', 'promptCard');
      const metaRow = node('div', '', 'cardMetaRow');
      metaRow.append(node('small', p.category, 'tag tone' + state.categories.indexOf(p.category)));

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
      const icon = query ? '⌕' : (state.selectedCategory === state.ALL ? '◈' : (state.symbols[state.categories.indexOf(state.selectedCategory)] || '◇'));
      const headingText = query ? 'No matching prompts' : 'Your first prompt goes here';
      const subText = query
        ? 'Try another title, phrase or category.'
        : (state.selectedCategory === state.ALL ? 'Save a reusable prompt template to get started.' : 'Save a reusable template in ' + state.selectedCategory + '.');
      box.append(node('div', icon, 'emptyIcon'), node('h3', headingText), node('p', subText));
      if (!query) box.append(button('Create a prompt', () => edit(null), 'use'));
      el('cards').append(box);
    }
  }

  function edit(p) {
    state.editing = p;
    el('editor').reset();
    el('formTitle').textContent = p ? 'Edit saved template' : 'New prompt';
    el('category').replaceChildren(...state.categories.map(c => new Option(c, c)));
    for (const key of ['title', 'content', 'description']) el(key).value = p?.[key] || '';
    el('category').value = p?.category || (state.selectedCategory === state.ALL ? state.categories[0] : state.selectedCategory);
    el('itemsLabel').hidden = Boolean(p?.checklist);
    el('removeLabel').hidden = !p?.checklist;
    screen('editor');
    el('title').focus();
  }

  function insertIntoDraft(snippet) {
    const area = el('draft');
    const appendAtEnd = !state.draftManuallyEdited && area.value.length > 0 && area.selectionStart === 0 && area.selectionEnd === 0;
    if (appendAtEnd) area.setSelectionRange(area.value.length, area.value.length);
    const res = insertTextAtCursor(area, snippet);
    if (!state.draftManuallyEdited && res.start === res.end && res.after === '') {
      state.customTemplate += (state.customTemplate && !state.customTemplate.endsWith('\n\n') ? '\n\n' : '') + snippet;
    } else {
      state.draftManuallyEdited = true;
    }
  }

  function startAdapt({file = '', statusMessage}) {
    if (state.adapting) return;
    if (!file && !el('project').value) return;
    if (file && !el('targetFile').value) return;
    state.adapting = true;
    syncAdaptButtons();
    el('stopAdapt').hidden = false;
    el('proposal').hidden = true;
    el('aiStatus').textContent = statusMessage;
    send('adapt', {request: ++state.request, folder: el('project').value, file, text: el('draft').value});
  }

  function bindPromptsEvents() {
    el('back').onclick = () => screen('browse');
    el('editorBack').onclick = () => { if (!state.pending) screen('browse'); };
    el('customBack').onclick = () => { resetAI(); screen('browse'); };
    el('search').oninput = renderPrompts;
    el('new').onclick = () => edit(null);
    el('cancel').onclick = () => { if (!state.pending) screen('browse'); };
    el('discard').onclick = () => { resetAI(); el('draft').value = ''; screen('browse'); };
    el('draft').oninput = () => { state.draftManuallyEdited = true; };
    el('copyDraft').onclick = () => { send('copy', {text: el('draft').value}); flashCopied(el('copyDraft')); };
    el('openAntigravity').onclick = () => send('openAntigravity', {text: el('draft').value});
    el('openCodex').onclick = () => send('openCodex', {text: el('draft').value});
    el('insertSelection').onclick = () => send('insertSelection', {target: 'draft'});

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
      if (state.pending) return;
      state.pending = true;
      el('save').disabled = true;
      const fields = Object.fromEntries(['title', 'content', 'description', 'items', 'category'].map(key => [key, el(key).value]));
      send('save', {...fields, id: state.editing?.id, revision: state.editing?.revision, removeChecklist: el('remove').checked});
    };

    el('adapt').onclick = () => startAdapt({statusMessage: 'Reading project context and drafting a suggestion…'});
    el('adaptFile').onclick = () => startAdapt({file: el('targetFile').value, statusMessage: 'Reading file context and drafting a suggestion…'});
    el('pickFile').onclick = () => send('pickFile', {currentFile: el('targetFile').value, folder: el('project').value});
    el('project').onchange = resetAI;
    el('stopAdapt').onclick = resetAI;
    el('useSuggestion').onclick = () => {
      el('draft').value = el('suggestion').value;
      state.draftManuallyEdited = true;
      resetAI();
      el('draft').focus();
    };
  }

  Object.assign(app, {
    screen,
    openReader,
    openCustom,
    renderPrompts,
    edit,
    resetAI,
    syncAdaptButtons,
    insertIntoDraft,
    updateOutputDestUI,
    bindPromptsEvents
  });
})(window.DevDesk);
