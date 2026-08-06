const DEFAULT_SIZE = Object.freeze({ width: 82, height: 97 });
const DEFAULT_MARGIN = 8;

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
