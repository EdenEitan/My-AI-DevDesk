'use strict';

(function (globalScope) {
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

  function slugify(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'output';
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {extractVariables, isMultilineVar, renderTemplate, escapeRegExp, slugify};
  }
  if (typeof window === 'undefined' || typeof acquireVsCodeApi === 'undefined') return;

  const api = acquireVsCodeApi();
  const savedState = api.getState() || {};
  const el = id => document.getElementById(id);
  const send = (type, data = {}) => api.postMessage({type, ...data});

  const state = {
    ALL: '__ALL__',
    symbols: ['⌘', '✓', '✦', '◇', '☀'],
    activeModule: savedState.activeModule || 'prompts',
    splitOpen: Boolean(savedState.splitOpen),
    splitTab: savedState.splitTab === 'outputs' ? 'outputs' : 'notes',
    activePromptScreen: 'browse',
    activeReaderId: null,
    fontScale: 'md',
    request: 0,
    adapting: false,
    fileManuallyPicked: false,
    rows: [],
    categories: [],
    selectedCategory: '__ALL__',
    editing: null,
    pending: false,
    outputsPath: '',
    activeCustomPrompt: null,
    customTemplate: '',
    draftManuallyEdited: false,
    varValues: {},
    varInputs: {},
    outputDest: 'project',
    notes: [],
    activeNoteId: null,
    activeNoteRevision: null,
    noteSaveTimer: null,
    noteDirty: false,
    splitNoteId: null,
    splitNoteRevision: null,
    splitNoteSaveTimer: null,
    splitNoteDirty: false,
    splitOutputPath: null,
    splitOutputFullPath: '',
    splitOutputContent: '',
    outputs: [],
    activeOutputPath: null,
    activeOutputFullPath: '',
    activeOutputContent: '',
    outputViewMode: 'rendered',
    skills: [],
    skillsPath: '',
    activeSkillSlug: null,
    activeSkillDoc: null,
    editingSkillSlug: null,
    skillViewMode: 'rendered',
    workspaceFolders: []
  };

  let statusTimer = null;

  function persistUiState() {
    api.setState({
      activeModule: state.activeModule,
      splitOpen: state.splitOpen,
      splitTab: state.splitTab
    });
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

  function applyScale(scale) {
    state.fontScale = ['sm', 'md', 'lg'].includes(scale) ? scale : 'md';
    document.body.classList.remove('scale-sm', 'scale-md', 'scale-lg');
    document.body.classList.add('scale-' + state.fontScale);
    el('scaleSm').setAttribute('aria-pressed', String(state.fontScale === 'sm'));
    el('scaleMd').setAttribute('aria-pressed', String(state.fontScale === 'md'));
    el('scaleLg').setAttribute('aria-pressed', String(state.fontScale === 'lg'));
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

  globalScope.DevDesk = Object.assign(globalScope.DevDesk || {}, {
    api,
    state,
    el,
    send,
    node,
    button,
    persistUiState,
    showStatus,
    flashCopied,
    formatTime,
    slugify,
    applyScale,
    extractVariables,
    isMultilineVar,
    renderTemplate,
    escapeRegExp,
    insertTextAtCursor
  });
})(typeof window !== 'undefined' ? window : globalThis);
