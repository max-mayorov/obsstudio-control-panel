<script lang="ts">
	import type { ObsController } from '$lib/client/obs-state.svelte';

	let { controller }: { controller: ObsController } = $props();

	const scenes = $derived(controller.scenes);
	const disabled = $derived(!controller.online || scenes.stale);

	/**
	 * In studio mode a click stages the scene in preview and the operator takes it to
	 * air explicitly. Cutting straight to program on click would put a scene on air that
	 * the operator was only lining up — the wrong surprise for a control surface.
	 */
	function choose(name: string) {
		return scenes.studioMode ? controller.setPreviewScene(name) : controller.setProgramScene(name);
	}

	function isSelected(name: string): boolean {
		return scenes.studioMode ? scenes.preview === name : scenes.program === name;
	}
</script>

<section class="rounded-xl border border-edge bg-panel p-5 sm:p-6">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<h2 class="text-xs font-semibold tracking-widest text-faint uppercase">Scenes</h2>
		{#if scenes.studioMode}
			<span
				class="rounded border border-info/40 bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info"
				title="Studio mode is on in OBS. Selecting a scene stages it in preview; use Take to put it on air."
			>
				studio mode
			</span>
		{/if}
	</div>

	{#if scenes.scenes.length === 0}
		<p class="mt-4 text-sm text-faint">
			{controller.online ? 'OBS has no scenes.' : 'Waiting for OBS…'}
		</p>
	{:else}
		<!-- The dropdown is the compact control; the grid below doubles as a status display. -->
		<label class="mt-4 block">
			<span class="text-xs text-muted">Switch to scene</span>
			<select
				class="mt-1 w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-ink disabled:opacity-50"
				{disabled}
				value={scenes.studioMode ? scenes.preview : scenes.program}
				onchange={(event) => choose(event.currentTarget.value)}
			>
				{#each scenes.scenes as scene (scene.uuid || scene.name)}
					<option value={scene.name}>{scene.name}</option>
				{/each}
			</select>
		</label>

		<div class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
			{#each scenes.scenes as scene (scene.uuid || scene.name)}
				{@const selected = isSelected(scene.name)}
				{@const onAir = scenes.program === scene.name}
				<button
					type="button"
					class="rounded-lg border px-3 py-2.5 text-left text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50
						{selected
						? 'border-info bg-info/15 text-ink'
						: 'border-edge bg-raised text-muted hover:border-muted hover:text-ink'}"
					{disabled}
					aria-pressed={selected}
					aria-busy={controller.isPending(`scene:${scene.name}`)}
					onclick={() => choose(scene.name)}
				>
					<span class="flex items-center justify-between gap-2">
						<span class="truncate">{scene.name}</span>
						{#if onAir}
							<span class="shrink-0 rounded bg-live px-1.5 py-0.5 text-[10px] text-white">
								ON AIR
							</span>
						{/if}
					</span>
				</button>
			{/each}
		</div>

		{#if scenes.studioMode}
			<div class="mt-4 flex items-center justify-between gap-3 border-t border-edge pt-4">
				<p class="text-xs text-faint">
					Preview <span class="font-medium text-muted">{scenes.preview ?? '—'}</span>
					→ Program <span class="font-medium text-muted">{scenes.program ?? '—'}</span>
				</p>
				<button
					type="button"
					class="rounded-lg bg-info px-4 py-2 text-sm font-semibold text-white transition hover:bg-info/90 disabled:cursor-not-allowed disabled:opacity-50"
					{disabled}
					aria-busy={controller.isPending('transition')}
					onclick={() => controller.transition()}
				>
					Take to air
				</button>
			</div>
		{/if}
	{/if}
</section>
