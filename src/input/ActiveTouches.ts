export class ActiveTouches {
  private readonly touches = new Set<number>();

  public get size(): number {
    return this.touches.size;
  }

  public add(event: PointerEvent): void {
    if (event.pointerType !== "touch") return;
    this.touches.add(event.pointerId);

    // Primary down clears stale IDs left when terminal events were dropped
    // (common on iPad after pinch / drawer / modal transitions).
    if (event.isPrimary && this.touches.size > 1) {
      this.touches.clear();
      this.touches.add(event.pointerId);
    }
  }

  public delete(event: PointerEvent): void {
    if (event.pointerType !== "touch") return;
    this.touches.delete(event.pointerId);
  }

  public clear(): void {
    this.touches.clear();
  }
}
