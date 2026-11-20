const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {randomBytes} = require('node:crypto');
const {adapt, executable} = require('./adapt');
const {Store, NoteStore, OutputStore, categories} = require('./store');

function resolveStorageDir() {
  const configured = (vscode.workspace.getConfiguration('edenHub').get('storagePath') || '').trim();
  if (configured) {
    const expanded = configured.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.join(os.homedir(), '.edens-prompt-hub');
}

function getFontScale() {
  const val = vscode.workspace.getConfiguration('edenHub').get('fontScale', 'md');
  return ['sm', 'md', 'lg'].includes(val) ? val : 'md';
}

function legacyStorageDirs(context) {
  const dirs = [context.globalStorageUri.fsPath];
  if (process.platform === 'win32' && process.env.APPDATA) {
    dirs.push(
      path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'eden-eitan.edens-prompt-hub'),
      path.join(process.env.APPDATA, 'Antigravity IDE', 'User', 'globalStorage', 'eden-eitan.edens-prompt-hub')
    );
  } else if (process.platform === 'darwin') {
    const support = path.join(os.homedir(), 'Library', 'Application Support');
    dirs.push(
      path.join(support, 'Code', 'User', 'globalStorage', 'eden-eitan.edens-prompt-hub'),
      path.join(support, 'Antigravity IDE', 'User', 'globalStorage', 'eden-eitan.edens-prompt-hub')
    );
  } else {
    const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    dirs.push(
      path.join(cfg, 'Code', 'User', 'globalStorage', 'eden-eitan.edens-prompt-hub'),
      path.join(cfg, 'Antigravity IDE', 'User', 'globalStorage', 'eden-eitan.edens-prompt-hub')
    );
  }
  return dirs;
}

function captureSelection(editor) {
  if (!editor || editor.selection.isEmpty) return null;
  const {document, selection} = editor;
  if (!['file', 'untitled'].includes(document.uri.scheme)) return null;
  const text = document.getText(selection);
  if (!text.trim()) return null;
  const fileName = document.isUntitled
    ? (document.fileName || 'Untitled')
    : vscode.workspace.asRelativePath(document.uri, false);
  return {
    text,
    fileName,
    languageId: document.languageId || '',
    startLine: selection.start.line + 1,
    endLine: selection.end.line + 1
  };
}

function formatSnippet(sel) {
  const lineInfo = sel.startLine === sel.endLine
    ? `line ${sel.startLine}`
    : `lines ${sel.startLine}-${sel.endLine}`;
  const fence = sel.text.includes('```') ? '````' : '```';
  return `File: \`${sel.fileName}\` (${lineInfo})\n${fence}${sel.languageId}\n${sel.text}\n${fence}`;
}

function captureFile(editor) {
  if (!editor || editor.document.uri.scheme !== 'file') return '';
  return editor.document.uri.fsPath;
}

function activate(context) {
  let rootDir = resolveStorageDir();
  let store = new Store(rootDir);
  let noteStore = new NoteStore(rootDir);
  let outputStore = new OutputStore(rootDir);
  store.migrateFromIfEmpty(legacyStorageDirs(context));

  const views = new Set();
  let panel;
  let lastSelection = captureSelection(vscode.window.activeTextEditor);
  let lastFile = captureFile(vscode.window.activeTextEditor);
  let outputWatcher;
  let watchTimer;

  function broadcast(payload) {
    for (const web of views) web.postMessage(payload);
  }

  function refreshLibrary() {
    const data = store.list();
    const folders = (vscode.workspace.workspaceFolders || [])
      .filter(f => f.uri.scheme === 'file')
      .map(f => f.uri.fsPath);
    broadcast({
      type: 'library',
      categories,
      folders,
      activeFile: lastFile,
      storagePath: store.root,
      outputsPath: outputStore.root,
      fontScale: getFontScale(),
      ...data
    });
  }

  function refreshNotes() {
    broadcast({type: 'notes', ...noteStore.list()});
  }

  function refreshOutputs() {
    broadcast({type: 'outputs', ...outputStore.list()});
  }

  function refreshAll() {
    refreshLibrary();
    refreshNotes();
    refreshOutputs();
  }

  function startOutputWatcher() {
    if (outputWatcher) {
      try { outputWatcher.close(); } catch { /* ignore */ }
      outputWatcher = undefined;
    }
    try {
      outputWatcher = fs.watch(outputStore.root, {recursive: true}, () => {
        clearTimeout(watchTimer);
        watchTimer = setTimeout(refreshOutputs, 250);
      });
      outputWatcher.on('error', () => { /* ignore transient fs.watch errors */ });
    } catch {
      // Fallback: outputs still refresh on window focus and manual Refresh button.
    }
  }
  startOutputWatcher();

  async function verify(id) {
    const p = store.read(id);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(store.file(p.checklist, '.md')));
    await vscode.window.showTextDocument(doc, {preview: false});
    return doc;
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

  function ensureDashboard() {
    if (panel) {
      panel.reveal();
      return panel;
    }
    panel = vscode.window.createWebviewPanel(
      'edenHub.dashboard',
      'My AI DevDesk',
      vscode.ViewColumn.Active,
      {enableScripts: true, retainContextWhenHidden: true}
    );
    panel.onDidDispose(() => { panel = undefined; });
    attach(panel, false);
    return panel;
  }

  function attach(owner, sidebar) {
    const web = owner.webview;
    const root = context.extensionUri;
    web.options = {enableScripts: true, localResourceRoots: [root]};
    const asset = name => web.asWebviewUri(vscode.Uri.joinPath(root, name)).toString();
    const nonce = randomBytes(20).toString('hex');
    views.add(web);
    let job;
    owner.onDidDispose(() => { job?.abort(); views.delete(web); });

    web.onDidReceiveMessage(async m => {
      try {
        switch (m.type) {
          case 'ready':
            refreshAll();
            return;
          case 'expand':
            ensureDashboard();
            return;
          case 'popOut':
            ensureDashboard();
            try {
              await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
            } catch {
              throw Error('Could not move dashboard to a new window automatically. Drag the tab out to pop it into a separate window.');
            }
            return;
          case 'setFontScale':
            if (['sm', 'md', 'lg'].includes(m.scale)) {
              await vscode.workspace.getConfiguration('edenHub').update('fontScale', m.scale, vscode.ConfigurationTarget.Global);
              broadcast({type: 'fontScale', scale: m.scale});
            }
            return;
          case 'verify':
            await verify(m.id);
            break;
          case 'copy':
            await vscode.env.clipboard.writeText(m.text || '');
            break;
          case 'openAntigravity':
            await openAntigravityChat(m.text || '');
            break;
          case 'openCodex':
            await vscode.env.clipboard.writeText(m.text || '');
            if (!vscode.extensions.getExtension('openai.chatgpt')) {
              throw Error('Prompt copied. Enable the Codex extension in this profile to open its chat.');
            }
            await vscode.commands.executeCommand('chatgpt.openSidebar');
            break;
          case 'insertSelection': {
            const sel = captureSelection(vscode.window.activeTextEditor) || lastSelection;
            if (!sel) throw Error('Select code in an editor first, then click Insert selected code.');
            web.postMessage({type: 'selectionInserted', target: m.target || 'draft', snippet: formatSnippet(sel)});
            return;
          }
          case 'pickFile': {
            const defaultPath = m.currentFile || m.folder || lastFile || '';
            const defaultUri = defaultPath && fs.existsSync(defaultPath) ? vscode.Uri.file(defaultPath) : undefined;
            const picked = await vscode.window.showOpenDialog({
              canSelectFiles: true,
              canSelectFolders: false,
              canSelectMany: false,
              defaultUri
            });
            if (picked?.[0]) {
              lastFile = picked[0].fsPath;
              web.postMessage({type: 'filePicked', file: lastFile});
            }
            return;
          }
          case 'stopAdapt':
            job?.abort();
            return;
          case 'adapt': {
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
            return;
          }
          case 'save':
          case 'delete': {
            if (m.type === 'delete' && await vscode.window.showWarningMessage(
              'Delete "' + store.read(m.id).title + '" and its checklist?',
              {modal: true},
              'Delete'
            ) !== 'Delete') return;
            if (m.id && (m.removeChecklist || m.type === 'delete')) {
              const key = store.read(m.id).checklist;
              if (key && vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.fsPath === store.file(key, '.md'))) {
                throw Error('Save or close the unsaved checklist before removing it.');
              }
            }
            if (m.type === 'save') store.save(m); else store.remove(m.id, m.revision);
            refreshLibrary();
            break;
          }
          case 'togglePin': {
            const updated = store.togglePin(m.id);
            refreshLibrary();
            web.postMessage({type: 'pinToggled', id: updated.id, pinned: updated.pinned});
            return;
          }
          case 'saveNote': {
            const saved = noteStore.save({id: m.id, title: m.title, content: m.content});
            web.postMessage({type: 'noteSaved', note: saved});
            refreshNotes();
            return;
          }
          case 'deleteNote': {
            const existing = noteStore.read(m.id);
            if (await vscode.window.showWarningMessage(
              'Delete note "' + existing.title + '"?',
              {modal: true},
              'Delete'
            ) !== 'Delete') return;
            noteStore.remove(m.id);
            web.postMessage({type: 'noteDeleted', id: m.id});
            refreshNotes();
            return;
          }
          case 'refreshOutputs':
            refreshOutputs();
            return;
          case 'readOutput': {
            const doc = outputStore.read(m.relPath);
            web.postMessage({type: 'outputContent', target: m.target || 'main', ...doc});
            return;
          }
          case 'saveOutput': {
            const saved = outputStore.save(m.relPath, m.content);
            const doc = outputStore.read(saved.relPath);
            refreshOutputs();
            web.postMessage({type: 'outputSaved', ...doc});
            return;
          }
          case 'pasteOutputFromClipboard': {
            const clip = await vscode.env.clipboard.readText();
            web.postMessage({type: 'clipboardForOutput', content: clip || ''});
            return;
          }
          case 'toggleOutputCheckbox': {
            const updated = outputStore.toggleCheckbox(m.relPath, m.lineIndex);
            web.postMessage({type: 'outputContent', target: m.target || 'main', ...updated});
            return;
          }
          case 'openOutputInEditor': {
            const {fullPath} = outputStore.safePath(m.relPath);
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
            await vscode.window.showTextDocument(doc, {preview: false});
            return;
          }
          case 'deleteOutput': {
            const {relPath} = outputStore.safePath(m.relPath);
            if (await vscode.window.showWarningMessage(
              'Delete output document "' + relPath + '"?',
              {modal: true},
              'Delete'
            ) !== 'Delete') return;
            outputStore.remove(relPath);
            web.postMessage({type: 'outputDeleted', relPath});
            refreshOutputs();
            return;
          }
          default:
            return;
        }
        web.postMessage({type: 'done', action: m.type});
      } catch (e) {
        web.postMessage({type: 'error', message: e.message});
      }
    });

    web.html = fs.readFileSync(vscode.Uri.joinPath(root, 'index.html').fsPath, 'utf8')
      .replaceAll('WEB_SOURCE', web.cspSource)
      .replaceAll('NONCE_VALUE', nonce)
      .replace('STYLE_URI', asset('style.css'))
      .replace('SCRIPT_URI', asset('app.js'))
      .replace('VIEW_MODE', sidebar ? 'sidebar' : 'panel');
  }

  context.subscriptions.push(
    {dispose: () => { clearTimeout(watchTimer); if (outputWatcher) outputWatcher.close(); }},
    vscode.window.registerWebviewViewProvider(
      'edenHub.library',
      {resolveWebviewView: view => attach(view, true)},
      {webviewOptions: {retainContextWhenHidden: true}}
    ),
    vscode.commands.registerCommand('edenHub.open', () => { ensureDashboard(); }),
    vscode.window.onDidChangeTextEditorSelection(e => {
      const sel = captureSelection(e.textEditor);
      if (sel) lastSelection = sel;
    }),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      const sel = captureSelection(editor);
      if (sel) lastSelection = sel;
      const file = captureFile(editor);
      if (file && file !== lastFile) {
        lastFile = file;
        broadcast({type: 'activeFile', file});
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshLibrary),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('edenHub.storagePath')) {
        rootDir = resolveStorageDir();
        store = new Store(rootDir);
        noteStore = new NoteStore(rootDir);
        outputStore = new OutputStore(rootDir);
        store.migrateFromIfEmpty(legacyStorageDirs(context));
        startOutputWatcher();
        refreshAll();
      } else if (e.affectsConfiguration('edenHub.fontScale')) {
        broadcast({type: 'fontScale', scale: getFontScale()});
      }
    }),
    vscode.window.onDidChangeWindowState(s => { if (s.focused) refreshAll(); })
  );

  return {store, noteStore, outputStore, verify};
}

module.exports = {activate, formatSnippet};
