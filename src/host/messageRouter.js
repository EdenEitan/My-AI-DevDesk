const fs = require('node:fs');
const path = require('node:path');
const {adapt, executable} = require('./adapt');
const {captureSelection, formatSnippet} = require('./editorContext');

function createMessageRouter(ctx, web) {
  const {vscode} = ctx;
  let job;

  function abortJob() {
    job?.abort();
    job = undefined;
  }

  async function openAntigravityChat(text) {
    await vscode.env.clipboard.writeText(text);
    const allCommands = await vscode.commands.getCommands(true);
    if (allCommands.includes('antigravity.panel.focus')) {
      await vscode.commands.executeCommand('antigravity.panel.focus');
      return;
    }
    if (allCommands.includes('antigravity.toggleChatFocus')) {
      await vscode.commands.executeCommand('antigravity.toggleChatFocus', 'focus');
      return;
    }
    throw Error('Prompt copied. Enable Antigravity to open its chat panel.');
  }

  async function handleSaveOrDeletePrompt(m) {
    const store = ctx.getStore();
    if (m.type === 'delete' && await vscode.window.showWarningMessage(
      'Delete "' + store.read(m.id).title + '" and its checklist?',
      {modal: true},
      'Delete'
    ) !== 'Delete') return false;

    if (m.id && (m.removeChecklist || m.type === 'delete')) {
      const key = store.read(m.id).checklist;
      if (key && vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.fsPath === store.file(key, '.md'))) {
        throw Error('Save or close the unsaved checklist before removing it.');
      }
    }
    if (m.type === 'save') store.save(m); else store.remove(m.id, m.revision);
    ctx.refreshLibrary();
    return true;
  }

  const handlers = {
    ready: () => { ctx.refreshAll(); },
    expand: () => { ctx.ensureDashboard(); },
    popOut: async () => {
      ctx.ensureDashboard();
      try {
        await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      } catch {
        throw Error('Could not move dashboard to a new window automatically. Drag the tab out to pop it into a separate window.');
      }
    },
    setFontScale: async m => {
      if (['sm', 'md', 'lg'].includes(m.scale)) {
        await vscode.workspace.getConfiguration('edenHub').update('fontScale', m.scale, vscode.ConfigurationTarget.Global);
        ctx.broadcast({type: 'fontScale', scale: m.scale});
      }
    },
    verify: async m => { await ctx.verify(m.id); return true; },
    copy: async m => { await vscode.env.clipboard.writeText(m.text || ''); return true; },
    openAntigravity: async m => { await openAntigravityChat(m.text || ''); return true; },
    openCodex: async m => {
      await vscode.env.clipboard.writeText(m.text || '');
      if (!vscode.extensions.getExtension('openai.chatgpt')) {
        throw Error('Prompt copied. Enable the Codex extension in this profile to open its chat.');
      }
      await vscode.commands.executeCommand('chatgpt.openSidebar');
      return true;
    },
    insertSelection: m => {
      const sel = captureSelection(vscode, vscode.window.activeTextEditor) || ctx.getLastSelection();
      if (!sel) throw Error('Select code in an editor first, then click Insert selected code.');
      web.postMessage({type: 'selectionInserted', target: m.target || 'draft', snippet: formatSnippet(sel)});
    },
    pickFile: async m => {
      const defaultPath = m.currentFile || m.folder || ctx.getLastFile() || '';
      const defaultUri = defaultPath && fs.existsSync(defaultPath) ? vscode.Uri.file(defaultPath) : undefined;
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri
      });
      if (picked?.[0]) {
        ctx.setLastFile(picked[0].fsPath);
        web.postMessage({type: 'filePicked', file: picked[0].fsPath});
      }
    },
    stopAdapt: () => { abortJob(); },
    adapt: async m => {
      if (job) job.abort();
      const current = new AbortController();
      job = current;
      const timeout = setTimeout(() => current.abort(), 180000);
      try {
        if (!vscode.workspace.isTrusted) throw Error('AI adaptation requires a trusted workspace.');
        const targetFile = typeof m.file === 'string' ? m.file.trim() : '';
        const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file' && f.uri.fsPath === m.folder);
        if (!targetFile && !folder) throw Error('Open a local project folder for AI adaptation.');
        if (targetFile && !fs.existsSync(targetFile)) throw Error('Select an existing local file for AI adaptation.');
        if (typeof m.text !== 'string' || !m.text.trim()) throw Error('Enter a prompt first.');
        const workDir = folder ? folder.uri.fsPath : path.dirname(targetFile);
        const binary = executable(vscode.extensions.getExtension('openai.chatgpt')?.extensionPath);
        const text = await adapt(binary, workDir, m.text, current.signal, targetFile || undefined);
        if (job === current) web.postMessage({type: 'adapted', request: m.request, text});
      } catch (e) {
        web.postMessage({
          type: 'adaptFailed',
          request: m.request,
          message: current.signal.aborted ? 'Request stopped or timed out.' : e.message
        });
      } finally {
        clearTimeout(timeout);
        if (job === current) job = undefined;
      }
    },
    save: handleSaveOrDeletePrompt,
    delete: handleSaveOrDeletePrompt,
    togglePin: m => {
      const updated = ctx.getStore().togglePin(m.id);
      ctx.refreshLibrary();
      web.postMessage({type: 'pinToggled', id: updated.id, pinned: updated.pinned});
    },
    saveNote: m => {
      const saved = ctx.getNoteStore().save({
        id: m.id,
        revision: m.revision,
        title: m.title,
        content: m.content
      });
      web.postMessage({type: 'noteSaved', note: saved});
      ctx.refreshNotes();
    },
    deleteNote: async m => {
      const noteStore = ctx.getNoteStore();
      const existing = noteStore.read(m.id);
      if (await vscode.window.showWarningMessage(
        'Delete note "' + existing.title + '"?',
        {modal: true},
        'Delete'
      ) !== 'Delete') return;
      noteStore.remove(m.id, m.revision ?? existing.revision);
      web.postMessage({type: 'noteDeleted', id: m.id});
      ctx.refreshNotes();
    },
    refreshOutputs: () => { ctx.refreshOutputs(); },
    readOutput: m => {
      const doc = ctx.getOutputStore().read(m.relPath);
      web.postMessage({type: 'outputContent', target: m.target || 'main', ...doc});
    },
    saveOutput: m => {
      const outputStore = ctx.getOutputStore();
      const saved = outputStore.save(m.relPath, m.content);
      const doc = outputStore.read(saved.relPath);
      ctx.refreshOutputs();
      web.postMessage({type: 'outputSaved', ...doc});
    },
    pasteOutputFromClipboard: async () => {
      const clip = await vscode.env.clipboard.readText();
      web.postMessage({type: 'clipboardForOutput', content: clip || ''});
    },
    toggleOutputCheckbox: m => {
      const updated = ctx.getOutputStore().toggleCheckbox(m.relPath, m.lineIndex);
      web.postMessage({type: 'outputContent', target: m.target || 'main', ...updated});
    },
    openOutputInEditor: async m => {
      const {fullPath} = ctx.getOutputStore().safePath(m.relPath);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
      await vscode.window.showTextDocument(doc, {preview: false});
    },
    deleteOutput: async m => {
      const outputStore = ctx.getOutputStore();
      const {relPath} = outputStore.safePath(m.relPath);
      if (await vscode.window.showWarningMessage(
        'Delete output document "' + relPath + '"?',
        {modal: true},
        'Delete'
      ) !== 'Delete') return;
      outputStore.remove(relPath);
      web.postMessage({type: 'outputDeleted', relPath});
      ctx.refreshOutputs();
    }
  };

  async function dispatch(m) {
    const fn = m && Object.prototype.hasOwnProperty.call(handlers, m.type) ? handlers[m.type] : null;
    if (!fn) return;
    try {
      const shouldNotifyDone = await fn(m);
      if (shouldNotifyDone) web.postMessage({type: 'done', action: m.type});
    } catch (e) {
      web.postMessage({type: 'error', message: e.message});
    }
  }

  return {dispatch, dispose: abortJob};
}

module.exports = {createMessageRouter};
