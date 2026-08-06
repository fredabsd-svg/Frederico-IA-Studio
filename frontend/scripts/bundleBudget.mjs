// Catraca de desempenho do bundle — DOIS tetos, porque são duas perguntas
// diferentes e um número só não responde as duas.
//
// Histórico: até 2026-08-06 o CI somava TODO o JS de `dist/assets` contra um
// teto único de 1000 KB. Isso fazia sentido quando o app era um chunk só, mas
// passou a punir exatamente o trabalho que o próprio comentário do job dizia
// estar esperando: cada `React.lazy` novo tira bytes da primeira pintura e
// ACRESCENTA alguns KB ao total (cada chunk carrega seu próprio invólucro).
// O PR da Frente 10 é o caso exemplar — o chunk de entrada caiu de 900 para
// 888 KB (melhora real para o usuário) e o CI reprovou, porque a soma subiu.
//
// Agora medimos:
//
//   1. ENTRADA — o script de entrada mais tudo que o HTML manda pré-carregar
//      (`modulepreload`). É o que o navegador baixa ANTES da primeira pintura,
//      ou seja, o número que o usuário sente. Code splitting DEVE baixá-lo.
//   2. TOTAL — todo o JS emitido. Não deve encolher com splitting; serve para
//      pegar dependência nova pesada entrando de carona. Por isso o teto é
//      folgado: ele não é uma meta, é um alarme.
//
// Ao reduzir de verdade, baixe o teto junto — é o que faz a catraca andar.
import fs from 'node:fs';
import path from 'node:path';

// Tetos em KB. Medidos em 2026-08-06: entrada 900 KB, total 1000 KB.
export const TETO_ENTRADA_KB = 920;
export const TETO_TOTAL_KB = 1100;

// O HTML gerado é a fonte da verdade sobre o que entra na primeira pintura:
// o `<script type="module" src=...>` é a entrada, e cada `modulepreload` é um
// chunk que o navegador busca junto. Ler daqui (em vez de adivinhar pelo nome
// do arquivo) mantém o cálculo certo se o bundler mudar o padrão de nomes.
export function initialChunksFromHtml(html) {
  const arquivos = new Set();
  for (const m of html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+\.js)"/g)) arquivos.add(m[1]);
  for (const m of html.matchAll(/rel="modulepreload"[^>]+href="([^"]+\.js)"/g)) arquivos.add(m[1]);
  return [...arquivos];
}

const kb = (bytes) => Math.round(bytes / 1024);

export function medir(distDir) {
  const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const iniciais = initialChunksFromHtml(html);
  if (!iniciais.length) {
    throw new Error('nenhum script de entrada encontrado em dist/index.html — o build mudou de formato?');
  }
  const entradaBytes = iniciais.reduce((soma, href) => {
    // O href é absoluto na raiz do site (`/assets/x.js`); resolvemos contra dist.
    const arquivo = path.join(distDir, href.replace(/^\//, ''));
    return soma + fs.statSync(arquivo).size;
  }, 0);

  const assetsDir = path.join(distDir, 'assets');
  const totalBytes = fs.readdirSync(assetsDir)
    .filter(f => f.endsWith('.js'))
    .reduce((soma, f) => soma + fs.statSync(path.join(assetsDir, f)).size, 0);

  return { entradaKB: kb(entradaBytes), totalKB: kb(totalBytes), iniciais };
}

// Executado direto (`node scripts/bundleBudget.mjs`) faz o papel de portão.
if (import.meta.url === `file://${process.argv[1]}`) {
  const distDir = path.resolve(process.argv[2] || 'dist');
  let medida;
  try {
    medida = medir(distDir);
  } catch (erro) {
    console.error(`[bundle] não foi possível medir: ${erro.message}`);
    console.error('[bundle] rode `npm run build` antes.');
    process.exit(1);
  }

  const { entradaKB, totalKB, iniciais } = medida;
  console.log(`[bundle] entrada (primeira pintura): ${entradaKB} KB — teto ${TETO_ENTRADA_KB} KB`);
  console.log(`[bundle]   ${iniciais.length} arquivo(s): ${iniciais.join(', ')}`);
  console.log(`[bundle] total emitido: ${totalKB} KB — teto ${TETO_TOTAL_KB} KB`);

  const falhas = [];
  if (entradaKB > TETO_ENTRADA_KB) {
    falhas.push(`a primeira pintura passou do orçamento (${entradaKB} KB > ${TETO_ENTRADA_KB} KB). ` +
      'Mova um painel pesado para React.lazy ou reveja a dependência nova.');
  }
  if (totalKB > TETO_TOTAL_KB) {
    falhas.push(`o total de JS passou do orçamento (${totalKB} KB > ${TETO_TOTAL_KB} KB). ` +
      'Code splitting NÃO reduz este número — provavelmente entrou dependência nova.');
  }
  if (falhas.length) {
    for (const f of falhas) console.error(`::error::${f}`);
    process.exit(1);
  }
  console.log('[bundle] dentro do orçamento.');
}
