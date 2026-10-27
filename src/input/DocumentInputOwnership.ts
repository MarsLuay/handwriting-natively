import { getDebugNodeId } from "../dom/debugNodeId";

export interface DocumentInputOwner {
  host: HTMLElement;
  ownerId: string;
  sessionGeneration: number;
  registrationSource: string;
  onReplaced(reason: "replacement" | "released"): void;
}

export interface DocumentInputOwnershipOwnerSnapshot {
  collectorId: string;
  ownerId: string;
  sessionGeneration: number;
  registrationSource: string;
  hostDebugId: number | null;
  acquiredAt: number;
}

export interface DocumentInputOwnershipSnapshot {
  active: boolean;
  collectorId: string | null;
  ownerId: string | null;
  sessionGeneration: number | null;
  registrationSource: string | null;
  acquiredAt: number | null;
  owners: readonly DocumentInputOwnershipOwnerSnapshot[];
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

const ownershipByDocument = new WeakMap<Document, Map<HTMLElement, OwnershipEntry>>();
let nextCollectorId = 0;

/**
 * Input listeners are scoped to one viewer host. A replacement session revokes
 * only the prior owner of that same host; separate views in one Document
 * remain independent.
 */
export function acquireDocumentInputOwnership(
  document: Document,
  owner: DocumentInputOwner
): DocumentInputOwnershipHandle {
  let owners = ownershipByDocument.get(document);
  if (!owners) {
    owners = new Map();
    ownershipByDocument.set(document, owners);
  }
  const previous = owners.get(owner.host);
  if (previous) previous.owner.onReplaced("replacement");

  const entry: OwnershipEntry = {
    collectorId: `document-input-owner-${++nextCollectorId}`,
    owner,
    acquiredAt: Date.now()
  };
  owners.set(owner.host, entry);

  let released = false;
  return {
    collectorId: entry.collectorId,
    ownerId: owner.ownerId,
    isOwner: () => ownershipByDocument.get(document)?.get(owner.host) === entry,
    release: () => {
      if (released) return;
      released = true;
      const currentOwners = ownershipByDocument.get(document);
      if (currentOwners?.get(owner.host) !== entry) return;
      currentOwners.delete(owner.host);
      if (currentOwners.size === 0) ownershipByDocument.delete(document);
      owner.onReplaced("released");
    }
  };
}

/** With no host, return a document summary containing every current host owner. */
export function documentInputOwnershipSnapshot(
  document: Document,
  host?: HTMLElement
): DocumentInputOwnershipSnapshot {
  const owners = ownershipByDocument.get(document);
  const entries = host
    ? [owners?.get(host)].filter((entry): entry is OwnershipEntry => entry !== undefined)
    : [...(owners?.values() ?? [])];
  const ownerSnapshots = entries.map(({ collectorId, owner, acquiredAt }) => ({
    collectorId,
    ownerId: owner.ownerId,
    sessionGeneration: owner.sessionGeneration,
    registrationSource: owner.registrationSource,
    hostDebugId: getDebugNodeId(owner.host),
    acquiredAt
  }));
  const single = ownerSnapshots.length === 1 ? ownerSnapshots[0] : null;
  return {
    active: ownerSnapshots.length > 0,
    collectorId: single?.collectorId ?? null,
    ownerId: single?.ownerId ?? null,
    sessionGeneration: single?.sessionGeneration ?? null,
    registrationSource: single?.registrationSource ?? null,
    acquiredAt: single?.acquiredAt ?? null,
    owners: ownerSnapshots
  };
}
