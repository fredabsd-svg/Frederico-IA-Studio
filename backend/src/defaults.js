// Defaults compartilhados entre rotas, seed e indexador.
//
// Até o PR que fecha a frente "modelRef completo no assistente" (F-1, ver
// CONTINUIDADE.md), o repositório tinha dois defaults incoerentes para o
// modelo padrão: 'deepseek/deepseek-chat' (formato OpenRouter) em
// `backend/src/seed.js` e `backend/src/routes/assistants.js`; e 'deepseek-chat'
// (formato nativo da API DeepSeek) em `routes/schedules.js`, `routes/inbox.js`,
// `routes/conversations.js`, `routes/helpers.js` e `memory/indexer.js`. Os dois
// caminhos resolviam para o MESMO provedor na maioria das instalações (porque o
// usuário só tinha uma chave), mas ficavam desalinhados quando havia mais de
// um provedor cadastrado — e quando o modelo não estava em catálogo nenhum,
// `getUserProvider` caía no `rows[0]` silenciosamente, a causa-raiz do 401 do
// PR #140.
//
// O `DEFAULT_MODEL_REF` abaixo é o id canônico de "modelo padrão" do app.
// Formato OpenRouter (`deepseek/deepseek-chat`) porque (a) é o que o seed já
// usava, (b) é o que os testes E2E do provedor falso fixam e (c) o
// `.env.example` recomenda essa base no comentário da `DEEPSEEK_MODEL`.
// Quem usa só a API nativa da DeepSeek sobrescreve via `DEEPSEEK_MODEL`.
//
// O `resolveDefaultModelRef()` devolve o valor final considerando o env — é o
// que seed/rotas devem chamar em vez de ler o env direto, para que a
// substituição seja uniforme.
export const DEFAULT_MODEL_REF = 'deepseek/deepseek-chat';

// Lê `DEEPSEEK_MODEL` do ambiente com fallback para o default canônico.
// Mantém a forma de modelRef (com prefixo de provedor) sempre que possível: o
// default canônico já vem com prefixo, e um valor customizado vindo do env que
// não tenha `::` é devolvido como está — quem chamou decide se completa o
// prefixo a partir dos provedores cadastrados.
export function resolveDefaultModelRef() {
  // Env sem prefixo `provider::` cai no id cru — preservamos o comportamento
  // anterior (o loop/seed gravam esse valor e o resolver tenta casar com o
  // catálogo do provedor do usuário). Só usamos o default canônico quando o
  // env está vazio.
  const envValue = String(process.env.DEEPSEEK_MODEL || '').trim();
  return envValue || DEFAULT_MODEL_REF;
}
