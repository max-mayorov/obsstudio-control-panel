<script lang="ts">
	import { formatBytes } from '$lib/client/format';
	import type { ObsController } from '$lib/client/obs-state.svelte';
	import FilenameCard from './FilenameCard.svelte';
	import Timecode from './Timecode.svelte';

	let { controller }: { controller: ObsController } = $props();

	const recording = $derived(controller.recording);
	const disabled = $derived(!controller.online);
</script>

<section class="rounded-xl border border-edge bg-panel p-5 sm:p-6">
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div>
			<div class="flex items-center gap-2">
				<span
					class="h-2.5 w-2.5 rounded-full {recording.active
						? recording.paused
							? 'bg-warn'
							: 'animate-pulse bg-live'
						: 'bg-edge'}"
				></span>
				<h2 class="text-xs font-semibold tracking-widest text-faint uppercase">
					{recording.active ? (recording.paused ? 'Paused' : 'Recording') : 'Idle'}
				</h2>
			</div>
			<div class="mt-3">
				<Timecode ms={controller.displayMs} dimmed={!recording.active} />
			</div>
			<p class="mt-2 text-xs text-faint" aria-live="polite">
				{recording.active ? formatBytes(recording.bytes) : 'Ready'}
			</p>
		</div>

		<div class="flex flex-wrap gap-2">
			{#if recording.active}
				<button
					type="button"
					class="rounded-lg bg-live px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-live/90 focus-visible:outline-live disabled:cursor-not-allowed disabled:opacity-50"
					{disabled}
					aria-busy={controller.isPending('record')}
					onclick={() => controller.stopRecording()}
				>
					{controller.isPending('record') ? 'Stopping…' : 'Stop recording'}
				</button>
				<button
					type="button"
					class="rounded-lg border border-edge bg-raised px-5 py-2.5 text-sm font-semibold text-ink transition hover:border-muted disabled:cursor-not-allowed disabled:opacity-50"
					{disabled}
					aria-busy={controller.isPending('pause')}
					onclick={() =>
						recording.paused ? controller.resumeRecording() : controller.pauseRecording()}
				>
					{recording.paused ? 'Resume' : 'Pause'}
				</button>
			{:else}
				<button
					type="button"
					class="rounded-lg bg-live px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-live/90 disabled:cursor-not-allowed disabled:opacity-50"
					{disabled}
					aria-busy={controller.isPending('record')}
					onclick={() => controller.startRecording()}
				>
					{controller.isPending('record') ? 'Starting…' : 'Start recording'}
				</button>
			{/if}
		</div>
	</div>

	<div class="mt-5 border-t border-edge pt-4">
		<FilenameCard {recording} />
	</div>
</section>
