#!/usr/bin/env node
/** Aplica o hero honesto no README.md (badge amarelo + 3 bullets + Nino/Dev/Design). */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const readme = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'README.md');
let t = fs.readFileSync(readme, 'utf8');
const oldHero = `<div align="center">

# 🎨 Frederico IA Studio

### Seu estúdio de IA, em português.

**Converse, peça e receba o arquivo pronto.** Planilhas com fórmulas, documentos
Word diagramados, PDFs, gráficos e código — gerados de verdade num sandbox
isolado, não descritos em texto.

![React](https://img.shields.io/badge/React-Vite-61DAFB?logo=react&logoColor=white&labelColor=20232a)
![Node.js](https://img.shields.io/badge/Node.js-Express-339933?logo=nodedotjs&logoColor=white&labelColor=20232a)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-pgvector-4169E1?logo=postgresql&logoColor=white&labelColor=20232a)
![Docker](https://img.shields.io/badge/Docker-Sandbox-2496ED?logo=docker&logoColor=white&labelColor=20232a)
![Status](https://img.shields.io/badge/SaaS%20multiusu%C3%A1rio-em%20produ%C3%A7%C3%A3o-2ea043)
![LGPD](https://img.shields.io/badge/LGPD-conformidade%20embutida-8957e5)`;
const newHero = `<div align="center">

# 🎨 Frederico IA Studio

### Seu estúdio de IA, em português — com arquivo de verdade no final.

Peça no chat e receba **planilha, Word, PDF, gráfico ou código** gerados num
sandbox Docker isolado. Não é “texto que descreve o arquivo”: é o arquivo.

- **Chat que entrega** — Excel com fórmulas conferidas, Word/PDF diagramados, OCR e CNPJ
- **Modo Design + Nino** — prévia HTML isolada com versões; copiloto que some e volta com um clique
- **Modo Desenvolvedor + GitHub** — projeto com sessão (modo, repo, permissões) e PR em um fluxo

![React](https://img.shields.io/badge/React-Vite-61DAFB?logo=react&logoColor=white&labelColor=20232a)
![Node.js](https://img.shields.io/badge/Node.js-Express-339933?logo=nodedotjs&logoColor=white&labelColor=20232a)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-pgvector-4169E1?logo=postgresql&logoColor=white&labelColor=20232a)
![Docker](https://img.shields.io/badge/Docker-Sandbox-2496ED?logo=docker&logoColor=white&labelColor=20232a)
![Status](https://img.shields.io/badge/Produ%C3%A7%C3%A3o-amarelo%20·%20apto%20com%20restri%C3%A7%C3%B5es-e3b341)
![LGPD](https://img.shields.io/badge/LGPD-exportar%20·%20apagar%20·%20consentimento-8957e5)`;
if (!t.includes(oldHero)) {
  if (t.includes('apto com restri') || t.includes('Produ%C3%A7%C3%A3o-amarelo')) { console.log('README já atualizado'); process.exit(0); }
  console.error('hero antigo não encontrado'); process.exit(1);
}
t = t.replace(oldHero, newHero);
const pairs = [
  [`- **Prévia isolada** — o HTML gerado roda num iframe de origem opaca, sem
  acesso à sua sessão nem ao resto da interface.`,
   `- **Prévia isolada** — o HTML gerado roda num iframe de origem opaca (sandbox
  sem \`allow-same-origin\`), sem acesso à sua sessão. Troca de versão recarrega
  a prévia de verdade (query + remontagem do iframe — não fica em “Carregando…”).`],
  [`### 🌱 Nino, o copiloto

O personagem que acompanha o Studio — e explica o que está acontecendo.

- **Estados ao vivo**: pensando, analisando, digitando, sugestão, dúvida — lidos
  da atividade real do app, nunca inventados.`,
   `### 🌱 Nino, o copiloto

O personagem que acompanha o Studio — e explica o que está acontecendo.

- **Ocultar / mostrar** — botão **Ocultar** no avatar; quando some, fica o botão
  **Mostrar Nino** (não precisa ir em Configurações). O código do Companion permanece.
- **Estados ao vivo**: pensando, analisando, digitando, sugestão, dúvida — lidos
  da atividade real do app, nunca inventados.`],
  [`- **Modo Desenvolvedor** — projetos com memória permanente, explorador de
  arquivos e seis modos de trabalho (Perguntar, Planejar, Implementar, Corrigir
  erro, Revisar e Agente autônomo).`,
   `- **Modo Desenvolvedor** — projetos com memória permanente, explorador de
  arquivos e seis modos de trabalho (Perguntar, Planejar, Implementar, Corrigir
  erro, Revisar e Agente autônomo). Abrir o modo ou o workspace **semeia a sessão**
  (modo, GitHub/pasta, permissões) para o chat não cair em “casca de IDE” genérica.`],
];
for (const [a,b] of pairs) {
  if (!t.includes(a)) { console.error('âncora README faltando'); process.exit(1); }
  t = t.replace(a,b);
}
fs.writeFileSync(readme, t);
console.log('README hero + bullets atualizados');
