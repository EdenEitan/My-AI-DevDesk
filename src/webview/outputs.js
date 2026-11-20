'use strict';

(function (app) {
  const {state, el, send, node, button, showStatus, flashCopied, formatTime, slugify} = app;

  function setOutputViewMode(mode) {
    state.outputViewMode = mode;
    el('outputModeView').setAttribute('aria-pressed', String(mode === 'rendered'));
    el('outputModeRaw').setAttribute('aria-pressed', String(mode === 'raw'));
    el('outputRendered').hidden = mode !== 'rendered';
    el('outputRawWrap').hidden = mode !== 'raw';
    if (mode === 'raw') {
      el('outputRawEditor').value = state.activeOutputContent;
      el('outputRawEditor').focus();
    }
  }

  function showOutputPane(which) {
    el('outputEmpty').hidden = which !== 'empty';
    el('outputCreateForm').hidden = which !== 'create';
    el('outputDetailWrap').hidden = which !== 'detail';
  }

  function renderOutputsList() {
    el('countOutputs').textContent = String(state.outputs.length);
    el('outputsFolderLabel').textContent = state.outputsPath;
    const q = el('outputSearch').value.trim().toLowerCase();
    const visible = state.outputs.filter(o => !q || o.relPath.toLowerCase().includes(q));
    el('outputList').replaceChildren(...visible.map(o => {
      const b = button('', () => {
        state.activeOutputPath = o.relPath;
        state.outputViewMode = 'rendered';
        send('readOutput', {relPath: o.relPath, target: 'main'});
        renderOutputsList();
      }, 'listItem');
      b.setAttribute('aria-current', String(o.relPath === state.activeOutputPath));
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

  function bindOutputsEvents() {
    el('pasteOutput').onclick = () => send('pasteOutputFromClipboard');
    el('emptyPasteOutput').onclick = () => send('pasteOutputFromClipboard');
    el('newOutput').onclick = () => openCreateOutputForm('');
    el('emptyNewOutput').onclick = () => openCreateOutputForm('');
    el('refreshOutputs').onclick = () => { send('refreshOutputs'); showStatus('Outputs refreshed.'); };
    el('outputSearch').oninput = renderOutputsList;
    el('copyOutputsFolder').onclick = () => { send('copy', {text: state.outputsPath}); flashCopied(el('copyOutputsFolder')); };
    el('outputCreateCancel').onclick = () => showOutputPane(state.activeOutputPath ? 'detail' : 'empty');
    el('outputCreateCancel2').onclick = () => showOutputPane(state.activeOutputPath ? 'detail' : 'empty');
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
      if (!state.activeOutputPath) return;
      send('saveOutput', {relPath: state.activeOutputPath, content: el('outputRawEditor').value});
    };
    el('outputCopyPath').onclick = () => { send('copy', {text: state.activeOutputFullPath}); flashCopied(el('outputCopyPath')); };
    el('outputCopyMd').onclick = () => { send('copy', {text: state.activeOutputContent}); flashCopied(el('outputCopyMd')); };
    el('outputOpenIde').onclick = () => { if (state.activeOutputPath) send('openOutputInEditor', {relPath: state.activeOutputPath}); };
    el('outputDelete').onclick = () => { if (state.activeOutputPath) send('deleteOutput', {relPath: state.activeOutputPath}); };
  }

  Object.assign(app, {
    setOutputViewMode,
    showOutputPane,
    renderOutputsList,
    openCreateOutputForm,
    bindOutputsEvents
  });
})(window.DevDesk);
