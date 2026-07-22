-- Múltiplos provedores de IA por usuário.
-- O catálogo fica junto da credencial que o originou para impedir que modelos
-- de contas/provedores diferentes sejam confundidos.
CREATE TABLE IF NOT EXISTS user_ai_providers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_enc TEXT NOT NULL,
  models TEXT NOT NULL DEFAULT '[]',
  default_model TEXT,
  last_validated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_ai_providers_user
  ON user_ai_providers(user_id, created_at);

-- Preserva configurações BYOK antigas. O catálogo é validado/importado pelo
-- backend no primeiro carregamento, usando a chave já cifrada.
INSERT INTO user_ai_providers (
  id, user_id, provider_type, name, base_url, api_key_enc, models,
  default_model, last_validated_at, created_at, updated_at
)
SELECT
  'legacy-' || user_id,
  user_id,
  CASE
    WHEN LOWER(COALESCE(base_url, '')) LIKE '%openrouter.ai%' THEN 'openrouter'
    WHEN LOWER(COALESCE(base_url, '')) LIKE '%nvidia.com%' THEN 'nvidia'
    WHEN LOWER(COALESCE(base_url, '')) LIKE '%dashscope%' OR LOWER(COALESCE(base_url, '')) LIKE '%aliyuncs.com%' THEN 'alibaba'
    WHEN LOWER(COALESCE(base_url, '')) LIKE '%deepseek.com%' THEN 'deepseek'
    ELSE 'custom'
  END,
  CASE
    WHEN LOWER(COALESCE(base_url, '')) LIKE '%openrouter.ai%' THEN 'OpenRouter'
    WHEN LOWER(COALESCE(base_url, '')) LIKE '%nvidia.com%' THEN 'NVIDIA'
    WHEN LOWER(COALESCE(base_url, '')) LIKE '%dashscope%' OR LOWER(COALESCE(base_url, '')) LIKE '%aliyuncs.com%' THEN 'Alibaba Model Studio'
    WHEN LOWER(COALESCE(base_url, '')) LIKE '%deepseek.com%' THEN 'DeepSeek'
    ELSE 'Provedor migrado'
  END,
  COALESCE(NULLIF(base_url, ''), 'https://api.deepseek.com'),
  api_key_enc,
  '[]',
  model,
  NULL,
  created_at,
  updated_at
FROM user_settings
WHERE api_key_enc IS NOT NULL
ON CONFLICT (id) DO NOTHING;
