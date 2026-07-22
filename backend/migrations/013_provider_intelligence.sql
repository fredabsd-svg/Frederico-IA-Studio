-- Estado de sincronização e informações financeiras por credencial.
-- O saldo oficial é mantido separado das estimativas calculadas pelo Studio.
ALTER TABLE user_ai_providers ADD COLUMN IF NOT EXISTS billing_url TEXT;
ALTER TABLE user_ai_providers ADD COLUMN IF NOT EXISTS balance_info TEXT;
ALTER TABLE user_ai_providers ADD COLUMN IF NOT EXISTS balance_checked_at TEXT;
ALTER TABLE user_ai_providers ADD COLUMN IF NOT EXISTS last_sync_status TEXT;
ALTER TABLE user_ai_providers ADD COLUMN IF NOT EXISTS last_sync_error TEXT;
