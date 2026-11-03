import { parseDocument } from 'htmlparser2';

const skip = new Set(['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'svg', 'template']);
const block = new Set(['p', 'div', 'section', 'article', 'main', 'h1', 'h2', 'h3', 'h4', 'li', 'br', 'tr', 'blockquote']);
function hidden(node) {
  const a = node.attribs || {};
  return skip.has(node.name) || a.hidden != null || a['aria-hidden'] === 'true' || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style || '');
}
function nodeText(node) {
  if (node.type === 'text') return node.data || '';
  if (hidden(node)) return '';
  const text = (node.children || []).map(nodeText).join('');
  return block.has(node.name) ? '\n' + text + '\n' : text;
}
const clean = text => text.replace(/[\t\r ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
export function extractPageContent(body, maxChars = 5000) {
  if (!/<[a-z][\s\S]*>/i.test(body)) return { title: '', content: body.slice(0, maxChars), truncated: body.length > maxChars };
  const doc = parseDocument(body), candidates = []; let title = '';
  function walk(node) {
    if (node.name === 'title') { title = clean(nodeText(node)).slice(0, 200); return; }
    if (hidden(node)) return;
    const a = node.attribs || {}, marker = `${a.id || ''} ${a.class || ''}`;
    if (['article', 'main'].includes(node.name) || a.role === 'main' || /article[-_ ]?(body|content)|TRS_Editor|zoom|正文|content[-_]?(body|article)|rich_media_content/i.test(marker)) {
      const text = clean(nodeText(node)); if (text.length >= 40) candidates.push(text);
    }
    (node.children || []).forEach(walk);
  }
  walk(doc);
  const text = candidates.sort((a, b) => b.length - a.length)[0] || clean(nodeText(doc));
  return { title, content: text.slice(0, maxChars), truncated: text.length > maxChars };
}
