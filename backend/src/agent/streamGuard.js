// Watchdog de streaming: detecta um provedor que PAROU de enviar dados sem
// fechar a conexão (proxy que engoliu a resposta, upstream congelado, rede
// móvel que trocou de antena...). Sem isto, o `for await` do stream fica
// pendurado PARA SEMPRE — o app mostra "Raciocinando..." eterno e nunca
// entrega a resposta, porque nenhum erro é lançado e a máquina de recuperação
// (retry + modelo de reserva + aviso honesto) nunca é acionada.
//
// Módulo propositalmente SEM dependências (não importa `openai`) para ser
// testável em qualquer ambiente.

// Tempo máximo SEM RECEBER NENHUM chunk antes de considerar o stream morto.
// Generoso de propósito: modelos de raciocínio podem ficar minutos "pensando"
// sem emitir texto (os que streamam o raciocínio emitem deltas contínuos e
// nunca chegam perto deste limite). Configurável por env.
export const STREAM_STALL_TIMEOUT_MS = Math.max(30000, Number(process.env.STREAM_STALL_TIMEOUT_MS) || 180000);

// Tempo máximo até o provedor COMEÇAR a responder (headers da resposta).
// O padrão do SDK é 10 minutos — longo demais para o usuário esperar por um
// provedor que não vai responder. Passado como `timeout` nas chamadas de
// streaming; o erro resultante é retryável e aciona o fallback de modelo.
export const PROVIDER_CONNECT_TIMEOUT_MS = Math.max(30000, Number(process.env.PROVIDER_CONNECT_TIMEOUT_MS) || 180000);

export class StreamStalledError extends Error {
  constructor(timeoutMs) {
    super(`O provedor parou de enviar dados por ${Math.round(timeoutMs / 1000)}s (stream stalled).`);
    this.name = 'StreamStalledError';
    this.code = 'STREAM_STALLED';
  }
}

// Envolve um stream (async iterable) e repassa os chunks; se NENHUM chunk
// chegar dentro de `timeoutMs`, chama `onStall()` (para abortar a requisição
// subjacente) e lança StreamStalledError — que é retryável, então o chamador
// cai na recuperação normal (retomar de onde parou / modelo de reserva).
// O timer só corre ENQUANTO se espera o próximo chunk: pausas do usuário e o
// processamento do chunk no corpo do loop não contam.
export async function* guardStreamStall(stream, { timeoutMs = STREAM_STALL_TIMEOUT_MS, onStall } = {}) {
  const it = stream[Symbol.asyncIterator]();
  let pending = null;
  try {
    while (true) {
      if (!pending) pending = it.next();
      let timer;
      let result;
      try {
        result = await Promise.race([
          pending,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new StreamStalledError(timeoutMs)), timeoutMs); })
        ]);
      } catch (err) {
        if (err instanceof StreamStalledError) {
          // A promise pendente vai rejeitar quando a requisição for abortada;
          // sem este catch ela viraria uma "unhandled rejection".
          pending.catch(() => {});
          pending = null;
          try { onStall?.(); } catch {}
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
      pending = null;
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // Consumidor saiu no meio (break/stop/erro): fecha o stream subjacente
    // para não vazar a conexão. Sem await — um upstream morto não pode nos
    // prender aqui.
    if (pending) pending.catch(() => {});
    try {
      const ret = it.return?.();
      if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch {}
  }
}
