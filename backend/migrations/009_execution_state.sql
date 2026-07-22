-- Estado explícito da execução que originou uma resposta. Evita que o frontend
-- confunda fim de stream, silêncio do modelo ou histórico de ferramentas com
-- conclusão bem-sucedida.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS execution_meta TEXT;
