// Measure the exact compact JSON sent to the model, including its pagination cursor.
export function memoryPage(rows, { offset = 0, limit = 10, maxChars, key = 'memories', format = r => r, extras = () => ({}) }) {
  const selected = [], values = [];
  const encode = () => JSON.stringify({ [key]: values, ...extras(selected), nextOffset: offset + selected.length < rows.length ? offset + selected.length : null });
  for (const row of rows.slice(offset, offset + limit)) {
    selected.push(row); values.push(format(row));
    const candidate = encode();
    if (candidate.length <= maxChars) continue;
    selected.pop(); values.pop();
    if (selected.length) break;
    return { selected: [], result: { isError: true, content: JSON.stringify({ error: '单条记忆超过工具字符上限，未截断或跳过。请提高工具文字上限，或使用更简洁的查询模式。',
      blockedOffset: offset, requiredMaxChars: candidate.length, maxChars }) } };
  }
  return { selected, result: { content: encode() } };
}

export function memoryDetail(payload, maxChars) {
  const content = JSON.stringify(payload);
  return content.length <= maxChars ? { content } : { isError: true, content: JSON.stringify({
    error: '记忆详情超过工具字符上限，未截断。请关闭 includeHistory 或提高工具文字上限。', requiredMaxChars: content.length, maxChars }) };
}
