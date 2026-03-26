export function createClientGuard(options: {
  reportClientGuardError: (error: unknown) => void;
  reportClientGuardRecovered: () => void;
}) {
  async function guarded<T>(operation: Promise<T> | (() => Promise<T>)) {
    try {
      const result = await (typeof operation === "function"
        ? operation()
        : operation);
      options.reportClientGuardRecovered();
      return result;
    } catch (error) {
      options.reportClientGuardError(error);
      throw error;
    }
  }

  function clientGuard<T>(operation: Promise<T>): Promise<T>;
  function clientGuard<T>(operation: () => Promise<T>): Promise<T>;
  function clientGuard<T>(operation: Promise<T> | (() => Promise<T>)) {
    return guarded(operation);
  }

  return {
    clientGuard,
  };
}
