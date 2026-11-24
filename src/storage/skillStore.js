const fs = require('node:fs');
const path = require('node:path');
const {atomicWrite} = require('./fsUtils');

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizeSlug(raw) {
  if (typeof raw !== 'string') throw Error('Enter a skill name (lowercase letters, digits, hyphens).');
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!slug || !SLUG_RE.test(slug)) {
    throw Error('Enter a valid skill name (lowercase letters, digits, hyphens).');
  }
  return slug;
}

function unquoteYaml(val) {
  const trimmed = val.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
  }
  return trimmed;
}

function parseSkillMarkdown(raw, fallbackSlug = '') {
  const text = typeof raw === 'string' ? raw : '';
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    return {
      name: fallbackSlug,
      description: '',
      body: text.replace(/^\r?\n/, '')
    };
  }
  const fmLines = match[1].split(/\r?\n/);
  const body = match[2].replace(/^\r?\n/, '');
  let name = '';
  let description = '';
  let i = 0;

  while (i < fmLines.length) {
    const line = fmLines[i];
    const keyMatch = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (!keyMatch) {
      i++;
      continue;
    }
    const key = keyMatch[1].toLowerCase();
    const rest = keyMatch[2].trim();
    if (/^[>|][-+]?$/.test(rest)) {
      const fold = rest.startsWith('>');
      const blockLines = [];
      i++;
      while (i < fmLines.length && (fmLines[i].startsWith('  ') || fmLines[i].startsWith('\t') || !fmLines[i].trim())) {
        blockLines.push(fmLines[i].replace(/^(?:  |\t)/, ''));
        i++;
      }
      while (blockLines.length && !blockLines[blockLines.length - 1].trim()) blockLines.pop();
      const joined = fold
        ? blockLines.map(l => l.trim()).join(' ').replace(/\s+/g, ' ').trim()
        : blockLines.join('\n').trim();
      if (key === 'name') name = joined;
      else if (key === 'description') description = joined;
      continue;
    }
    const val = unquoteYaml(rest);
    if (key === 'name') name = val;
    else if (key === 'description') description = val;
    i++;
  }

  return {
    name: name || fallbackSlug,
    description,
    body
  };
}

function buildSkillMarkdown({name, description, body}) {
  const slug = normalizeSlug(name);
  const desc = typeof description === 'string' ? description.trim() : '';
  if (!desc) throw Error('Enter a trigger description for this skill.');
  const descLines = desc.split(/\r?\n/).map(l => '  ' + l.trim()).filter(l => l.trim());
  const cleanBody = typeof body === 'string' ? body.replace(/^\r?\n+/, '').replace(/\s+$/, '') : '';
  const header = [
    '---',
    'name: ' + slug,
    'description: >-',
    ...descLines,
    '---'
  ].join('\n');
  return cleanBody ? header + '\n\n' + cleanBody + '\n' : header + '\n';
}

class SkillStore {
  constructor(baseRoot) {
    this.root = path.resolve(path.join(baseRoot, 'skills'));
    fs.mkdirSync(this.root, {recursive: true});
  }

  safeSkillPath(rawSlug) {
    const slug = normalizeSlug(rawSlug);
    const dirPath = path.resolve(this.root, slug);
    if (dirPath === this.root || !dirPath.startsWith(this.root + path.sep)) {
      throw Error('Invalid skill identifier.');
    }
    const fullPath = path.join(dirPath, 'SKILL.md');
    return {slug, dirPath, fullPath};
  }

  list() {
    const items = [];
    let entries;
    try { entries = fs.readdirSync(this.root, {withFileTypes: true}); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      let safe;
      try { safe = this.safeSkillPath(entry.name); } catch { continue; }
      if (!fs.existsSync(safe.fullPath)) continue;
      try {
        const st = fs.statSync(safe.fullPath);
        const content = fs.readFileSync(safe.fullPath, 'utf8');
        const parsed = parseSkillMarkdown(content, safe.slug);
        items.push({
          slug: safe.slug,
          name: parsed.name || safe.slug,
          description: parsed.description || '',
          fullPath: safe.fullPath,
          dirPath: safe.dirPath,
          size: st.size,
          updatedAt: st.mtimeMs
        });
      } catch { /* skip unreadable skill */ }
    }
    items.sort((a, b) => a.slug.localeCompare(b.slug));
    return {items, skillsPath: this.root};
  }

  read(rawSlug) {
    const {slug, dirPath, fullPath} = this.safeSkillPath(rawSlug);
    if (!fs.existsSync(fullPath)) throw Error('Skill not found.');
    const content = fs.readFileSync(fullPath, 'utf8');
    const st = fs.statSync(fullPath);
    const parsed = parseSkillMarkdown(content, slug);
    return {
      slug,
      name: parsed.name || slug,
      description: parsed.description || '',
      body: parsed.body,
      content,
      dirPath,
      fullPath,
      updatedAt: st.mtimeMs
    };
  }

  save(input = {}) {
    let slug;
    let content;
    if (typeof input.rawContent === 'string' && input.rawContent.trim()) {
      const parsed = parseSkillMarkdown(input.rawContent, input.name || input.slug || '');
      slug = normalizeSlug(parsed.name || input.name || input.slug || '');
      if (!parsed.description.trim()) {
        throw Error('SKILL.md frontmatter must include a non-empty description field.');
      }
      if (/^---\r?\n/.test(input.rawContent)) {
        content = input.rawContent.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (fmBlock) => {
          if (/^name\s*:/m.test(fmBlock)) {
            return fmBlock.replace(/^name\s*:.*$/m, 'name: ' + slug);
          }
          return '---\nname: ' + slug + '\n' + fmBlock.slice(4);
        });
        if (!content.endsWith('\n')) content += '\n';
      } else {
        content = buildSkillMarkdown({name: slug, description: parsed.description, body: parsed.body});
      }
    } else {
      slug = normalizeSlug(input.name || input.slug || '');
      content = buildSkillMarkdown({
        name: slug,
        description: input.description,
        body: input.body
      });
    }

    const {dirPath, fullPath} = this.safeSkillPath(slug);
    atomicWrite(fullPath, content);

    if (input.previousSlug) {
      const prev = normalizeSlug(input.previousSlug);
      if (prev !== slug) {
        const prevSafe = this.safeSkillPath(prev);
        if (fs.existsSync(prevSafe.dirPath)) {
          fs.rmSync(prevSafe.dirPath, {recursive: true, force: true});
        }
      }
    }

    return {slug, dirPath, fullPath};
  }

  toggleCheckbox(rawSlug, lineIndex) {
    const {slug, fullPath} = this.safeSkillPath(rawSlug);
    if (!fs.existsSync(fullPath)) throw Error('Skill not found.');
    const raw = fs.readFileSync(fullPath, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) {
      throw Error('Checkbox line out of range.');
    }
    const line = lines[lineIndex];
    const match = line.match(/^(\s*[-*+]\s+\[)([ xX])(\]\s.*)$/);
    if (!match) throw Error('Selected line is not a Markdown checkbox.');
    const nextMark = match[2].toLowerCase() === 'x' ? ' ' : 'x';
    lines[lineIndex] = match[1] + nextMark + match[3];
    const updated = lines.join(eol);
    atomicWrite(fullPath, updated);
    return this.read(slug);
  }

  remove(rawSlug) {
    const {dirPath} = this.safeSkillPath(rawSlug);
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, {recursive: true, force: true});
    }
  }

  exportToDir(rawSlug, targetSkillsRoot) {
    if (typeof targetSkillsRoot !== 'string' || !targetSkillsRoot.trim()) {
      throw Error('Select a target directory for exporting the skill.');
    }
    const skill = this.read(rawSlug);
    const resolvedBase = path.resolve(targetSkillsRoot);
    const targetDir = path.resolve(resolvedBase, skill.slug);
    if (targetDir === resolvedBase || !targetDir.startsWith(resolvedBase + path.sep)) {
      throw Error('Invalid export target path.');
    }
    const exportedPath = path.join(targetDir, 'SKILL.md');
    atomicWrite(exportedPath, skill.content);
    return {slug: skill.slug, exportedPath, targetDir};
  }
}

module.exports = {SkillStore, normalizeSlug, parseSkillMarkdown, buildSkillMarkdown};
