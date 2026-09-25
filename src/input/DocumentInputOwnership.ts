export interface DocumentInputOwner {
  ownerId: string;
  sessionGeneration: number;
  registrationSource: string;
  onReplaced(reason: "replacement" | "released"): void;
}

export interface DocumentInputOwnershipSnapshot {
  active: boolean;
  collectorId: string | null;
  ownerId: string | null;
  sessionGeneration: number | null;
  registrationSource: string | null;
  acquiredAt: number | null;
}

export interface DocumentInputOwnershipHandle {
  collectorId: string;
  ownerId: string;
  isOwner(): boolean;
  release(): void;
}

interface OwnershipEntry {
  readonly collectorId: string;
  readonly owner: DocumentInputOwner;
  readonly acquiredAt: number;
}

const ownershipByDocument = new WeakMap<Document, OwnershipEntry>();
let nextCollectorId = 0;

/**
 * A PDF document can temporarily have overlapping sessions during a native
 * viewer replacement. Only the newest session may own document-level input
 * probes; replacing the owner synchronously revokes the previous listeners.
 */
export function acquireDocumentInputOwnership(
  document: Document,
  owner: DocumentInputOwner
): DocumentInputOwnershipHandle {
  const previous = ownershipByDocument.get(document);
  if (previous) {
    previous.owner.onReplaced("replacement");
  }

  const entry: OwnershipEntry = {
    collectorId: `document-input-collector-${++nextCollectorId}`,
    owner,
    acquiredAt: Date.now()
  };
  ownershipByDocument.set(document, entry);

  let released = false;
  return {
    collectorId: entry.collectorId,
    ownerId: owner.ownerId,
    isOwner: () => ownershipByDocument.get(document) === entry,
    release: () => {
      if (released) return;
      released = true;
      if (ownershipByDocument.get(document) !== entry) return;
      ownershipByDocument.delete(document);
      owner.onReplaced("released");
    }
  };
}

export function documentInputOwnershipSnapshot(document: Document): DocumentInputOwnershipSnapshot {
  const entry = ownershipByDocument.get(document);
  if (!entry) {
    return {
      active: false,
      collectorId: null,
      ownerId: null,
      sessionGeneration: null,
      registrationSource: null,
      acquiredAt: null
    };
  }
  return {
    active: true,
    collectorId: entry.collectorId,
    ownerId: entry.owner.ownerId,
    sessionGeneration: entry.owner.sessionGeneration,
    registrationSource: entry.owner.registrationSource,
    acquiredAt: entry.acquiredAt
  };
}
