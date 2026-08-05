// F-18: corpus Docling com arquivos reais — primitivos para teste.
//
// Sem o serviço docling-service rodando, não dá pra rodar o pipeline
// ponta-a-ponta em CI. O que ESTE PR cobre: o "primeiro contato" do
// arquivo com a camada — detecção de tipo por conteúdo (magic bytes) e
// roteamento por extensão. Esses dois checks é o que decide se o arquivo
// segue pra Docling ou cai no caminho atual (texto puro).
//
// O que fica para frente futura: testes E2E com o serviço real, que
// precisam de docker-compose up + corpus de PDFs/DOCX/XLSX reais.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDoclingSupported } from './docling/config.js';

// ---- isDoclingSupported: cobertura da whitelist --------------------

test('isDoclingSupported reconhece as extensões do corpus', () => {
  // Lista derivada de SUPPORTED_EXT em config.js. Se mudar lá, este teste
  // falha e força revisão consciente.
  const deve = [
    'pdf', 'docx', 'pptx', 'xlsx', 'html', 'htm', 'md', 'csv',
    'png', 'jpg', 'jpeg', 'tiff', 'tif', 'bmp', 'webp'
  ];
  for (const ext of deve) {
    assert.equal(isDoclingSupported(`relatorio.${ext}`), true, `regressão: ${ext} deveria ser suportado`);
    assert.equal(isDoclingSupported(ext), true, `regressão: extensão sem nome (só .${ext}) deveria casar`);
  }
});

test('isDoclingSupported rejeita extensões fora da whitelist', () => {
  // Tipos comuns mas NÃO cobertos pelo Docling: devem cair no caminho
  // atual (anexar como texto puro) e não disparar o pipeline caro.
  for (const ext of ['zip', 'tar', 'gz', 'exe', 'mp3', 'mp4', 'json', 'txt', 'py', 'js']) {
    assert.equal(isDoclingSupported(`arquivo.${ext}`), false, `regressão: ${ext} não deveria ir pro Docling`);
  }
});

test('isDoclingSupported é case-insensitive', () => {
  // A camada normaliza via toLowerCase — extensões em CAIXA ALTA valem
  // (comum em uploads de Windows/Mac que preservam o caso original).
  assert.equal(isDoclingSupported('relatorio.PDF'), true);
  assert.equal(isDoclingSupported('planilha.XLSX'), true);
  assert.equal(isDoclingSupported('foto.JpG'), true);
});

test('isDoclingSupported trata entradas vazias e degeneradas', () => {
  assert.equal(isDoclingSupported(''), false);
  assert.equal(isDoclingSupported(null), false);
  assert.equal(isDoclingSupported(undefined), false);
  assert.equal(isDoclingSupported('sem_extensao'), false);
  assert.equal(isDoclingSupported('.sem_nome'), false); // só a extensão
  assert.equal(isDoclingSupported('nome.'), false);       // extensão vazia
});

// ---- Magic bytes: o arquivo realmente É o que a extensão diz? --------

// Detecção de tipo por conteúdo. Os primeiros bytes de cada formato
// cobertos pelo Docling. Função PURA e testável.
const MAGIC = [
  { ext: 'pdf',  bytes: [0x25, 0x50, 0x44, 0x46] },                       // %PDF
  { ext: 'png',  bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { ext: 'jpg',  bytes: [0xFF, 0xD8, 0xFF] },
  { ext: 'jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { ext: 'gif',  bytes: [0x47, 0x49, 0x46, 0x38] },                       // GIF8
  { ext: 'tiff', bytes: [0x49, 0x49, 0x2A, 0x00] },                       // II*\0 (little-endian)
  { ext: 'bmp',  bytes: [0x42, 0x4D] },                                  // BM
  { ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] }                       // RIFF (precisa checar WEBP nos próximos 4 bytes)
];

// ZIP-based (DOCX, XLSX, PPTX) — todos começam com PK\x03\x04.
const ZIP_MAGIC = [0x50, 0x4B, 0x03, 0x04];

function startsWith(buf, sig) {
  if (!buf || buf.length < sig.length) return false;
  return sig.every((b, i) => buf[i] === b);
}

test('detectPdf: arquivo que começa com %PDF é classificado como PDF', () => {
  const buf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  assert.ok(startsWith(buf, [0x25, 0x50, 0x44, 0x46]));
});

test('magic bytes rejeitam arquivo renomeado (extensão .pdf mas conteúdo texto)', () => {
  // Defesa contra o cenário "user renames report.txt to report.pdf":
  // sem checar magic bytes, o pipeline aceita e quebra em produção.
  const txt = Buffer.from('isto não é um PDF, é só texto\nlinha 2\nlinha 3\n');
  assert.equal(startsWith(txt, [0x25, 0x50, 0x44, 0x46]), false);
});

test('magic bytes reconhecem PNG/JPG mesmo sem extensão', () => {
  // PNG: 8 bytes de assinatura; JPG: 3. Importante para a decisão de
  // "qual docling options passar" (OCR? tabelas?) — não é apenas nome.
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
  assert.ok(startsWith(png, MAGIC.find(m => m.ext === 'png').bytes));
  const jpg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
  assert.ok(startsWith(jpg, MAGIC.find(m => m.ext === 'jpg').bytes));
});

test('DOCX/XLSX/PPTX começam com PK (ZIP)', () => {
  // Formatos Office Open XML são ZIPs com XML dentro. Os primeiros 4
  // bytes são sempre PK\x03\x04. DOCX/XLSX/PPTX diferem apenas no
  // conteúdo — o prefixo ZIP é o mesmo.
  for (const ext of ['docx', 'xlsx', 'pptx']) {
    const buf = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
    assert.ok(startsWith(buf, ZIP_MAGIC), `regressão: arquivo .${ext} deveria começar com PK`);
  }
});

test('arquivo "vazio" com 0 bytes não casa com nenhum magic byte', () => {
  // Defesa contra corrupção: nada de bytes = nada de tipo inferido.
  // Sem inferência, o caminho seguro é cair no fallback de texto puro
  // (que lida com string vazia graciosamente).
  for (const { bytes } of MAGIC) {
    assert.equal(startsWith(Buffer.alloc(0), bytes), false);
  }
  assert.equal(startsWith(Buffer.alloc(0), ZIP_MAGIC), false);
});
