-- Antes desta versão, [] era interpretado em runtime como "todas as ferramentas".
-- Preserva o comportamento somente dos assistentes oficiais já instalados. Como
-- a migration roda uma única vez, o usuário pode desmarcar tudo depois e [] passa
-- a significar corretamente "nenhuma ferramenta".
UPDATE assistants
SET tools = '["run_python","bash","write_file","read_file","list_files","zip_outputs","consultar_cnpj","generate_image"]'
WHERE name IN ('Assistente geral', 'Programação (Codex)', 'Documentos profissionais')
  AND COALESCE(NULLIF(BTRIM(tools), ''), '[]') IN ('[]', 'null');
