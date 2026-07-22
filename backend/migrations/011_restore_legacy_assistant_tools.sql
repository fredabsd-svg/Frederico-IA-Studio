-- Correção da migração 010: no runtime antigo, tools ausente/null/[] sempre
-- liberava todas as ferramentas, inclusive em assistentes personalizados.
-- Portanto, todos os registros legados que ainda estão vazios precisam receber
-- a lista que efetivamente possuíam antes da mudança de semântica.
-- Esta migration roda uma única vez; depois dela, um [] salvo pelo usuário volta
-- a significar corretamente "nenhuma ferramenta".
UPDATE assistants
SET tools = '["run_python","bash","write_file","read_file","list_files","zip_outputs","consultar_cnpj","generate_image"]'
WHERE COALESCE(NULLIF(BTRIM(tools), ''), '[]') IN ('[]', 'null');
