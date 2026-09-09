/**
 * Structured logging. Secrets are redacted at the logger rather than at each call site,
 * so a stray `logger.info({ config })` cannot leak the OBS password or the app token.
 */
import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.NODE_ENV === 'development';

export const logger = pino({
	level,
	redact: {
		paths: [
			'password',
			'token',
			'*.password',
			'*.token',
			'obs.password',
			'auth.token',
			'req.headers.cookie',
			'req.headers.authorization'
		],
		censor: '[redacted]'
	},
	...(pretty
		? {
				transport: {
					target: 'pino-pretty',
					options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' }
				}
			}
		: {})
});

/** A child logger tagged with the subsystem it belongs to. */
export function loggerFor(component: string) {
	return logger.child({ component });
}
