# Relatório real de testes — modelos, prompts e artefatos

Data: 22/07/2026
Base limpa auditada: `main` em `e399370`
Escopo: mono-modelo, Multimodelo, Modo Equipe, failover, modelos gratuitos/visuais, system prompts e Excel.

## Resultado executivo

O teste anterior era insuficiente: validava funções isoladas, mas não cobria a troca de família no failover, o contrato real enviado ao provedor nem um pedido comum de arquivo no pipeline multimodelo. A nova revisão reproduziu e corrigiu nove falhas de arquitetura:

1. o failover mudava o ID do modelo sem recalcular ferramentas, visão, raciocínio ou parâmetros aceitos;
2. marcadores `cache_control` de Claude/Gemini podiam seguir para uma família incompatível;
3. o pipeline multimodelo só executava ferramentas quando o Modo Desenvolvedor estava ativo;
4. o prompt do executor dizia ao mesmo tempo que ele tinha e que não tinha ferramentas;
5. especialistas e coordenadores do Modo Equipe/Multimodelo não recebiam o mesmo núcleo neutro do mono-modelo;
6. quando o catálogo gratuito falhava, o fallback inventava `tools: true` e escondia a incerteza;
7. GPT-5.6 podia receber ferramentas no Chat Completions com raciocínio efetivo diferente de `none`, combinação incompatível com esse endpoint;
8. uma etapa revisora que preservasse um Excel válido sem modificá-lo podia ser acusada de não ter produzido arquivo;
9. orçamento ou cancelamento podia mudar a última etapa efetivamente executada sem persistir sua resposta e seus cartões de arquivo.

Todos esses pontos foram corrigidos no backend, com testes de regressão. Não são correções dependentes de uma marca específica: o contrato é recalculado para cada modelo ativo.

## Hierarquia de prompt verificada

1. núcleo imutável do aplicativo;
2. perfil/papel delimitado como configuração de prioridade inferior;
3. contrato de qualidade e conclusão;
4. capacidades realmente autorizadas pelo backend;
5. memória, regras livres, repositório e respostas de outros modelos como contexto não confiável;
6. pedido atual do usuário;
7. resultados de ferramentas.

O núcleo proíbe presumir profissão, setor, ideologia, religião, saúde, identidade, localização, preferências ou intenção. Perfis personalizados continuam podendo definir especialidade e tom, mas não ampliam permissões nem substituem o núcleo. Tentativas de fechar os delimitadores de perfil/contexto são escapadas.

## Matriz mono-modelo

A suíte cobre perfis representativos de:

- OpenAI;
- Anthropic;
- Google/Gemini;
- DeepSeek;
- Qwen;
- GLM/Z.AI;
- Mistral;
- Meta;
- xAI;
- NVIDIA gratuito textual;
- NVIDIA gratuito visual;
- modelo conhecido sem ferramentas;
- modelo de geração de imagem sem ferramentas de função.

Para cada perfil foram verificadas separadamente: conversa textual, pedido de Excel, ferramentas, visão de entrada, geração de imagem, raciocínio, `temperature` e montagem final da requisição ao provedor. Um modelo textual sem ferramentas continua conversando, mas um pedido de arquivo é bloqueado antes de uma falsa promessa de entrega.

## Matriz multimodelo

- configurações com 2, 3 e 5 modelos;
- compare, conselho, debate e pipeline;
- pipeline textual sem execução;
- pipeline de Excel fora do Modo Desenvolvedor;
- seleção de membro conhecido sem ferramentas;
- papéis principal, implementador e revisor;
- contexto de outro modelo delimitado como não confiável;
- prompt personalizado tentando substituir o núcleo;
- preservação da ordem dos participantes;
- persistência da última etapa realmente executada quando orçamento/cancelamento altera a fila.

Pedidos que precisam de arquivo, pesquisa ou ferramenta e chegam em compare/conselho/debate não são mais apresentados como concluídos: o app orienta a selecionar Pipeline. No Pipeline, todas as etapas elegíveis trabalham no mesmo workspace e recebem uma instrução sem contradição para abrir, preservar, corrigir e validar o artefato real.

## Excel real

Os testes Python criam um `.xlsx` de verdade com o kit `xlspro`, fecham o arquivo e o reabrem com `openpyxl`. São verificados:

- pacote XLSX íntegro (ZIP/OOXML);
- fórmulas preservadas;
- formato monetário;
- cabeçalho congelado;
- grade oculta;
- gráfico incorporado;
- linha de total;
- erro claro para contrato inválido de gráfico;
- tolerância a linha com mais campos que o cabeçalho;
- cinco etapas sucessivas reabrindo, modificando e salvando o mesmo artefato sem perder fórmulas nem gráfico.

Resultado local: 4/4 aprovados.

## Catálogo público atual

Consulta executada sem chave em `https://openrouter.ai/api/v1/models` em 22/07/2026:

- 342 modelos catalogados;
- 17 gratuitos;
- 14 gratuitos com ferramentas confirmadas;
- 8 gratuitos com visão;
- 5 gratuitos com ferramentas e visão simultaneamente.

Modelos gratuitos configurados pelo aplicativo:

| Modelo | Presente | Ferramentas | Visão | Contexto |
|---|---:|---:|---:|---:|
| `nvidia/nemotron-3-ultra-550b-a55b:free` | sim | sim | não | 1.000.000 |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | sim | sim | sim | 256.000 |

O segundo é a preferência adequada quando a entrada inclui imagem/documento visual. Modelos que geram imagem são classificados separadamente de modelos que apenas enxergam imagens.

## Execuções realizadas

### Regressão adicional: anexos visíveis, mas ignorados

Uma reprodução posterior encontrou quatro causas combináveis: envio do chat concorrendo com o upload; referência da conversa atrasada em um render do React; verbos como “elabore/prepare/consolide” ausentes do classificador de artefatos; e Pipeline com anexos curtos caindo no caminho somente textual. A correção adicionou barreira de upload, identidade imediata da conversa, manifesto validado no backend, indicação de arquivo indisponível, execução obrigatória do Pipeline quando há anexos e primeira inspeção por ferramenta. Uma resposta textual inválida também é retirada da interface antes da tentativa automática de reparo.

| Verificação | Resultado |
|---|---:|
| Backend Node | 229 aprovados de 231, 0 falhas, 2 pulados (3 rodadas consecutivas) |
| Frontend Node | 7 aprovados, 0 falhas |
| Excel real | 4 aprovados, 0 falhas |
| Build de produção | aprovado |
| Catálogo público atual | aprovado |
| `git diff --check` | aprovado |

Os 2 testes pulados exigem PostgreSQL por `DATABASE_URL`. O ambiente local desta auditoria não tinha PostgreSQL, Docker nem chave de provedor. Portanto, este relatório não afirma ter feito chamadas pagas/reais nem coletado respostas de cada LLM. A compatibilidade de famílias foi testada com metadados públicos atuais e contratos determinísticos de requisição; o Excel foi gerado e inspecionado de verdade.

## Proteções adicionadas ao CI

O CI passa a ter três frentes independentes:

1. backend Node;
2. frontend + build;
3. geração e reabertura de Excel real em Python.

Assim, uma regressão que volte a transformar o gerador de Excel em resposta apenas textual, que quebre gráficos/fórmulas ou que desative o pipeline de artefatos deixa evidência antes da integração.

## Riscos restantes

1. Falta um ambiente de CI com PostgreSQL para eliminar os 2 skips.
2. Falta um provedor simulado HTTP completo para exercitar SSE e tool calls passando pela rota Express e pelo banco real.
3. Chamadas ao vivo dependem da chave e da disponibilidade do provedor do usuário; o catálogo pode mudar depois desta data.
4. A retomada entre etapas do pipeline ainda precisa de cursor durável próprio para continuar automaticamente as etapas restantes após reinício total do backend.
5. O bundle do frontend continua acima de 500 kB minificado e merece divisão futura.

## Parecer

As correções cobrem todos os modelos pelo caminho comum de decisão e eliminam as falsas garantias encontradas. O fluxo está mais seguro para produção, mas a validação não deve ser chamada de “absoluta”: PostgreSQL integrado e um provedor HTTP simulado continuam sendo os próximos testes de maior valor.
