// Configuração da camada Docling. Tudo é lido de variáveis de ambiente para que
// a integração possa ser ativada por instalação sem tocar no código, e fica
// DESLIGADA por padrão (rollout seguro, sem regressão — o fluxo atual continua
// intacto enquanto DOCLING_ENABLED != 'true').
import crypto from 'node:crypto';

// Liga/desliga a camada inteira. Default: desligado.
export function isDoclingEnabled() {
  return String(process.env.DOCLING_ENABLED || '').toLowerCase() === 'true';
}

// Opções de processamento resolvidas do ambiente (com padrões sensatos p/ pt-BR).
export function doclingOptions() {
  return {
    ocr: String(process.env.DOCLING_OCR || 'auto').toLowerCase(),        // auto|always|never
    lang: process.env.DOCLING_OCR_LANG || 'por',                          // idioma do OCR
    tables: process.env.DOCLING_TABLES !== 'false',                       // extração de tabelas
    formulas: process.env.DOCLING_FORMULAS === 'true',                    // fórmulas (mais caro)
    maxPages: Math.max(0, Number(process.env.DOCLING_MAX_PAGES || 0)),    // 0 = sem limite
    maxChunkTokens: Math.max(200, Number(process.env.DOCLING_MAX_CHUNK_TOKENS || 1200)),
    timeoutMs: Math.max(30_000, Number(process.env.DOCLING_TIMEOUT_MS || 240_000)),
    doclingVersion: process.env.DOCLING_VERSION || 'docling',            // fixado no build da imagem
  };
}

// Tipos aceitos pelo Docling (os demais seguem o caminho atual do app).
const SUPPORTED_EXT = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'html', 'htm', 'md', 'csv', 'png', 'jpg', 'jpeg', 'tiff', 'tif', 'bmp', 'webp']);
export function isDoclingSupported(nameOrExt = '') {
  const ext = String(nameOrExt).split('.').pop().toLowerCase();
  return SUPPORTED_EXT.has(ext);
}

// Versão do formato/pipeline interno. QUALQUER mudança que altere o resultado do
// processamento (opções de OCR, idioma, tabelas, versão do Docling, versão do
// nosso chunker/markdown) precisa entrar aqui para invalidar o cache antigo.
export const INTERNAL_FORMAT_VERSION = 'v1';

// Chave de cache: mesma entrada + mesma config => mesmo resultado. Se qualquer
// item relevante mudar, a chave muda e o documento é reprocessado.
export function configVersion(opts = doclingOptions()) {
  const material = JSON.stringify({
    fmt: INTERNAL_FORMAT_VERSION,
    docling: opts.doclingVersion,
    ocr: opts.ocr,
    lang: opts.lang,
    tables: opts.tables,
    formulas: opts.formulas,
    maxPages: opts.maxPages,
    maxChunkTokens: opts.maxChunkTokens,
  });
  return crypto.createHash('sha1').update(material).digest('hex').slice(0, 16);
}
