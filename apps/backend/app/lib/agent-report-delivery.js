const { sanitizeSessionEvent } = require('./agent-operations-domain');

async function deliverAgentReport({
  store,
  sessionId,
  report,
  sendTelegram,
  clock = () => new Date(),
} = {}) {
  if (!report) return report;
  if (typeof sendTelegram !== 'function') {
    return store.updateAgentReport(report.id, {
      deliveryStatus: 'not_configured',
      deliveryError: 'telegram_not_configured',
    });
  }
  try {
    const delivered = await sendTelegram(report);
    return store.updateAgentReport(report.id, {
      deliveryStatus: 'delivered',
      telegramMessageId: String(delivered?.message_id || delivered?.messageId || ''),
      deliveredAt: clock().toISOString(),
      deliveryError: '',
    });
  } catch (error) {
    if (error?.code === 'telegram_not_configured') {
      return store.updateAgentReport(report.id, {
        deliveryStatus: 'not_configured',
        deliveryError: 'telegram_not_configured',
      });
    }
    const safeError = sanitizeSessionEvent({
      kind: 'error',
      text: String(error.message || 'Telegram delivery failed'),
    }).text;
    const updated = store.updateAgentReport(report.id, {
      deliveryStatus: 'failed',
      deliveryError: safeError,
      deliveryFailedAt: clock().toISOString(),
    });
    store.appendAgentSessionEvent(sessionId, sanitizeSessionEvent({
      kind: 'error',
      text: safeError,
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
