import { useEffect, useRef } from 'react';
import { pushEscapeLayer } from '../escapeStack.js';

// Enquanto `active` for verdadeiro, o `Esc` chama `onClose` — e SÓ ele: a
// tecla não chega ao modal ou à gaveta em volta. Ver `escapeStack.js`.
export function useEscapeLayer(active, onClose) {
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => (active ? pushEscapeLayer(() => closeRef.current?.()) : undefined), [active]);
}
