# Instruções do projeto — Frederico IA Studio

Este arquivo é carregado automaticamente em toda sessão do Claude Code neste
repositório. Vale para qualquer conversa, em qualquer chat.

## Regra permanente: sempre abrir um Pull Request

**Toda frente de trabalho termina com um Pull Request aberto.** Não espere o
usuário pedir — commitar e dar push não encerra a tarefa.

Fluxo obrigatório ao concluir qualquer mudança:

1. Desenvolver na branch designada da sessão (nunca commitar direto na `main`).
2. Validar antes de commitar (ver "Validação" abaixo).
3. Atualizar o `CONTINUIDADE.md` com a frente de trabalho.
4. Commit descritivo em português.
5. `git push -u origin <branch>`.
6. **Abrir o Pull Request para a `main`** e informar o link ao usuário.

Detalhes:

- **Confira a base antes de abrir.** Faça `git fetch origin` e compare com
  `origin/main`, não com a `main` local — ela costuma estar desatualizada no
  contêiner e faz o PR parecer ter centenas de arquivos que não são seus.
- **Um PR por frente de trabalho.** Se a branch já tem um PR aberto, os novos
  commits entram nele (o push atualiza o PR); não abra um segundo.
- **Se o PR da branch já foi mesclado**, recomece a branch a partir da `main`
  atualizada e abra um PR novo — nunca empilhe trabalho novo sobre histórico
  já mesclado.
- **Descrição do PR:** o que mudou, por que, como foi validado e o que ficou de
  fora. Em português. Se houver mudança de comportamento visível para o usuário,
  diga isso explicitamente.
- Não faça merge do PR por conta própria — quem decide é o usuário.

## Validação antes de qualquer commit

```bash
cd backend  && node --test "src/**/*.test.js"
cd frontend && node --test src/*.test.js && npm run build
```

Os testes que exigem PostgreSQL são pulados fora do Docker — isso é esperado.
Nunca declare que algo funciona sem ter rodado a validação.

## Processo

- `CONTINUIDADE.md` é o registro do projeto: estado, decisões, armadilhas e
  próximos passos. Leia antes de iniciar uma frente e atualize ao concluir.
- Commits e PRs em português, descritivos — o "porquê" importa mais que o "o quê".
- Só anunciar (README, interface, selos) o que está de fato ativo no código.
