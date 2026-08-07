// Detector de DOOM LOOP (Fase 46 do Developer Workspace 3.0).
//
// O padrão que ele pega: o modelo chama a MESMA ferramenta com os MESMOS
// argumentos repetidamente e recebe o MESMO resultado — o retry cego que
// queima etapas, tokens e a paciência do usuário sem nenhum progresso.
//
// Regras:
//  - a chave é (ferramenta + argumentos serializados);
//  - o contador só cresce quando o RESULTADO também se repete — argumentos
//    iguais com resultado novo são progresso legítimo (ex.: reler um arquivo
//    depois de editá-lo) e zeram a contagem;
//  - na N-ésima repetição idêntica (padrão 3), a chamada é BLOQUEADA antes do
//    executor, com um erro estruturado que instrui a mudar de estratégia.
//    O bloqueio conta como falha para o freio de falhas consecutivas do loop —
//    um modelo que insiste no mesmo comando acaba encerrando o run com o
//    motivo honesto, em vez de rodar em círculo.
//
// Ferramentas internas (ask_user, update_plan, delegação) ficam de fora: elas
// não executam nada e têm freios próprios.

export const DOOM_LOOP_THRESHOLD = Math.max(2, Number(process.env.DOOM_LOOP_THRESHOLD) || 3);

const RESULT_HASH_CHARS = 2000;

export function createDoomLoopDetector({ threshold = DOOM_LOOP_THRESHOLD } = {}) {
  const seen = new Map(); // chave → { repeats, lastResult }
  return {
    // Antes de executar: a repetição N (com N ≥ threshold) é bloqueada.
    shouldBlock(name, argsJson) {
      const key = `${name}\n${String(argsJson || '')}`;
      const entry = seen.get(key);
      const repeats = (entry?.repeats || 0) + 1;
      return {
        key,
        repeats,
        blocked: repeats >= threshold,
        threshold
      };
    },
    // Depois de executar: resultado idêntico ao anterior conta como repetição;
    // resultado novo é progresso e zera a contagem da chave.
    record(key, result) {
      const fingerprint = String(result || '').slice(0, RESULT_HASH_CHARS);
      const entry = seen.get(key);
      if (entry && entry.lastResult === fingerprint) {
        entry.repeats += 1;
      } else {
        seen.set(key, { repeats: 1, lastResult: fingerprint });
      }
    }
  };
}

// Erro estruturado devolvido ao modelo no bloqueio (o formato é o mesmo dos
// demais freios do loop — o modelo lê, entende e muda de abordagem).
export function doomLoopResult(name, repeats) {
  return JSON.stringify({
    error: `Você chamou "${name}" com os MESMOS argumentos ${repeats} vezes e recebeu o mesmo resultado — repetir de novo não vai mudar nada. MUDE DE ESTRATÉGIA: leia a mensagem de erro com atenção, inspecione o estado real (arquivos, logs, ambiente), tente um caminho alternativo, ou explique ao usuário o que está travando e pergunte como proceder (ask_user).`,
    code: 'DOOM_LOOP',
    tool: name,
    repeats
  });
}
