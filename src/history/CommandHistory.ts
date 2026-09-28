export interface Command {
  readonly label?: string;
  execute(): void;
  undo(): void;
}

export type HistoryChangeAction = "execute" | "undo" | "redo";
export type HistoryChange = (command: Command, action: HistoryChangeAction) => void;

export class CommandHistory {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  constructor(private readonly changed?: HistoryChange) {}

  execute(command: Command): void { command.execute(); this.undoStack.push(command); this.redoStack = []; this.changed?.(command, "execute"); }
  undo(): boolean {
    const command = this.undoStack.pop(); if (!command) return false;
    command.undo(); this.redoStack.push(command); this.changed?.(command, "undo"); return true;
  }
  redo(): boolean {
    const command = this.redoStack.pop(); if (!command) return false;
    command.execute(); this.undoStack.push(command); this.changed?.(command, "redo"); return true;
  }
  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
  clear(): void { this.undoStack = []; this.redoStack = []; }
}

