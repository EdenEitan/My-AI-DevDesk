const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

const UUID_RE = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

function atomicWrite(targetPath, data) {
  fs.mkdirSync(path.dirname(targetPath), {recursive: true});
  const tmp = targetPath + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, data, {flag: 'wx', encoding: 'utf8'});
    fs.renameSync(tmp, targetPath);
  } catch (e) {
    fs.rmSync(tmp, {force: true});
    throw e;
  }
}

module.exports = {UUID_RE, atomicWrite};
