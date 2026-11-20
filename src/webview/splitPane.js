'use strict';

(function (app) {
  const {state, el, send, persistUiState, showStatus, flashCopied, insertTextAtCursor} = app;

  function updateSplitInsertButtons() {
    const canInsert = state.activePromptScreen === 'custom' || state.activePromptScreen === 'editor';
    const label = state.activePromptScreen === 'editor' ? '＋ Insert into prompt' : '＋ Insert into draft';
    el('splitInsertNote').hidden = !canInsert;
    el('splitInsertNote').textContent = label;
    el('splitInsertOutputPath').hidden = !canInsert;
    el('splitInsertOutputContent').hidden = !canInsert;
  }

  function insertTextIntoActivePrompt(text, label) {
    if (!text) return;
    if (state.activePromptScreen === 'custom') {
      app.insertIntoDraft(text);
      showStatus(label + ' inserted into draft.');
    } else if (state.activePromptScreen === 'editor') {
      insertTextAtCursor(el('content'), text);
      showStatus(label + ' inserted into prompt.');
    }
  }

  function setSplitNoteBadge(status) {
    const badge = el('splitNoteSaveState');
    badge.classList.toggle('saved', status === 'saved');
    badge.textContent = status === 'saving' ? 'Saving…' : 'Saved ✓';
  }

  function flushSplitNoteSave() {
    if (!state.splitNoteDirty || !state.splitNoteId) return;
    clearTimeout(state.splitNoteSaveTimer);
    state.splitNoteSaveTimer = null;
    state.splitNoteDirty = false;
    send('saveNote', {
      id: state.splitNoteId,
      title: el('splitNoteTitle').value,
      content: el('splitNoteBody').value
    });
  }

  function scheduleSplitNoteSave() {
    if (!state.splitNoteId) return;
    state.splitNoteDirty = true;
    setSplitNoteBadge('saving');
    clearTimeout(state.splitNoteSaveTimer);
    state.splitNoteSaveTimer = setTimeout(flushSplitNoteSave, 450);
  }

  function selectSplitNote(id) {
    if (state.splitNoteId && state.splitNoteId !== id) flushSplitNoteSave();
    state.splitNoteId = id;
    const note = state.notes.find(n => n.id === id);
    if (!note) {
      el('splitNoteEmpty').hidden = false;
      el('splitNoteEditor').hidden = true;
      return;
    }
    el('splitNoteEmpty').hidden = true;
    el('splitNoteEditor').hidden = false;
    el('splitNoteSelect').value = note.id;
    if (!state.splitNoteDirty) {
      el('splitNoteTitle').value = note.title;
      el('splitNoteBody').value = note.content;
      setSplitNoteBadge('saved');
    }
  }

  function syncSplitNotes() {
    const sel = el('splitNoteSelect');
    if (!state.notes.length) {
      state.splitNoteId = null;
      sel.replaceChildren(new Option('No notes yet', ''));
      el('splitNoteEmpty').hidden = false;
      el('splitNoteEditor').hidden = true;
      return;
    }
    sel.replaceChildren(...state.notes.map(n => new Option(n.title, n.id)));
    if (!state.splitNoteId || !state.notes.some(n => n.id === state.splitNoteId)) {
      state.splitNoteId = state.notes[0].id;
    }
    selectSplitNote(state.splitNoteId);
  }

  function syncSplitOutputs() {
    const sel = el('splitOutputSelect');
    if (!state.outputs.length) {
      state.splitOutputPath = null;
      state.splitOutputFullPath = '';
      state.splitOutputContent = '';
      sel.replaceChildren(new Option('No saved outputs yet', ''));
      el('splitOutputEmpty').hidden = false;
      el('splitOutputViewer').hidden = true;
      return;
    }
    sel.replaceChildren(...state.outputs.map(o => new Option(o.relPath, o.relPath)));
    if (!state.splitOutputPath || !state.outputs.some(o => o.relPath === state.splitOutputPath)) {
      state.splitOutputPath = state.outputs[0].relPath;
    }
    sel.value = state.splitOutputPath;
    el('splitOutputEmpty').hidden = true;
    el('splitOutputViewer').hidden = false;
    if (state.splitOpen && state.splitTab === 'outputs') {
      send('readOutput', {relPath: state.splitOutputPath, target: 'split'});
    }
  }

  function applySplitState() {
    el('promptsWorkspace').classList.toggle('splitOpen', state.splitOpen);
    el('splitPane').hidden = !state.splitOpen;
    el('toggleSplit').setAttribute('aria-pressed', String(state.splitOpen));
    el('splitTabNotes').setAttribute('aria-pressed', String(state.splitTab === 'notes'));
    el('splitTabOutputs').setAttribute('aria-pressed', String(state.splitTab === 'outputs'));
    el('splitNotesBody').hidden = state.splitTab !== 'notes';
    el('splitOutputsBody').hidden = state.splitTab !== 'outputs';
    updateSplitInsertButtons();
    if (state.splitOpen) {
      if (state.splitTab === 'notes') syncSplitNotes();
      else {
        syncSplitOutputs();
        send('refreshOutputs');
      }
    }
  }

  function bindSplitEvents() {
    el('toggleSplit').onclick = () => {
      if (state.splitOpen) flushSplitNoteSave();
      state.splitOpen = !state.splitOpen;
      persistUiState();
      applySplitState();
    };
    el('closeSplit').onclick = () => {
      flushSplitNoteSave();
      state.splitOpen = false;
      persistUiState();
      applySplitState();
    };
    el('splitTabNotes').onclick = () => {
      state.splitTab = 'notes';
      persistUiState();
      applySplitState();
    };
    el('splitTabOutputs').onclick = () => {
      flushSplitNoteSave();
      state.splitTab = 'outputs';
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
      state.splitOutputPath = el('splitOutputSelect').value;
      if (state.splitOutputPath) send('readOutput', {relPath: state.splitOutputPath, target: 'split'});
    };
    el('splitRefreshOutputs').onclick = () => { send('refreshOutputs'); showStatus('Outputs refreshed.'); };
    el('splitCopyOutputPath').onclick = () => { send('copy', {text: state.splitOutputFullPath}); flashCopied(el('splitCopyOutputPath')); };
    el('splitOpenOutputIde').onclick = () => { if (state.splitOutputPath) send('openOutputInEditor', {relPath: state.splitOutputPath}); };
    el('splitInsertOutputPath').onclick = () => insertTextIntoActivePrompt(state.splitOutputFullPath, 'Output path');
    el('splitInsertOutputContent').onclick = () => insertTextIntoActivePrompt(state.splitOutputContent, 'Output text');
  }

  Object.assign(app, {
    updateSplitInsertButtons,
    setSplitNoteBadge,
    flushSplitNoteSave,
    syncSplitNotes,
    syncSplitOutputs,
    applySplitState,
    bindSplitEvents
  });
})(window.DevDesk);
