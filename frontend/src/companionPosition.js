const DEFAULT_SIZE = Object.freeze({ width: 82, height: 97 });
const DEFAULT_MARGIN = 8;

// Controles da faixa inferior que o personagem nunca pode cobrir: o compositor
// (com os chips e o botão de enviar) e o cabeçalho do terminal (recolher,
// expandir, maximizar, fechar). Cobrir a área de log do terminal é aceitável —
// quem arrastou o Nino para lá quis isso; cobrir botão não é.
export const PROTECTED_CONTROL_SELECTORS = Object.freeze(['.composerWrap', '.dockHead', '.chatJump']);

const finite = value => typeof value === 'number' && Number.isFinite(value);

// Posições antigas ficam no navegador. Aceitamos apenas coordenadas completas e
// finitas para evitar que um valor corrompido esconda o personagem.
export function parseCompanionPosition(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || !finite(value.x) || !finite(value.y)) return null;
    return { x: value.x, y: value.y };
  } catch {
    return null;
  }
}

// Converte os retângulos dos controles protegidos em um recuo inferior para o
// `clampCompanionPosition`: o personagem para acima do controle mais alto da
// faixa, com a margem de folga. Retângulos vazios (elemento oculto) ou fora da
// janela são ignorados — sem controle visível, vale a margem padrão.
export function protectedBottomInset(viewportHeight, rects = [], margin = DEFAULT_MARGIN) {
  const height = Number(viewportHeight);
  const gap = Number(margin) >= 0 ? Number(margin) : DEFAULT_MARGIN;
  if (!(height > 0)) return gap;

  let topmost = height;
  for (const rect of Array.isArray(rects) ? rects : []) {
    if (!rect) continue;
    const top = Number(rect.top);
    const w = Number(rect.width);
    const h = Number(rect.height);
    if (!finite(top) || !(w > 0) || !(h > 0)) continue;
    if (top >= height) continue; // controle abaixo da dobra: não estorva nada
    if (top < topmost) topmost = top;
  }

  return Math.max(gap, Math.min(height, height - topmost + gap));
}

// Mantém o personagem totalmente dentro da área útil. O recuo direito pode
// reservar espaço para painéis permanentes, como a coluna Atividade do modo dev.
export function clampCompanionPosition(position, viewport = {}, element = {}, insets = {}) {
  const parsed = parseCompanionPosition(position);
  if (!parsed) return null;

  const viewportWidth = Number(viewport.width);
  const viewportHeight = Number(viewport.height);
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) return parsed;

  const width = Number(element.width) > 0 ? Number(element.width) : DEFAULT_SIZE.width;
  const height = Number(element.height) > 0 ? Number(element.height) : DEFAULT_SIZE.height;
  const left = Number(insets.left) >= 0 ? Number(insets.left) : DEFAULT_MARGIN;
  const top = Number(insets.top) >= 0 ? Number(insets.top) : DEFAULT_MARGIN;
  const right = Number(insets.right) >= 0 ? Number(insets.right) : DEFAULT_MARGIN;
  const bottom = Number(insets.bottom) >= 0 ? Number(insets.bottom) : DEFAULT_MARGIN;
  const maxX = Math.max(left, viewportWidth - width - right);
  const maxY = Math.max(top, viewportHeight - height - bottom);

  return {
    x: Math.min(maxX, Math.max(left, parsed.x)),
    y: Math.min(maxY, Math.max(top, parsed.y)),
  };
}
