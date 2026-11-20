const fs = require('node:fs');
const path = require('node:path');

const PENDING_FILE = '.pending-popout.json';
const MAX_AGE_MS = 60000;

function normalizeDir(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  const resolved = path.resolve(p.trim());
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function consumePendingPopOut(storageRoot, workspaceFolders, now = Date.now()) {
  const filePath = path.join(storageRoot, PENDING_FILE);
  if (!fs.existsSync(filePath)) return false;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    fs.rmSync(filePath, {force: true});
    return false;
  }
  const age = now - Number(data.createdAt || 0);
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) {
    fs.rmSync(filePath, {force: true});
    return false;
  }
  const target = normalizeDir(data.folder);
  const openDirs = (workspaceFolders || []).map(normalizeDir);
  if (!target || !openDirs.includes(target)) return false;

  fs.rmSync(filePath, {force: true});
  return true;
}

module.exports = {PENDING_FILE, consumePendingPopOut, normalizeDir};
