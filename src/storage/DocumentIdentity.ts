import type { SidecarDocumentIdentity } from "./SidecarSchema";

export interface DocumentIdentityInput {
  vaultPath: string;
  fingerprint?: string;
  contentHash?: string;
  /** Paths that are explicitly known to be prior locations of this document. */
  legacyPaths?: readonly string[];
}

export type DocumentIdentitySource = "content" | "fingerprint" | "path";

export interface DocumentIdentityCandidate {
  identity: SidecarDocumentIdentity;
  source: DocumentIdentitySource;
  /** True when this candidate is only retained for pre-content sidecars. */
  legacy: boolean;
}

export function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

function fnv1a64Bytes(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function normalizedToken(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

/** Hash PDF bytes locally when the host can provide them without another read. */
export function hashDocumentContent(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return fnv1a64Bytes(bytes);
}

export function documentIdentitySource(input: DocumentIdentityInput): DocumentIdentitySource {
  if (normalizedToken(input.contentHash)) return "content";
  if (normalizedToken(input.fingerprint)) return "fingerprint";
  return "path";
}

/** The path identity used by releases before content identity was available. */
export function createLegacyPathIdentity(vaultPath: string): SidecarDocumentIdentity {
  const normalizedPath = normalizeVaultPath(vaultPath);
  return {
    id: `pdf-${fnv1a64Bytes(new TextEncoder().encode(`path:${normalizedPath}`))}`,
    vaultPath: normalizedPath
  };
}

export function createDocumentIdentity(input: DocumentIdentityInput): SidecarDocumentIdentity {
  const vaultPath = normalizeVaultPath(input.vaultPath);
  const contentHash = normalizedToken(input.contentHash);
  const fingerprint = normalizedToken(input.fingerprint);
  const stableSource = contentHash
    ? `content:${contentHash}`
    : fingerprint ? `fingerprint:${fingerprint}` : `path:${vaultPath}`;
  return {
    id: `pdf-${fnv1a64Bytes(new TextEncoder().encode(stableSource))}`,
    vaultPath,
    ...(fingerprint === undefined ? {} : { fingerprint }),
    ...(contentHash === undefined ? {} : { contentHash })
  };
}

/**
 * Return lookup keys from strongest to weakest. The path candidate is kept as
 * an explicit legacy fallback, never as a replacement for content identity.
 */
export function documentIdentityCandidates(input: DocumentIdentityInput): DocumentIdentityCandidate[] {
  const candidates: DocumentIdentityCandidate[] = [];
  const add = (identity: SidecarDocumentIdentity, source: DocumentIdentitySource, legacy: boolean): void => {
    if (candidates.some((candidate) => candidate.identity.id === identity.id)) return;
    candidates.push({ identity, source, legacy });
  };
  const source = documentIdentitySource(input);
  const fingerprint = normalizedToken(input.fingerprint);
  add(createDocumentIdentity(input), source, source === "path");
  if (source === "content" && fingerprint !== undefined) {
    add(createDocumentIdentity({ vaultPath: input.vaultPath, fingerprint }), "fingerprint", true);
  }
  const legacyPaths = [input.vaultPath, ...(input.legacyPaths ?? [])];
  for (const path of legacyPaths) add(createLegacyPathIdentity(path), "path", true);
  return candidates;
}

