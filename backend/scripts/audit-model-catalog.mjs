import { modelProfileFromProvider } from '../src/modelCapabilities.js';

const url = process.env.MODEL_CATALOG_URL || 'https://openrouter.ai/api/v1/models';
const response = await fetch(url, { headers: { Accept: 'application/json' } });
if (!response.ok) throw new Error(`Catálogo respondeu HTTP ${response.status}`);
const payload = await response.json();
const profiles = (payload.data || []).map(modelProfileFromProvider).filter(profile => profile.id);

const families = ['openai', 'anthropic', 'google', 'deepseek', 'qwen', 'z-ai', 'mistralai', 'meta', 'x-ai', 'nvidia'];
const familyCoverage = Object.fromEntries(families.map(family => {
  const candidates = profiles.filter(profile => profile.id.startsWith(`${family}/`) && profile.capabilities.text !== false);
  return [family, {
    total: candidates.length,
    tools: candidates.filter(profile => profile.capabilities.tools === true).length,
    vision: candidates.filter(profile => profile.capabilities.vision === true).length,
    image: candidates.filter(profile => profile.capabilities.image === true).length
  }];
}));

const configuredFreeIds = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'
];
const configuredFree = configuredFreeIds.map(id => {
  const profile = profiles.find(item => item.id === id);
  return {
    id,
    present: Boolean(profile),
    tools: profile?.capabilities?.tools ?? null,
    vision: profile?.capabilities?.vision ?? null,
    context: profile?.context || null
  };
});

const free = profiles.filter(profile => profile.free);
const result = {
  checkedAt: new Date().toISOString(),
  url,
  catalogModels: profiles.length,
  familyCoverage,
  free: {
    total: free.length,
    withTools: free.filter(profile => profile.capabilities.tools === true).length,
    withVision: free.filter(profile => profile.capabilities.vision === true).length,
    withToolsAndVision: free.filter(profile => profile.capabilities.tools === true && profile.capabilities.vision === true).length
  },
  configuredFree
};
console.log(JSON.stringify(result, null, 2));

if (configuredFree.some(model => !model.present || model.tools !== true)) process.exitCode = 1;
