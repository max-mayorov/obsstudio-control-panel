<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import ConnectionBadge from '$lib/components/ConnectionBadge.svelte';
	import RecordPanel from '$lib/components/RecordPanel.svelte';
	import ScenePicker from '$lib/components/ScenePicker.svelte';
	import SignIn from '$lib/components/SignIn.svelte';
	import Toaster from '$lib/components/Toaster.svelte';
	import { ObsController } from '$lib/client/obs-state.svelte';
	import { emptySnapshot } from '$lib/types';

	let { data } = $props();

	// Seeded from the server-rendered snapshot, so the first paint already shows the real
	// state of OBS rather than an empty shell that corrects itself a moment later.
	// `untrack` states the intent: this is a one-time seed, and every later change
	// arrives over the state stream rather than by re-running the load.
	const controller = untrack(
		() => new ObsController(data.snapshot ?? emptySnapshot(), data.authenticated)
	);

	onMount(() => {
		controller.start();
		return () => controller.stop();
	});
</script>

<svelte:head>
	<title>OBS Control</title>
	<meta name="description" content="Control OBS Studio recording and scenes from the browser" />
</svelte:head>

{#if controller.needsSignIn}
	<SignIn {controller} />
{:else}
	<div class="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
		<header class="flex flex-wrap items-center justify-between gap-4">
			<div>
				<h1 class="text-xl font-semibold tracking-tight text-ink">OBS Control</h1>
				<p class="text-sm text-faint">Recording and scene control for OBS Studio</p>
			</div>
			<div class="flex items-center gap-3">
				<ConnectionBadge
					connection={controller.connection}
					streamStatus={controller.streamStatus}
				/>
				{#if data.authRequired}
					<button
						type="button"
						class="text-xs text-faint underline underline-offset-4 hover:text-ink"
						onclick={() => controller.signOut()}
					>
						Sign out
					</button>
				{/if}
			</div>
		</header>

		{#if controller.connection.status === 'error' && controller.connection.kind === 'auth'}
			<!--
				A rejected password is not retried: it cannot fix itself, and the operator
				needs to know that restarting OBS will not help.
			-->
			<p
				class="mt-6 rounded-lg border border-live/50 bg-live/10 px-4 py-3 text-sm text-ink"
				role="alert"
			>
				OBS rejected the websocket password. Check <code class="font-mono">OBS_PASSWORD</code>
				against Tools → WebSocket Server Settings in OBS, then restart this app.
			</p>
		{/if}

		<main class="mt-6 flex flex-col gap-6">
			<RecordPanel {controller} />
			<ScenePicker {controller} />
		</main>

		<footer class="mt-10 text-xs text-faint">
			{#if controller.recording.directory}
				Recording to <span class="font-mono">{controller.recording.directory}</span>
			{/if}
		</footer>
	</div>
{/if}

<Toaster {controller} />
