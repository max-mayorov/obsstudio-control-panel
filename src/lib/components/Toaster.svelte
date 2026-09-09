<script lang="ts">
	import type { ObsController } from '$lib/client/obs-state.svelte';

	let { controller }: { controller: ObsController } = $props();
</script>

<div
	class="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4"
	aria-live="assertive"
>
	{#each controller.toasts as toast (toast.id)}
		<div
			class="pointer-events-auto w-full max-w-md rounded-lg border px-4 py-3 shadow-lg backdrop-blur
				{toast.kind === 'error'
				? 'border-live/50 bg-live/15 text-ink'
				: 'border-good/50 bg-good/10 text-ink'}"
			role={toast.kind === 'error' ? 'alert' : 'status'}
		>
			<div class="flex items-start justify-between gap-3">
				<p class="text-sm break-words">{toast.message}</p>
				<button
					type="button"
					class="shrink-0 text-xs text-faint hover:text-ink"
					onclick={() => controller.dismiss(toast.id)}
					aria-label="Dismiss"
				>
					✕
				</button>
			</div>
			{#if toast.requestId && toast.requestId !== '-'}
				<!-- The same id appears in the server log line for this failure. -->
				<p class="mt-1 font-mono text-[11px] text-faint">ref {toast.requestId.slice(0, 8)}</p>
			{/if}
		</div>
	{/each}
</div>
