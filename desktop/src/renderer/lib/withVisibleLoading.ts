/** Let the browser paint a loading spinner before heavy synchronous work (web build). */
async function waitForPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * Show loading state long enough for the spinner to render and animate.
 * On web, scheduler runs synchronously in the main thread — without a minimum
 * duration, isRunning can flip before the first paint.
 */
export async function withVisibleLoading<T>(
  setLoading: (loading: boolean) => void,
  fn: () => Promise<T>,
  minVisibleMs = 450
): Promise<T> {
  setLoading(true);
  await waitForPaint();
  const started = Date.now();
  try {
    return await fn();
  } finally {
    const remaining = minVisibleMs - (Date.now() - started);
    if (remaining > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    }
    setLoading(false);
  }
}
