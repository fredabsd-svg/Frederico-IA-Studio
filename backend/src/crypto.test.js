// Testes do crypto.js — o módulo que guarda os segredos por usuário (BYOK):
// as chaves de API e o token do GitHub ficam cifrados com AES-256-GCM. Como é
// pequeno, puro e crítico de segurança, o round-trip e a REJEIÇÃO de dados
// adulterados (GCM é autenticado) merecem cobertura explícita.
import assert from 'node:assert/strict';
import test from 'node:test';

// Chave de teste fixa (32 bytes em hex). Definida antes de importar o módulo,
// que valida a ENCRYPTION_KEY no momento do uso.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { encryptSecret, decryptSecret, maskSecret, chooseKeyHex, isValidKeyHex } = await import('./crypto.js');

// ---- Resolução da chave mestra (env > arquivo > gerar) ----

test('isValidKeyHex aceita só 64 caracteres hex', () => {
  assert.equal(isValidKeyHex('a'.repeat(64)), true);
  assert.equal(isValidKeyHex('A'.repeat(64)), true);
  assert.equal(isValidKeyHex('a'.repeat(63)), false);
  assert.equal(isValidKeyHex('g'.repeat(64)), false); // 'g' não é hex
  assert.equal(isValidKeyHex(''), false);
  assert.equal(isValidKeyHex(null), false);
});

test('chooseKeyHex: env tem prioridade sobre o arquivo', () => {
  const env = 'a'.repeat(64), file = 'b'.repeat(64);
  const r = chooseKeyHex(env, file);
  assert.equal(r.source, 'env');
  assert.equal(r.hex, env);
});

test('chooseKeyHex: sem env, usa o arquivo', () => {
  const file = 'c'.repeat(64);
  const r = chooseKeyHex('', file);
  assert.equal(r.source, 'file');
  assert.equal(r.hex, file);
});

test('chooseKeyHex: sem env e sem arquivo, sinaliza gerar', () => {
  const r = chooseKeyHex('', '');
  assert.equal(r.source, 'generate');
  assert.equal(r.hex, null);
});

test('chooseKeyHex: env inválida lança (erro de configuração)', () => {
  assert.throws(() => chooseKeyHex('xyz', ''), /ENCRYPTION_KEY inválida/);
});

test('chooseKeyHex: arquivo corrompido lança (não gera silenciosamente)', () => {
  // Sem env, arquivo presente mas inválido → erro (jamais sobrescrever/gerar,
  // o que trocaria a chave e tornaria os segredos ilegíveis).
  assert.throws(() => chooseKeyHex('', 'corrompido'), /encryption\.key.*corrompido|corrompido/i);
});

test('encrypt→decrypt devolve o texto original (round-trip)', () => {
  const segredo = 'sk-minha-chave-secreta-123';
  const cifrado = encryptSecret(segredo);
  assert.notEqual(cifrado, segredo, 'não pode guardar em texto claro');
  assert.match(cifrado, /^[^:]+:[^:]+:[^:]+$/, 'formato iv:tag:cifra');
  assert.equal(decryptSecret(cifrado), segredo);
});

test('cada cifragem usa IV novo (dois cifrados diferentes p/ o mesmo texto)', () => {
  const a = encryptSecret('mesmo-valor');
  const b = encryptSecret('mesmo-valor');
  assert.notEqual(a, b, 'IV aleatório deve variar o resultado');
  assert.equal(decryptSecret(a), decryptSecret(b));
});

test('entrada vazia/nula vira null (não cifra o que não existe)', () => {
  assert.equal(encryptSecret(''), null);
  assert.equal(encryptSecret(null), null);
  assert.equal(encryptSecret(undefined), null);
});

test('decrypt de dado ADULTERADO é rejeitado (GCM autenticado → null)', () => {
  const cifrado = encryptSecret('valor-integro');
  const [iv, tag, data] = cifrado.split(':');
  // Corrompe o último caractere da cifra (base64) — a tag GCM deve falhar.
  const dataCorrompida = data.slice(0, -2) + (data.slice(-2) === 'AA' ? 'BB' : 'AA');
  assert.equal(decryptSecret(`${iv}:${tag}:${dataCorrompida}`), null);
  // Tag trocada também deve falhar.
  const tagCorrompida = tag.slice(0, -2) + (tag.slice(-2) === 'AA' ? 'BB' : 'AA');
  assert.equal(decryptSecret(`${iv}:${tagCorrompida}:${data}`), null);
});

test('decrypt de formato inválido/vazio devolve null sem lançar', () => {
  assert.equal(decryptSecret(''), null);
  assert.equal(decryptSecret(null), null);
  assert.equal(decryptSecret('sem-dois-pontos'), null);
  assert.equal(decryptSecret('so:duas'), null);
  assert.equal(decryptSecret('a:b:c:d'), null);
  assert.equal(decryptSecret('lixo:aleatorio:aqui'), null);
});

test('maskSecret nunca revela a chave inteira', () => {
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('curta'), '••••');
  const m = maskSecret('sk-1234567890abcdef');
  assert.equal(m, 'sk-1••••cdef');
  assert.ok(!m.includes('234567890ab'), 'o miolo da chave não pode aparecer');
});
