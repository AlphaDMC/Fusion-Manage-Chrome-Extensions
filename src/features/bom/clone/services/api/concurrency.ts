export async function mapWithConcurrency<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  iteratee: (value: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
  const size = Math.max(1, Math.floor(concurrency))
  const results = new Array<TOutput>(values.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const current = nextIndex
      nextIndex += 1
      results[current] = await iteratee(values[current], current)
    }
  }

  await Promise.all(Array.from({ length: Math.min(size, values.length) }, () => worker()))
  return results
}
