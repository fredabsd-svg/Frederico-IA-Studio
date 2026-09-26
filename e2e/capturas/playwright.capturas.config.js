// Roteiro que REFAZ as capturas do produto usadas na landing
// (frontend/public/landing/produto-{dark,light}.jpg). Não é teste: roda à parte,
// com o mesmo ambiente da E2E (provedor falso, banco descartável):
//   E2E_DATABASE_URL=... npm run capturar:landing
// A última resposta recebe um texto de EXEMPLO — a landing rotula a imagem como
// "conteúdo da conversa ilustrativo".
import base from '../playwright.config.js';

export default { ...base, testDir: './', testMatch: /\.capture\.js$/, retries: 0, timeout: 180_000 };
