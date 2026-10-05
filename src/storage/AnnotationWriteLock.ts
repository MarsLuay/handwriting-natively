const annotationWriteLocks = new WeakMap<object, Map<string, Promise<unknown>>>();

/** Serialize every annotation-store operation for one vault/document pair. */
export async function withAnnotationWriteLock<T>(
  owner: object,
  documentKey: string,
  operation: () => Promise<T>
): Promise<T> {
  let locks = annotationWriteLocks.get(owner);
  if (!locks) {
    locks = new Map();
    annotationWriteLocks.set(owner, locks);
  }
  const previous = locks.get(documentKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  locks.set(documentKey, current);
  try {
    return await current;
  } finally {
    if (locks.get(documentKey) === current) locks.delete(documentKey);
    if (locks.size === 0) annotationWriteLocks.delete(owner);
  }
}
