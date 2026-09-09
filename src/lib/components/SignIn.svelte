<script lang="ts">
	import type { ObsController } from '$lib/client/obs-state.svelte';

	let { controller }: { controller: ObsController } = $props();

	let token = $state('');
</script>

<div class="mx-auto flex min-h-svh max-w-sm items-center px-4">
	<form
		class="w-full rounded-xl border border-edge bg-panel p-6"
		onsubmit={(event) => {
			event.preventDefault();
			controller.signIn(token);
		}}
	>
		<h1 class="text-lg font-semibold text-ink">OBS Control</h1>
		<p class="mt-1 text-sm text-muted">This control surface is password protected.</p>

		<label class="mt-5 block">
			<span class="text-xs text-muted">Password</span>
			<input
				type="password"
				bind:value={token}
				autocomplete="current-password"
				required
				class="mt-1 w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-ink"
			/>
		</label>

		{#if controller.signInError}
			<p class="mt-3 text-sm text-live" role="alert">{controller.signInError}</p>
		{/if}

		<button
			type="submit"
			class="mt-5 w-full rounded-lg bg-info px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-info/90 disabled:opacity-50"
			disabled={controller.signingIn}
		>
			{controller.signingIn ? 'Signing in…' : 'Sign in'}
		</button>
	</form>
</div>
