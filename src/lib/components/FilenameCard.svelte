<script lang="ts">
	import { basename } from '$lib/client/format';
	import type { RecordingState } from '$lib/types';

	let { recording }: { recording: RecordingState } = $props();
</script>

<div class="min-w-0">
	<h2 class="text-xs font-semibold tracking-widest text-faint uppercase">Recording file</h2>

	{#if recording.file}
		<p class="mt-1 truncate font-mono text-sm text-ink" title={recording.file.path}>
			{basename(recording.file.path)}
		</p>
		<div class="mt-1 flex flex-wrap items-center gap-2">
			{#if recording.file.source === 'predicted'}
				<!--
					OBS only reports a recording's path in the event that fires when it starts.
					Connect midway and that event is gone, and no request will return it, so this
					name is reconstructed from the record directory and the profile's filename
					template. Saying so is the honest option.
				-->
				<span
					class="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[11px] font-medium text-warn"
					title="Reconstructed from the record directory and OBS's filename template, because the recording was already running when this app connected. The exact name may differ."
				>
					predicted
				</span>
			{:else}
				<span
					class="rounded border border-good/40 bg-good/10 px-1.5 py-0.5 text-[11px] font-medium text-good"
					title="Reported by OBS itself"
				>
					from OBS
				</span>
			{/if}
			<span class="truncate text-xs text-faint" title={recording.file.path}>
				{recording.file.path}
			</span>
		</div>
	{:else if recording.lastCompleted}
		<p class="mt-1 truncate font-mono text-sm text-muted" title={recording.lastCompleted.path}>
			{basename(recording.lastCompleted.path)}
		</p>
		<p class="mt-1 text-xs text-faint">Last recording saved</p>
	{:else}
		<p class="mt-1 text-sm text-faint">No recording yet</p>
		{#if recording.directory}
			<p class="mt-1 truncate font-mono text-xs text-faint" title={recording.directory}>
				{recording.directory}
			</p>
		{/if}
	{/if}
</div>
