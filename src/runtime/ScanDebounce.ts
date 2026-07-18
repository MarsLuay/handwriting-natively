/**
 * Debounce helper that keeps the soonest pending wake-up.
 * A later request does not postpone an earlier one; an earlier request
 * replaces a later one.
 */
export class ScanDebounce {
  private timer: number | null = null;
  private dueAt = 0;

  get pending(): boolean {
    return this.timer !== null;
  }

  schedule(delayMs: number, fire: () => void, now = Date.now()): void {
    const wait = Math.max(0, delayMs);
    const dueAt = now + wait;
    if (this.timer !== null) {
      if (dueAt >= this.dueAt) return;
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.dueAt = dueAt;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.dueAt = 0;
      fire();
    }, wait);
  }

  clear(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.dueAt = 0;
  }
}
