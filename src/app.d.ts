declare global {
	namespace App {
		interface Locals {
			/** Correlates a client-visible error with the server log line that explains it. */
			requestId: string;
			/** True when APP_TOKEN is configured and the API therefore requires a session. */
			authRequired: boolean;
			authenticated: boolean;
		}
	}
}

export {};
