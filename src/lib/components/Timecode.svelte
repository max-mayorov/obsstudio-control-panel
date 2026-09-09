<script lang="ts">
	import { formatDuration } from '$lib/client/format';

	let { ms, dimmed = false }: { ms: number; dimmed?: boolean } = $props();

	const parts = $derived(formatDuration(ms));
</script>

<!--
	tabular-nums stops the digits from shifting width as they change, which is what makes
	a running clock feel stable rather than twitchy.
-->
<p
	class="font-mono text-5xl leading-none font-semibold tracking-tight tabular-nums transition-colors sm:text-6xl {dimmed
		? 'text-faint'
		: 'text-ink'}"
	aria-label="Recording duration"
>
	{parts.hms}<span class="text-2xl text-muted sm:text-3xl">.{parts.tenths}</span>
</p>
