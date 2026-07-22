function parseCsvRows(value) {
  const source = String(value || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"' && cell === '') { quoted = true; continue; }
    if (char === ',') { row.push(cell); cell = ''; continue; }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some(item => item.trim())) rows.push(row);
      row = []; cell = '';
      continue;
    }
    cell += char;
  }
  row.push(cell);
  if (row.some(item => item.trim())) rows.push(row);
  return rows;
}

export function isAlibabaOpenAIBaseURL(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { return false; }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, '');
  const officialHost = /^dashscope(?:-[a-z0-9-]+)?\.aliyuncs\.com$/.test(host)
    || host.endsWith('.dashscope.aliyuncs.com')
    || host.endsWith('.maas.aliyuncs.com');
  const cleanURL = !url.username && !url.password && !url.search && !url.hash;
  return url.protocol === 'https:' && cleanURL && officialHost && (path === '/compatible-mode/v1' || path === '/v1');
}

export function parseAlibabaCredentialCsv(value) {
  const fields = new Map();
  for (const row of parseCsvRows(value)) {
    const key = String(row[0] || '').trim().toLowerCase();
    const fieldValue = String(row[1] || '').trim();
    if (key && fieldValue) fields.set(key, fieldValue);
  }

  const apiKey = fields.get('apikey') || '';
  const baseURL = fields.get('openaicompatible') || '';
  if (!apiKey.startsWith('sk-')) throw new Error('O CSV não contém uma API Key Alibaba válida.');
  if (!isAlibabaOpenAIBaseURL(baseURL)) {
    throw new Error('O CSV não contém o endpoint OpenAI compatível oficial do workspace.');
  }
  return { apiKey, baseURL };
}
