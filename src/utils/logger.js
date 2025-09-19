import winston from 'winston';
import { AsyncLocalStorage } from 'async_hooks';

export const asyncLocalStorage = new AsyncLocalStorage();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.printf(info => {
      let message = `${info.timestamp} [${info.level.toUpperCase()}]`;
      if (info.runId) {
        message += ` [RunID: ${info.runId}]`;
      }
      if (info.inputContext) {
        message += ` [${info.inputContext}]`;
      }
      message += `: ${info.message}`;
      return message;
    })
  ),
  transports: [
    new winston.transports.Console()
  ],
});

export const getLogger = (runId, inputContext) => {
  const childLogger = logger.child({ runId, inputContext });
  // asyncLocalStorage.enterWith(childLogger);
  return childLogger;
};

export const getAsyncContextLogger = () => {
  return asyncLocalStorage.getStore() || logger; // Fallback to default logger if no context is set
};

// Export the base logger for general use if no specific runId or inputContext is needed
export default logger;
