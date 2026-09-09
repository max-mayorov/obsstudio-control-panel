import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Deliberately does not load the SvelteKit plugin: everything under test is plain
// TypeScript (state reduction, filename resolution, error mapping, the OBS client
// against the mock server), so tests run without a build step. `$lib` is aliased by
// hand to keep imports identical to application code.
export default defineConfig({
	resolve: {
		alias: { $lib: path.resolve('./src/lib') }
	},
	test: {
		include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
		environment: 'node',
		testTimeout: 15_000
	}
});
