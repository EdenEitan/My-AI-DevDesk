'use strict';

(function (app) {
  const {state, el, send, node, button, showStatus, flashCopied, formatTime, slugify} = app;

  const STARTER_SKILL_BODY = [
    '# Skill Title',
    '',
    'Explain the goal of this skill and the context the agent needs.',
    '',
    '## Steps',
    '',
    '1. Inspect the relevant files and configuration.',
    '2. Execute the workflow step by step.',
    '3. Verify the output against the checklist below.',
    '',
    '## Verification Checklist',
    '',
    '- [ ] Step 1 completed and verified',
    '- [ ] Tests or validation checks pass'
  ].join('\n');

  function parseRawFrontmatterClient(raw) {
    const text = typeof raw === 'string' ? raw : '';
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
    if (!match) {
      const heading = text.match(/^#\s+(.+)$/m);
      return {
        name: heading ? slugify(heading[1]) : 'my-custom-skill',
        description: '',
        body: text.trim() || STARTER_SKILL_BODY
      };
    }
    const fm = match[1];
    const body = match[2].replace(/^\r?\n/, '');
    const nameMatch = fm.match(/^name\s*:\s*(.+)$/m);
    let desc = '';
    const blockMatch = fm.match(/^description\s*:\s*[>|][-+]?\r?\n((?:[ \t]+.+\r?\n?)+)/m);
    if (blockMatch) {
      desc = blockMatch[1].split(/\r?\n/).map(l => l.trim()).filter(Boolean).join(' ');
    } else {
      const singleMatch = fm.match(/^description\s*:\s*(.+)$/m);
      if (singleMatch) desc = singleMatch[1].trim().replace(/^["']|["']$/g, '');
    }
    return {
      name: nameMatch ? slugify(nameMatch[1].trim()) : 'my-custom-skill',
      description: desc,
      body: body || STARTER_SKILL_BODY
    };
  }

  function updateSkillPreviewPath() {
    const slug = slugify(el('skillNameInput').value || 'my-custom-skill');
    const sep = (state.skillsPath || '').includes('\\') ? '\\' : '/';
    const base = state.skillsPath ? state.skillsPath.replace(/[\\/]+$/, '') : '~/.edens-prompt-hub/skills';
    el('skillPreviewPath').textContent = 'Saves to: ' + base + sep + slug + sep + 'SKILL.md';
  }

  function showSkillPane(which) {
    el('skillEmpty').hidden = which !== 'empty';
    el('skillForm').hidden = which !== 'form';
    el('skillDetailWrap').hidden = which !== 'detail';
  }

  function setSkillViewMode(mode) {
    state.skillViewMode = mode;
    el('skillModeView').setAttribute('aria-pressed', String(mode === 'rendered'));
    el('skillModeForm').setAttribute('aria-pressed', String(mode === 'form'));
    el('skillModeRaw').setAttribute('aria-pressed', String(mode === 'raw'));
    if (mode === 'form' && state.activeSkillDoc) {
      openSkillForm({
        editingSlug: state.activeSkillDoc.slug,
        name: state.activeSkillDoc.name,
        description: state.activeSkillDoc.description,
        body: state.activeSkillDoc.body
      });
      return;
    }
    showSkillPane('detail');
    el('skillRendered').hidden = mode !== 'rendered';
    el('skillRawWrap').hidden = mode !== 'raw';
    if (mode === 'raw' && state.activeSkillDoc) {
      el('skillRawEditor').value = state.activeSkillDoc.content;
      el('skillRawEditor').focus();
    }
  }

  function syncSkillProjectDropdown() {
    const sel = el('skillTargetProject');
    const folders = state.workspaceFolders || [];
    const prev = sel.value;
    if (!folders.length) {
      sel.replaceChildren(new Option('No project folder open', ''));
      sel.disabled = true;
      el('skillExportProject').disabled = true;
      return;
    }
    sel.disabled = false;
    el('skillExportProject').disabled = false;
    sel.replaceChildren(...folders.map(f => {
      const parts = f.split(/[\\/]/).filter(Boolean);
      const label = parts[parts.length - 1] || f;
      return new Option(label + ' (.agents/skills)', f);
    }));
    if (folders.includes(prev)) sel.value = prev;
  }

  function renderSkillsList() {
    el('countSkills').textContent = String(state.skills.length);
    el('skillsFolderLabel').textContent = state.skillsPath;
    syncSkillProjectDropdown();
    const q = el('skillSearch').value.trim().toLowerCase();
    const visible = state.skills.filter(s =>
      !q ||
      s.slug.toLowerCase().includes(q) ||
      (s.name || '').toLowerCase().includes(q) ||
      (s.description || '').toLowerCase().includes(q)
    );
    el('skillList').replaceChildren(...visible.map(s => {
      const b = button('', () => {
        state.activeSkillSlug = s.slug;
        state.skillViewMode = 'rendered';
        send('readSkill', {slug: s.slug});
        renderSkillsList();
      }, 'listItem');
      b.setAttribute('aria-current', String(s.slug === state.activeSkillSlug));
      const title = node('div', s.name || s.slug, 'listItemTitle');
      const subText = (s.description ? s.description : 'SKILL.md') + ' · ' + formatTime(s.updatedAt);
      const sub = node('div', subText, 'listItemSub');
      sub.dir = 'auto';
      b.append(title, sub);
      return b;
    }));
    if (!visible.length) {
      el('skillList').append(node('div', q ? 'No matching skills.' : 'No saved skills yet.', 'subtleHint'));
    }
  }

  function openSkillForm({editingSlug = null, name = '', description = '', body = ''} = {}) {
    state.editingSkillSlug = editingSlug;
    el('skillFormTitle').textContent = editingSlug ? 'Edit Skill (' + editingSlug + '/SKILL.md)' : 'Build New Skill (SKILL.md)';
    el('skillNameInput').value = name || '';
    el('skillDescInput').value = description || '';
    el('skillBodyInput').value = body || STARTER_SKILL_BODY;
    updateSkillPreviewPath();
    showSkillPane('form');
    el('skillNameInput').focus();
    if (!editingSlug) el('skillNameInput').select();
  }

  function openSkillFormFromClipboard(rawText) {
    const parsed = parseRawFrontmatterClient(rawText);
    openSkillForm({
      editingSlug: null,
      name: parsed.name,
      description: parsed.description,
      body: parsed.body
    });
  }

  function bindSkillsEvents() {
    el('newSkill').onclick = () => openSkillForm();
    el('emptyNewSkill').onclick = () => openSkillForm();
    el('pasteSkill').onclick = () => send('pasteSkillFromClipboard');
    el('emptyPasteSkill').onclick = () => send('pasteSkillFromClipboard');
    el('refreshSkills').onclick = () => { send('refreshSkills'); showStatus('Skills refreshed.'); };
    el('skillSearch').oninput = renderSkillsList;
    el('copySkillsFolder').onclick = () => { send('copy', {text: state.skillsPath}); flashCopied(el('copySkillsFolder')); };
    el('skillNameInput').oninput = updateSkillPreviewPath;

    const cancelForm = () => {
      state.editingSkillSlug = null;
      if (state.activeSkillSlug && state.activeSkillDoc) {
        setSkillViewMode('rendered');
      } else {
        showSkillPane('empty');
      }
    };
    el('skillFormCancel').onclick = cancelForm;
    el('skillFormCancel2').onclick = cancelForm;

    el('skillForm').onsubmit = e => {
      e.preventDefault();
      send('saveSkill', {
        previousSlug: state.editingSkillSlug,
        name: el('skillNameInput').value,
        description: el('skillDescInput').value,
        body: el('skillBodyInput').value
      });
    };

    el('skillModeView').onclick = () => setSkillViewMode('rendered');
    el('skillModeForm').onclick = () => setSkillViewMode('form');
    el('skillModeRaw').onclick = () => setSkillViewMode('raw');
    el('skillCancelRaw').onclick = () => setSkillViewMode('rendered');
    el('skillSaveRaw').onclick = () => {
      if (!state.activeSkillSlug) return;
      send('saveSkill', {
        previousSlug: state.activeSkillSlug,
        slug: state.activeSkillSlug,
        rawContent: el('skillRawEditor').value
      });
    };

    el('skillCopyMd').onclick = () => {
      if (!state.activeSkillDoc) return;
      send('copy', {text: state.activeSkillDoc.content});
      flashCopied(el('skillCopyMd'));
    };
    el('skillCopyPath').onclick = () => {
      if (!state.activeSkillDoc) return;
      send('copy', {text: state.activeSkillDoc.fullPath});
      flashCopied(el('skillCopyPath'));
    };
    el('skillOpenIde').onclick = () => {
      if (state.activeSkillSlug) send('openSkillInEditor', {slug: state.activeSkillSlug});
    };
    el('skillDelete').onclick = () => {
      if (state.activeSkillSlug) send('deleteSkill', {slug: state.activeSkillSlug});
    };
    el('skillExportProject').onclick = () => {
      if (!state.activeSkillSlug) return;
      send('exportSkill', {
        slug: state.activeSkillSlug,
        target: 'project',
        folder: el('skillTargetProject').value
      });
    };
    el('skillExportGlobal').onclick = () => {
      if (!state.activeSkillSlug) return;
      send('exportSkill', {
        slug: state.activeSkillSlug,
        target: 'global'
      });
    };
  }

  Object.assign(app, {
    showSkillPane,
    setSkillViewMode,
    renderSkillsList,
    openSkillForm,
    openSkillFormFromClipboard,
    syncSkillProjectDropdown,
    bindSkillsEvents
  });
})(window.DevDesk);
