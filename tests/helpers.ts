/** Polls `predicate` until it holds, so tests wait on state rather than on sleeps. */
export async function waitFor(
	predicate: () => boolean,
	{ timeoutMs = 5000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
	describe = 'condition'
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for ${describe}`);
}
