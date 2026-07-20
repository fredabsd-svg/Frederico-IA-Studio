import React, { useState } from 'react';

// Ícone oficial do provedor (família) do modelo, mostrado antes do nome na
// lista de modelos. A família é o prefixo do id do modelo (ex.: "anthropic" em
// "anthropic/claude-sonnet-5"), a mesma regra usada em components.jsx.
//
// Os logos são servidos LOCALMENTE de /providers/*.png (pasta frontend/public).
// Nada de CDN: o app roda tailnet-only e precisa funcionar sem internet — e a
// tag "@latest" da unpkg quebraria sozinha um dia. Arte original: conjunto
// estático da LobeHub (variante dark = ícone claro), que lê bem sobre o
// ladrilho escuro do .mpProvIcon em qualquer tema.

// família (prefixo do id) → arquivo em /providers. null = usar monograma.
const SLUG = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'gemini',
  deepseek: 'deepseek',
  'meta-llama': 'meta',
  meta: 'meta',
  mistralai: 'mistral',
  mistral: 'mistral',
  'x-ai': 'grok',
  xai: 'grok',
  qwen: 'qwen',
  cohere: 'cohere',
  amazon: 'nova',
  nvidia: 'nvidia',
  perplexity: 'perplexity',
  'z-ai': 'zhipu',
  zai: 'zhipu',
  moonshotai: 'kimi',
  moonshot: 'kimi',
  minimax: 'minimax',
  bytedance: 'bytedance',
  'bytedance-seed': 'bytedance',
  'aion-labs': 'aionlabs',
  openrouter: 'openrouter',
  microsoft: null,
  nousresearch: null,
};

const familyKey = (id) => {
  const s = String(id || '');
  return s.includes('/') ? s.split('/')[0] : s.split('-')[0];
};

const asset = (slug) => `/providers/${slug}.png`;

export function ProviderIcon({ id, size = 28, className = '' }) {
  const [broken, setBroken] = useState(false);
  const key = familyKey(id);
  const src = SLUG[key] ? asset(SLUG[key]) : null;
  const mono = (key[0] || '?').toUpperCase();
  const style = { width: size, height: size };

  if (!src || broken) {
    return (
      <span className={`mpProvIcon mpProvMono ${className}`} style={style} aria-hidden="true">
        {mono}
      </span>
    );
  }
  return (
    <span className={`mpProvIcon ${className}`} style={style} aria-hidden="true">
      <img
        src={src}
        alt=""
        width={Math.round(size * 0.68)}
        height={Math.round(size * 0.68)}
        loading="lazy"
        onError={() => setBroken(true)}
      />
    </span>
  );
}
