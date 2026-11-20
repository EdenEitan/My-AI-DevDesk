const vscode = require('vscode');
const fs = require('node:fs');
const {randomBytes} = require('node:crypto');
const {Store, NoteStore, OutputStore, categories} = require('./src/storage');
const {resolveStorageDir, getFontScale, legacyStorageDirs} = require('./src/host/config');
const {captureSelection, captureFile, formatSnippet} = require('./src/host/editorContext');
const {createMessageRouter} = require('./src/host/messageRouter');

function activate(context) {
  let rootDir = resolveStorageDir(vscode);
  let store = new Store(rootDir);
  let noteStore = new NoteStore(rootDir);
  let outputStore = new OutputStore(rootDir);
  store.migrateFromIfEmpty(legacyStorageDirs(context));

  const views = new Set();
  let panel;
  let lastSelection = captureSelection(vscode, vscode.window.activeTextEditor);
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
      fontScale: getFontScale(vscode),
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

  const hostCtx = {
    vscode,
    getStore: () => store,
    getNoteStore: () => noteStore,
    getOutputStore: () => outputStore,
    getLastSelection: () => lastSelection,
    getLastFile: () => lastFile,
    setLastFile: f => { lastFile = f; },
    broadcast,
    refreshLibrary,
    refreshNotes,
    refreshOutputs,
    refreshAll,
    ensureDashboard,
    verify
  };

  function attach(owner, sidebar) {
    const web = owner.webview;
    const root = context.extensionUri;
    const webRoot = vscode.Uri.joinPath(root, 'src', 'webview');
    web.options = {enableScripts: true, localResourceRoots: [webRoot, root]};
    const asset = name => web.asWebviewUri(vscode.Uri.joinPath(webRoot, name)).toString();
    const nonce = randomBytes(20).toString('hex');
    views.add(web);

    const router = createMessageRouter(hostCtx, web);
    owner.onDidDispose(() => { router.dispose(); views.delete(web); });
    web.onDidReceiveMessage(router.dispatch);

    web.html = fs.readFileSync(vscode.Uri.joinPath(webRoot, 'index.html').fsPath, 'utf8')
      .replaceAll('WEB_SOURCE', web.cspSource)
      .replaceAll('NONCE_VALUE', nonce)
      .replace('STYLE_URI', asset('style.css'))
      .replace('SCRIPT_CORE_URI', asset('core.js'))
      .replace('SCRIPT_MARKDOWN_URI', asset('markdown.js'))
      .replace('SCRIPT_PROMPTS_URI', asset('prompts.js'))
      .replace('SCRIPT_NOTES_URI', asset('notes.js'))
      .replace('SCRIPT_OUTPUTS_URI', asset('outputs.js'))
      .replace('SCRIPT_SPLIT_URI', asset('splitPane.js'))
      .replace('SCRIPT_MAIN_URI', asset('main.js'))
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
      const sel = captureSelection(vscode, e.textEditor);
      if (sel) lastSelection = sel;
    }),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      const sel = captureSelection(vscode, editor);
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
        rootDir = resolveStorageDir(vscode);
        store = new Store(rootDir);
        noteStore = new NoteStore(rootDir);
        outputStore = new OutputStore(rootDir);
        store.migrateFromIfEmpty(legacyStorageDirs(context));
        startOutputWatcher();
        refreshAll();
      } else if (e.affectsConfiguration('edenHub.fontScale')) {
        broadcast({type: 'fontScale', scale: getFontScale(vscode)});
      }
    }),
    vscode.window.onDidChangeWindowState(s => { if (s.focused) refreshAll(); })
  );

  return {store, noteStore, outputStore, verify};
}

module.exports = {activate, formatSnippet};
