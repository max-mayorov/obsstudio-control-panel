<script lang="ts">
	import type { ConnectionState } from '$lib/types';

	let {
		connection,
		streamStatus
	}: {
		connection: ConnectionState;
		streamStatus: 'connecting' | 'open' | 'closed';
	} = $props();

	/**
	 * The badge reports the OBS link. The browser's own stream only surfaces when it is
	 * the thing that is broken, so a healthy connection reads as one fact, not two.
	 */
	const tone = $derived(
		connection.status === 'connected'
			? streamStatus === 'open'
				? 'good'
				: 'warn'
			: connection.status === 'error'
				? 'bad'
				: 'warn'
	);

	const label = $derived.by(() => {
		switch (connection.status) {
			case 'connected':
				return streamStatus === 'open' ? 'Connected' : 'Reconnecting the live feed';
			case 'connecting':
				return 'Connecting to OBS';
			case 'reconnecting':
				return `Reconnecting to OBS (attempt ${connection.attempt})`;
			case 'error':
				return connection.kind === 'auth' ? 'OBS rejected the password' : 'OBS unreachable';
		}
	});

	const detail = $derived.by(() => {
		if (connection.status === 'connected') {
			return `OBS ${connection.obsVersion} · websocket ${connection.websocketVersion}`;
		}
		if (connection.status === 'reconnecting') return connection.lastError;
		if (connection.status === 'error') return connection.message;
		return null;
	});

	const dot = { good: 'bg-good', warn: 'bg-warn', bad: 'bg-live' } as const;
	const text = { good: 'text-good', warn: 'text-warn', bad: 'text-live' } as const;
</script>

<div
	class="flex items-center gap-3 rounded-lg border border-edge bg-panel px-3 py-2"
	role="status"
	aria-live="polite"
>
	<span class="relative flex h-2.5 w-2.5 shrink-0">
		{#if tone !== 'good'}
			<span
				class="absolute inline-flex h-full w-full animate-ping rounded-full {dot[tone]} opacity-60"
			></span>
		{/if}
		<span class="relative inline-flex h-2.5 w-2.5 rounded-full {dot[tone]}"></span>
	</span>
	<div class="min-w-0">
		<p class="text-sm font-medium {text[tone]}">{label}</p>
		{#if detail}
			<p class="truncate text-xs text-faint" title={detail}>{detail}</p>
		{/if}
	</div>
</div>
