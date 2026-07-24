// Métricas de saúde do processo — expostas no /api/health para monitoramento
// em produção sem precisar acessar logs do container.
export const healthMetrics = {
  unhandledRejections: 0,
  bootAt: new Date().toISOString(),
};
