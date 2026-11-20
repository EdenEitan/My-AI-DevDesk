'use strict';

(function (app) {
  const {state, el, send, node, button, flashCopied, formatTime} = app;

  function setNoteSaveBadge(status) {
    const badge = el('noteSaveState');
    badge.classList.toggle('saved', status === 'saved');
    badge.textContent = status === 'saving' ? 'Saving…' : 'Saved ✓';
  }

  function flushNoteSave() {
    if (!state.noteDirty || !state.activeNoteId) return;
    clearTimeout(state.noteSaveTimer);
    state.noteSaveTimer = null;
    state.noteDirty = false;
    send('saveNote', {
      id: state.activeNoteId,
      revision: state.activeNoteRevision,
      title: el('noteTitle').value,
      content: el('noteBody').value
    });
  }

  function scheduleNoteSave() {
    if (!state.activeNoteId) return;
    state.noteDirty = true;
    setNoteSaveBadge('saving');
    clearTimeout(state.noteSaveTimer);
    state.noteSaveTimer = setTimeout(flushNoteSave, 450);
  }

  function selectNote(id) {
    if (state.activeNoteId && state.activeNoteId !== id) flushNoteSave();
    state.activeNoteId = id;
    const note = state.notes.find(n => n.id === id);
    if (!note) {
      state.activeNoteRevision = null;
      el('noteEmpty').hidden = false;
      el('noteEditorWrap').hidden = true;
      renderNotesList();
      return;
    }
    state.activeNoteRevision = note.revision ?? null;
    el('noteEmpty').hidden = true;
    el('noteEditorWrap').hidden = false;
    el('noteTitle').value = note.title;
    el('noteBody').value = note.content;
    state.noteDirty = false;
    setNoteSaveBadge('saved');
    renderNotesList();
  }

  function renderNotesList() {
    el('countNotes').textContent = String(state.notes.length);
    const q = el('noteSearch').value.trim().toLowerCase();
    const visible = state.notes.filter(n => !q || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q));
    el('noteList').replaceChildren(...visible.map(n => {
      const b = button('', () => selectNote(n.id), 'listItem');
      b.setAttribute('aria-current', String(n.id === state.activeNoteId));
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
    app.syncSplitNotes?.();
  }

  function createNewNote() {
    flushNoteSave();
    send('saveNote', {title: 'Untitled note', content: ''});
  }

  function bindNotesEvents() {
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
    el('noteDelete').onclick = () => {
      if (state.activeNoteId) send('deleteNote', {id: state.activeNoteId, revision: state.activeNoteRevision});
    };
  }

  Object.assign(app, {
    setNoteSaveBadge,
    flushNoteSave,
    scheduleNoteSave,
    selectNote,
    renderNotesList,
    createNewNote,
    bindNotesEvents
  });
})(window.DevDesk);
