import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Svelte and SvelteKit options live in svelte.config.ts. `sveltekit()` must be called
// without arguments for that file to be read at all: passing options here makes Kit
// ignore svelte.config.* entirely (see @sveltejs/kit ^2.62).
export default defineConfig({
	plugins: [tailwindcss(), sveltekit()]
});
