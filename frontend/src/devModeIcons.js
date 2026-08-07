import { Bot, Bug, Hammer, ListChecks, MessageCircleQuestion, ShieldCheck } from 'lucide-react';

// Ícones de cada modo de trabalho do Modo Desenvolvedor (DEV_WORK_MODES.icon →
// componente lucide). Mora num módulo próprio, minúsculo, porque tem DOIS
// consumidores em chunks diferentes: o DevProjectRail (entrada) e o
// DeveloperPanel (lazy). Quando este mapa vivia dentro do DeveloperPanel, o
// import estático do rail puxava o drawer INTEIRO para o chunk de entrada e
// anulava o React.lazy dele.
export const DEV_MODE_ICON = {
  ask: MessageCircleQuestion, plan: ListChecks, build: Hammer, fix: Bug, review: ShieldCheck, auto: Bot
};
