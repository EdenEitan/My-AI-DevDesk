'use strict';

(function (globalScope) {
  function splitTableRow(line) {
    let trimmed = line.trim();
    if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
    if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
    return trimmed.split('|').map(cell => cell.trim());
  }

  function isTableSeparator(line) {
    if (!line || !line.includes('|')) return false;
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every(c => /^:?-{3,}:?$/.test(c));
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {splitTableRow, isTableSeparator};
  }
  if (typeof window === 'undefined' || !globalScope.DevDesk) return;

  const {node} = globalScope.DevDesk;

  function appendInlineMarkdown(parent, text) {
    const tokenRe = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g;
    let last = 0;
    let m;
    while ((m = tokenRe.exec(text)) !== null) {
      if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
      const tok = m[0];
      if (tok.startsWith('`') && tok.endsWith('`')) {
        parent.append(node('code', tok.slice(1, -1)));
      } else if (tok.startsWith('**') && tok.endsWith('**')) {
        const strong = document.createElement('strong');
        appendInlineMarkdown(strong, tok.slice(2, -2));
        parent.append(strong);
      } else if (tok.startsWith('*') && tok.endsWith('*')) {
        const em = document.createElement('em');
        appendInlineMarkdown(em, tok.slice(1, -1));
        parent.append(em);
      }
      last = m.index + tok.length;
    }
    if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
  }

  function renderMarkdown(container, text, onToggleCheckbox) {
    container.replaceChildren();
    const lines = (text || '').split(/\r?\n/);
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      // Fenced code block
      const fenceMatch = line.match(/^(`{3,}|~{3,})(.*)$/);
      if (fenceMatch) {
        const fence = fenceMatch[1];
        const codeLines = [];
        i++;
        while (i < lines.length && !lines[i].startsWith(fence)) {
          codeLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++;
        const pre = document.createElement('pre');
        pre.dir = 'ltr';
        pre.append(node('code', codeLines.join('\n')));
        container.append(pre);
        continue;
      }

      // Heading
      const headMatch = line.match(/^(#{1,4})\s+(.+)$/);
      if (headMatch) {
        const h = document.createElement('h' + headMatch[1].length);
        h.dir = 'auto';
        appendInlineMarkdown(h, headMatch[2].trim());
        container.append(h);
        i++;
        continue;
      }

      // Horizontal rule
      if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
        container.append(document.createElement('hr'));
        i++;
        continue;
      }

      // Markdown table
      if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const headers = splitTableRow(line);
        i += 2;
        const bodyRows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          bodyRows.push(splitTableRow(lines[i]));
          i++;
        }
        const wrap = node('div', '', 'mdTableWrap');
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const htr = document.createElement('tr');
        for (const h of headers) {
          const th = document.createElement('th');
          appendInlineMarkdown(th, h);
          htr.append(th);
        }
        thead.append(htr);
        table.append(thead);

        const tbody = document.createElement('tbody');
        for (const row of bodyRows) {
          const tr = document.createElement('tr');
          for (let c = 0; c < headers.length; c++) {
            const td = document.createElement('td');
            appendInlineMarkdown(td, row[c] || '');
            tr.append(td);
          }
          tbody.append(tr);
        }
        table.append(tbody);
        wrap.append(table);
        container.append(wrap);
        continue;
      }

      // Blockquote
      if (/^\s*>\s?/.test(line)) {
        const bq = document.createElement('blockquote');
        const quoteLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        const p = document.createElement('p');
        p.dir = 'auto';
        appendInlineMarkdown(p, quoteLines.join(' '));
        bq.append(p);
        container.append(bq);
        continue;
      }

      // Task list (- [ ] / - [x])
      if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) {
        const ul = node('ul', '', 'mdTaskList');
        while (i < lines.length && /^\s*[-*+]\s+\[[ xX]\]\s+/.test(lines[i])) {
          const lineIdx = i;
          const m = lines[i].match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
          const checked = m[1].toLowerCase() === 'x';
          const li = node('li', '', 'mdTaskItem' + (checked ? ' checked' : ''));
          const lbl = document.createElement('label');
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = checked;
          cb.onchange = () => onToggleCheckbox(lineIdx);
          const span = document.createElement('span');
          span.dir = 'auto';
          appendInlineMarkdown(span, m[2]);
          lbl.append(cb, span);
          li.append(lbl);
          ul.append(li);
          i++;
        }
        container.append(ul);
        continue;
      }

      // Unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        const ul = document.createElement('ul');
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]) && !/^\s*[-*+]\s+\[[ xX]\]\s+/.test(lines[i])) {
          const li = document.createElement('li');
          li.dir = 'auto';
          appendInlineMarkdown(li, lines[i].replace(/^\s*[-*+]\s+/, ''));
          ul.append(li);
          i++;
        }
        container.append(ul);
        continue;
      }

      // Ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        const ol = document.createElement('ol');
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          const li = document.createElement('li');
          li.dir = 'auto';
          appendInlineMarkdown(li, lines[i].replace(/^\s*\d+\.\s+/, ''));
          ol.append(li);
          i++;
        }
        container.append(ol);
        continue;
      }

      // Paragraph
      const paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,4}\s|`{3,}|~{3,}|\s*[-*+]\s|\s*\d+\.\s|\s*>\s?|\s*(?:---+|\*\*\*+|___+)\s*$)/.test(lines[i]) &&
        !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      const p = document.createElement('p');
      p.dir = 'auto';
      appendInlineMarkdown(p, paraLines.join(' '));
      container.append(p);
    }
  }

  globalScope.DevDesk.renderMarkdown = renderMarkdown;
})(typeof window !== 'undefined' ? window : globalThis);
