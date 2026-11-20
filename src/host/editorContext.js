function captureSelection(vscode, editor) {
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

function captureFile(editor) {
  if (!editor || editor.document.uri.scheme !== 'file') return '';
  return editor.document.uri.fsPath;
}

function formatSnippet(sel) {
  const lineInfo = sel.startLine === sel.endLine
    ? `line ${sel.startLine}`
    : `lines ${sel.startLine}-${sel.endLine}`;
  const fence = sel.text.includes('```') ? '````' : '```';
  return `File: \`${sel.fileName}\` (${lineInfo})\n${fence}${sel.languageId}\n${sel.text}\n${fence}`;
}

module.exports = {captureSelection, captureFile, formatSnippet};
