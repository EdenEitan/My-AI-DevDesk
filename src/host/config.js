const path = require('node:path');
const os = require('node:os');

function resolveStorageDir(vscode) {
  const configured = (vscode.workspace.getConfiguration('edenHub').get('storagePath') || '').trim();
  if (configured) {
    const expanded = configured.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.join(os.homedir(), '.edens-prompt-hub');
}

function getFontScale(vscode) {
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

module.exports = {resolveStorageDir, getFontScale, legacyStorageDirs};
