import adapter from '@sveltejs/adapter-node';
import type { Config } from '@sveltejs/kit';

const config: Config = {
	kit: {
		// adapter-node: the app is deployed as a long-lived Node server because it holds
		// an open websocket to OBS and streams state to browsers. A serverless target
		// cannot keep either alive.
		adapter: adapter()
	},

	// Runes everywhere in our own code; leave libraries on their own setting.
	compilerOptions: {
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	}
};

export default config;
