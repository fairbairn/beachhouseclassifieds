export async function runWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) {
    return [];
  }

  const safeConcurrency = Number.isFinite(concurrency)
    ? Math.max(1, Math.floor(concurrency))
    : 1;
  const workerCount = Math.min(safeConcurrency, items.length);
  const output: TOutput[] = new Array(items.length);

  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      output[currentIndex] = await worker(
        items[currentIndex] as TInput,
        currentIndex,
      );
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return output;
}
