'use strict';

(function (app) {
  const {state, el, send, persistUiState, showStatus, applyScale, insertTextAtCursor} = app;

  function switchModule(mod) {
    if (state.activeModule === 'notes') app.flushNoteSave();
    if (state.activeModule === 'prompts') app.flushSplitNoteSave();
    state.activeModule = mod;
    persistUiState();
    el('promptsWorkspace').hidden = mod !== 'prompts';
    el('notesModule').hidden = mod !== 'notes';
    el('outputsModule').hidden = mod !== 'outputs';
    el('toggleSplit').hidden = mod !== 'prompts';
    el('tabPrompts').setAttribute('aria-selected', String(mod === 'prompts'));
    el('tabNotes').setAttribute('aria-selected', String(mod === 'notes'));
    el('tabOutputs').setAttribute('aria-selected', String(mod === 'outputs'));
    if (mod === 'outputs' || (mod === 'prompts' && state.splitOpen && state.splitTab === 'outputs')) {
      send('refreshOutputs');
    }
  }

  // Topbar bindings
  el('tabPrompts').onclick = () => switchModule('prompts');
  el('tabNotes').onclick = () => switchModule('notes');
  el('tabOutputs').onclick = () => switchModule('outputs');
  el('scaleSm').onclick = () => { applyScale('sm'); send('setFontScale', {scale: 'sm'}); };
  el('scaleMd').onclick = () => { applyScale('md'); send('setFontScale', {scale: 'md'}); };
  el('scaleLg').onclick = () => { applyScale('lg'); send('setFontScale', {scale: 'lg'}); };
  el('expand').onclick = () => send('expand');
  el('popOut').onclick = () => send('popOut');

  app.bindPromptsEvents();
  app.bindNotesEvents();
  app.bindOutputsEvents();
  app.bindSplitEvents();

  const messageHandlers = {
    library: m => {
      const folders = m.folders || [];
      const prev = el('project').value;
      el('project').replaceChildren(...(folders.length ? folders : ['']).map(f => new Option(f || 'Open a local project to use AI', f)));
      if (folders.includes(prev)) el('project').value = prev;
      if (!state.fileManuallyPicked && m.activeFile) el('targetFile').value = m.activeFile;
      app.syncAdaptButtons();
      state.rows = m.rows;
      state.categories = m.categories;
      state.outputsPath = m.outputsPath || state.outputsPath;
      if (m.fontScale) applyScale(m.fontScale);
      if (state.selectedCategory !== state.ALL && !state.categories.includes(state.selectedCategory)) {
        state.selectedCategory = state.ALL;
      }
      el('alerts').textContent = (m.warnings || []).join(' ');
      app.renderPrompts();
      if (state.activeCustomPrompt) app.updateOutputDestUI();
    },
    activeFile: m => {
      if (!state.fileManuallyPicked && m.file) {
        el('targetFile').value = m.file;
        app.syncAdaptButtons();
      }
    },
    filePicked: m => {
      state.fileManuallyPicked = true;
      el('targetFile').value = m.file || '';
      app.resetAI();
    },
    fontScale: m => applyScale(m.scale),
    pinToggled: m => {
      if (state.activeReaderId === m.id) {
        el('readPin').textContent = m.pinned ? '★ Pinned' : '☆ Pin';
        el('readPin').setAttribute('aria-pressed', String(Boolean(m.pinned)));
      }
      showStatus(m.pinned ? 'Prompt pinned.' : 'Prompt unpinned.');
    },
    notes: m => {
      state.notes = m.items || [];
      if (state.activeNoteId && !state.notes.some(n => n.id === state.activeNoteId)) {
        state.activeNoteId = state.notes[0]?.id || null;
      }
      if (!state.activeNoteId && state.notes.length) {
        app.selectNote(state.notes[0].id);
      } else {
        app.renderNotesList();
        if (!state.activeNoteId) {
          el('noteEmpty').hidden = false;
          el('noteEditorWrap').hidden = true;
        }
      }
    },
    noteSaved: m => {
      const saved = m.note;
      if (state.activeModule === 'prompts' && state.splitOpen && state.splitTab === 'notes') {
        const isNewSplit = state.splitNoteId !== saved.id;
        state.splitNoteId = saved.id;
        app.setSplitNoteBadge('saved');
        if (isNewSplit) {
          el('splitNoteEmpty').hidden = true;
          el('splitNoteEditor').hidden = false;
          el('splitNoteTitle').value = saved.title;
          el('splitNoteBody').value = saved.content;
          el('splitNoteTitle').focus();
          el('splitNoteTitle').select();
        }
      } else {
        const isNew = state.activeNoteId !== saved.id;
        state.activeNoteId = saved.id;
        app.setNoteSaveBadge('saved');
        if (isNew) {
          el('noteEmpty').hidden = true;
          el('noteEditorWrap').hidden = false;
          el('noteTitle').value = saved.title;
          el('noteBody').value = saved.content;
          el('noteTitle').focus();
          el('noteTitle').select();
        }
      }
    },
    noteDeleted: m => {
      if (state.activeNoteId === m.id) {
        state.activeNoteId = null;
        el('noteEmpty').hidden = false;
        el('noteEditorWrap').hidden = true;
      }
      if (state.splitNoteId === m.id) state.splitNoteId = null;
      showStatus('Note deleted.');
    },
    outputs: m => {
      state.outputs = m.items || [];
      state.outputsPath = m.outputsPath || state.outputsPath;
      app.renderOutputsList();
      app.syncSplitOutputs();
      if (state.activeOutputPath && state.outputs.some(o => o.relPath === state.activeOutputPath)) {
        if (state.outputViewMode === 'rendered' && el('outputCreateForm').hidden) {
          send('readOutput', {relPath: state.activeOutputPath, target: 'main'});
        }
      } else if (!state.activeOutputPath && state.outputs.length && el('outputCreateForm').hidden) {
        state.activeOutputPath = state.outputs[0].relPath;
        send('readOutput', {relPath: state.activeOutputPath, target: 'main'});
        app.renderOutputsList();
      } else if (state.activeOutputPath && !state.outputs.some(o => o.relPath === state.activeOutputPath)) {
        state.activeOutputPath = null;
        if (el('outputCreateForm').hidden) app.showOutputPane('empty');
      }
    },
    outputContent: handleOutputLoaded,
    outputSaved: handleOutputLoaded,
    outputDeleted: m => {
      if (state.activeOutputPath === m.relPath) {
        state.activeOutputPath = null;
        app.showOutputPane('empty');
      }
      if (state.splitOutputPath === m.relPath) state.splitOutputPath = null;
      showStatus('Output deleted.');
    },
    clipboardForOutput: m => app.openCreateOutputForm(m.content || ''),
    selectionInserted: m => {
      if (m.target === 'note' && state.activeNoteId) {
        insertTextAtCursor(el('noteBody'), m.snippet);
        app.scheduleNoteSave();
        showStatus('Selected code inserted into note.');
      } else {
        app.insertIntoDraft(m.snippet);
        showStatus('Selected code inserted.');
      }
    },
    adapted: handleAdaptResult,
    adaptFailed: handleAdaptResult,
    error: m => {
      state.pending = false;
      el('save').disabled = false;
      showStatus(m.message);
    },
    done: m => {
      if (m.action === 'save') {
        state.pending = false;
        el('save').disabled = false;
        if (state.selectedCategory !== state.ALL) state.selectedCategory = el('category').value;
        el('search').value = '';
        app.screen('browse');
        app.renderPrompts();
        showStatus('Template saved.');
      } else if (m.action === 'openAntigravity') {
        showStatus('Copied. Paste into Antigravity and send when ready.');
      } else if (m.action === 'openCodex') {
        showStatus('Copied. Paste into Codex and send when ready.');
      } else if (m.action === 'copy') {
        showStatus('Copied to clipboard.');
      }
    }
  };

  function handleOutputLoaded(m) {
    if (m.target === 'split') {
      state.splitOutputPath = m.relPath;
      state.splitOutputFullPath = m.fullPath;
      state.splitOutputContent = m.content;
      el('splitOutputEmpty').hidden = true;
      el('splitOutputViewer').hidden = false;
      app.renderMarkdown(el('splitOutputRendered'), m.content, lineIndex => {
        send('toggleOutputCheckbox', {relPath: state.splitOutputPath, lineIndex, target: 'split'});
      });
      return;
    }
    state.activeOutputPath = m.relPath;
    state.activeOutputFullPath = m.fullPath;
    state.activeOutputContent = m.content;
    el('outputTitle').textContent = m.relPath;
    el('outputMeta').textContent = m.fullPath;
    app.renderMarkdown(el('outputRendered'), m.content, lineIndex => {
      send('toggleOutputCheckbox', {relPath: state.activeOutputPath, lineIndex, target: 'main'});
    });
    app.setOutputViewMode('rendered');
    app.showOutputPane('detail');
    app.renderOutputsList();
    if (m.type === 'outputSaved') showStatus('Output saved: ' + m.relPath);
    if (state.splitOpen && state.splitTab === 'outputs' && state.splitOutputPath === m.relPath) {
      state.splitOutputFullPath = m.fullPath;
      state.splitOutputContent = m.content;
      app.renderMarkdown(el('splitOutputRendered'), m.content, lineIndex => {
        send('toggleOutputCheckbox', {relPath: state.splitOutputPath, lineIndex, target: 'split'});
      });
    }
  }

  function handleAdaptResult(m) {
    if (m.request !== state.request) return;
    state.adapting = false;
    el('stopAdapt').hidden = true;
    app.syncAdaptButtons();
    el('aiStatus').textContent = m.message || '';
    if (m.type === 'adapted') {
      el('suggestion').value = m.text;
      el('proposal').hidden = false;
    }
  }

  window.addEventListener('message', ({data: m}) => {
    const fn = m && Object.prototype.hasOwnProperty.call(messageHandlers, m.type) ? messageHandlers[m.type] : null;
    if (fn) fn(m);
  });

  switchModule(state.activeModule);
  app.applySplitState();
  send('ready');
})(window.DevDesk);
