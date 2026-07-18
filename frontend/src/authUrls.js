export function callbackURLForOrigin(origin) {
  try {
    const url = new URL(String(origin || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return '/';
    return `${url.origin}/`;
  } catch {
    return '/';
  }
}
