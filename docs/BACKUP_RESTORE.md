# Backup e restauração

> Atualizado em **2026-07-25**. Corrige o achado **F-05** da auditoria: o backup
> anterior **não** levava a chave mestra, e a restauração devolvia um banco íntegro
> com **todos os segredos ilegíveis**.

---

## 1. O que compõe um backup completo

| Item | Onde vive | Vai no pacote? |
| --- | --- | --- |
| Banco PostgreSQL | serviço `postgres` | **Sim** (`pg_dump --no-owner --no-privileges`) |
| Workspaces | `WORKSPACE_ROOT/` | **Sim** |
| Chave mestra em arquivo | `DATA_DIR/encryption.key` | **Sim** |
| Chave mestra por ambiente | `ENCRYPTION_KEY` | **Não** — guarde-a por fora (o manifesto avisa) |
| Manifesto | gerado | **Sim** (`manifest.json`) |
| Cache do Docling | `DOCLING_CACHE_ROOT` | Não — é derivado e reprocessável |

### Por que a chave mestra importa

As chaves de IA e os tokens de conector ficam **cifrados** no banco (AES-256-GCM). A chave
que os decifra é a mestra. Restaurar o dump sem ela devolve as linhas — e
`decryptSecret()` devolve `null` para todas. Na prática: cada usuário teria de recadastrar
a chave de API e reconectar o GitHub, e nenhuma mensagem de erro explicaria o porquê.

Esse ciclo exato é testado: `backend/src/backup.test.js` → *"CICLO REAL: segredo cifrado
antes do backup é decifrado depois da restauração"*.

---

## 2. Gerar o backup

```bash
curl -fL --cookie "$COOKIE_DE_SESSAO" https://SEU_DOMINIO/api/backup \
     -o frederico-backup-$(date +%F).tar.gz
```

Só o **administrador** pode baixar (papel em `user_roles` — ver `docs/SECURITY.md` §5).
O download fica registrado em `admin_audit`.

Garantias do processo:
- **um backup por vez** (409 no segundo simultâneo — antes ambos disputavam o mesmo
  `/tmp/frederico-db-<data>.sql` e o download saía truncado, sem aviso);
- diretório temporário exclusivo, removido **sempre** — inclusive se o cliente abortar;
- falha antes do primeiro byte responde JSON de erro, não um `.tar.gz` truncado.

> **Se `ENCRYPTION_KEY` vem do ambiente**, o pacote **não** a contém.
> Guarde-a no mesmo cofre do `BETTER_AUTH_SECRET`, com a mesma política de retenção
> do backup. Sem ela o pacote é inútil para recuperar segredos.

---

## 3. Conteúdo do pacote

```
frederico-backup-2026-07-25.tar.gz
├── manifest.json
├── frederico-db-2026-07-25.sql
├── encryption.key            (só quando a chave vive em arquivo)
└── workspaces/
    └── users/<usuário>/<conversa>/{uploads,outputs,...}
```

`manifest.json`:

```json
{
  "formato": "frederico-ia-studio/backup",
  "versao_backup": 1,
  "criado_em": "2026-07-25T21:40:00.000Z",
  "versao_app": null,
  "schema": { "ultima_migracao": "020_admin_roles_audit.sql", "migracoes_aplicadas": 20 },
  "chave_mestra": {
    "origem": "file",
    "incluida_no_pacote": true,
    "aviso": "Este pacote CONTÉM a chave mestra (encryption.key) ..."
  },
  "conteudo": [
    { "arquivo": "frederico-db-2026-07-25.sql", "papel": "postgres-dump", "bytes": 1234567, "sha256": "..." },
    { "arquivo": "encryption.key", "papel": "encryption-key", "bytes": 65, "sha256": "..." },
    { "arquivo": "workspaces/", "papel": "workspaces", "bytes": null, "sha256": null }
  ],
  "restauracao": "Ver docs/BACKUP_RESTORE.md"
}
```

> **Se `incluida_no_pacote` for `true`, o arquivo é um segredo.** Ele descriptografa as
> credenciais de todos os usuários. Guarde cifrado e restrinja o acesso como faria com
> uma chave privada.

---

## 4. Restaurar

### 4.1 Extrair e conferir a integridade

```bash
mkdir restauracao && tar -xzf frederico-backup-2026-07-25.tar.gz -C restauracao
cd restauracao && cat manifest.json
```

Verificação de checksums (falha se algum arquivo foi alterado ou perdido no transporte):

```bash
cd /caminho/do/repo/backend
node -e "
  const { verifyExtractedBackup } = await import('./src/backup.js');
  const r = verifyExtractedBackup(process.argv[1]);
  console.log(r.ok ? 'pacote íntegro' : 'PROBLEMAS: ' + (r.problems || [r.error]).join('; '));
  process.exit(r.ok ? 0 : 1);
" --input-type=module /caminho/da/restauracao
```

### 4.2 Parar o app (mantendo o Postgres de pé)

```bash
docker compose -f docker-compose.prod.yml stop backend web
```

### 4.3 Restaurar a chave mestra — **antes do banco**

- Manifesto com `"origem": "file"` → copie `encryption.key` para o `DATA_DIR` do destino:

  ```bash
  install -m 600 restauracao/encryption.key ./data/encryption.key
  ```

- Manifesto com `"origem": "env"` → defina `ENCRYPTION_KEY` no `.env` do destino **com o
  mesmo valor do host de origem**. Se esse valor se perdeu, os segredos são irrecuperáveis:
  siga para o §4.6.

> Faça isto **antes** de subir o backend. Se ele subir sem chave nenhuma, gera uma nova em
> `DATA_DIR/encryption.key` — e aí a chave errada passa a ser a "oficial" da instalação.

### 4.4 Restaurar o banco

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U studio -d postgres -c "DROP DATABASE IF EXISTS studio;" -c "CREATE DATABASE studio;"

docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U studio -d studio < restauracao/frederico-db-2026-07-25.sql
```

### 4.5 Restaurar os workspaces

```bash
rsync -a --delete restauracao/workspaces/ ./workspaces/
# os arquivos são lidos/escritos pelo uid 1000 dentro do sandbox
chown -R 1000:1000 ./workspaces
```

### 4.6 Subir e validar

```bash
docker compose -f docker-compose.prod.yml up -d backend web
curl -fsS https://SEU_DOMINIO/api/health
```

Checklist de aceitação da restauração:

1. `/api/health` responde `{"ok":true}`;
2. o log do boot **não** traz `[crypto] ENCRYPTION_KEY não definida — gerei uma chave mestra`
   (se trouxer, o §4.3 foi pulado: pare, corrija a chave e refaça o §4.4);
3. login funciona;
4. **Configurações → Provedor de IA** mostra a chave mascarada e o botão *Validar* passa
   — é a prova de que a chave mestra correta foi restaurada;
5. **Configurações → Conectores** mostra o GitHub ainda conectado;
6. uma conversa antiga abre com mensagens **e** com os arquivos baixáveis;
7. `SELECT COUNT(*) FROM schema_migrations;` = número de arquivos em `backend/migrations/`.

Se (4) ou (5) falhar mas (3) funcionar, o sintoma é exatamente "banco certo, chave errada":
recoloque a chave correta e reinicie o backend — nada precisa ser reimportado.

---

## 5. Rotina recomendada

| Item | Recomendação |
| --- | --- |
| Frequência | Diária (banco), semanal (pacote completo com workspaces) |
| Retenção | 7 diários + 4 semanais + 6 mensais |
| Armazenamento | Fora do host, **cifrado** (o pacote pode conter a chave mestra) |
| Teste de restauração | **Trimestral**, em host limpo, com o checklist do §4.6 |
| Chave mestra | Cópia separada no cofre, mesmo quando também vai no pacote |

Um backup nunca restaurado não é um backup. O item mais importante desta página é o
teste trimestral.

---

## 6. Limitações conhecidas

- Não há restauração automatizada por rota/CLI — o procedimento é manual e deliberado
  (restaurar por HTTP seria uma superfície perigosa demais).
- O pacote não inclui o cache do Docling (derivado, reprocessável sob demanda).
- Não há backup incremental nem WAL archiving; para RPO curto, configure replicação do
  Postgres à parte.
- O `pg_dump` roda com o `DATABASE_URL` do backend: o usuário precisa ler todas as tabelas.
