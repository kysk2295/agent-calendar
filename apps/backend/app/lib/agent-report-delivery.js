const { sanitizeSessionEvent } = require('./agent-operations-domain');

async function deliverAgentReport({
  store,
  sessionId,
  report,
  sendTelegram,
  clock = () => new Date(),
} = {}) {
  if (!report || typeof sendTelegram !== 'function') return report;
  try {
    const delivered = await sendTelegram(report);
    return store.updateAgentReport(report.id, {
      deliveryStatus: 'delivered',
      telegramMessageId: String(delivered?.message_id || delivered?.messageId || ''),
      deliveredAt: clock().toISOString(),
      deliveryError: '',
    });
  } catch (error) {
    const updated = store.updateAgentReport(report.id, {
      deliveryStatus: 'failed',
      deliveryError: String(error.message || 'Telegram delivery failed'),
      deliveryFailedAt: clock().toISOString(),
    });
    store.appendAgentSessionEvent(sessionId, sanitizeSessionEvent({
      kind: 'error',
      text: String(error.message || 'Telegram delivery failed'),
      metadata: {
        code: error.code || 'telegram_delivery_failed',
        reportId: report.id,
        reportStatus: report.status,
      },
    }));
    return updated;
  }
}

module.exports = {
  deliverAgentReport,
};
