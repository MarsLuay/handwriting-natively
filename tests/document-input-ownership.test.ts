import { describe, expect, it, vi } from "vitest";
import {
  acquireDocumentInputOwnership,
  documentInputOwnershipSnapshot
} from "../src/input/DocumentInputOwnership";

const testHost = document.createElement("div");

function owner(
  ownerId: string,
  sessionGeneration: number,
  onReplaced: (reason: "replacement" | "released") => void,
  host: HTMLElement = testHost
) {
  return { host, ownerId, sessionGeneration, registrationSource: "test", onReplaced };
}

describe("document input ownership", () => {
  it("preempts an older session before the replacement can observe document input", () => {
    const firstRevoked = vi.fn();
    const secondRevoked = vi.fn();
    const first = acquireDocumentInputOwnership(document, owner("session-1", 1, firstRevoked));
    const second = acquireDocumentInputOwnership(document, owner("session-2", 2, secondRevoked));

    expect(firstRevoked).toHaveBeenCalledWith("replacement");
    expect(first.isOwner()).toBe(false);
    expect(second.isOwner()).toBe(true);
    expect(documentInputOwnershipSnapshot(document)).toMatchObject({
      active: true,
      collectorId: second.collectorId,
      ownerId: "session-2",
      sessionGeneration: 2,
      registrationSource: "test"
    });
    expect(secondRevoked).not.toHaveBeenCalled();
    second.release();
  });

  it("releases only the current owner and leaves no collector after teardown", () => {
    const firstRevoked = vi.fn();
    const secondRevoked = vi.fn();
    const first = acquireDocumentInputOwnership(document, owner("session-1", 1, firstRevoked));
    const second = acquireDocumentInputOwnership(document, owner("session-2", 2, secondRevoked));

    first.release();
    expect(second.isOwner()).toBe(true);
    expect(documentInputOwnershipSnapshot(document).active).toBe(true);

    second.release();
    expect(secondRevoked).toHaveBeenCalledWith("released");
    expect(documentInputOwnershipSnapshot(document)).toEqual({
      active: false,
      collectorId: null,
      ownerId: null,
      sessionGeneration: null,
      registrationSource: null,
      acquiredAt: null,
      owners: []
    });
  });

  it("revokes a repeated claim from the same owner so probes cannot duplicate", () => {
    const firstRevoked = vi.fn();
    const first = acquireDocumentInputOwnership(document, owner("session-1", 1, firstRevoked));
    const second = acquireDocumentInputOwnership(document, owner("session-1", 1, vi.fn()));

    expect(firstRevoked).toHaveBeenCalledWith("replacement");
    expect(first.isOwner()).toBe(false);
    expect(second.isOwner()).toBe(true);
    second.release();
  });

  it("keeps separate viewer hosts independent in one document", () => {
    const firstHost = document.createElement("div");
    const secondHost = document.createElement("div");
    const firstRevoked = vi.fn();
    const secondRevoked = vi.fn();
    const first = acquireDocumentInputOwnership(document, owner("session-a", 1, firstRevoked, firstHost));
    const second = acquireDocumentInputOwnership(document, owner("session-b", 1, secondRevoked, secondHost));

    expect(first.isOwner()).toBe(true);
    expect(second.isOwner()).toBe(true);
    expect(firstRevoked).not.toHaveBeenCalled();
    expect(documentInputOwnershipSnapshot(document).owners).toHaveLength(2);
    expect(documentInputOwnershipSnapshot(document, firstHost).ownerId).toBe("session-a");

    first.release();
    expect(first.isOwner()).toBe(false);
    expect(second.isOwner()).toBe(true);
    expect(documentInputOwnershipSnapshot(document).owners.map(({ ownerId }) => ownerId)).toEqual(["session-b"]);
    second.release();
  });
});
