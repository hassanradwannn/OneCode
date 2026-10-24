/** Retry only an OS open that failed before any journal bytes could be written. */
import { promises as fs } from 'node:fs';

/** A storage failure is neither missing history nor revoked task authority. */
export class SessionHistoryUnavailable extends Error {
  readonly code: string;
  readonly syscall: string;
  readonly path: string;
  constructor(file: string, error: NodeJS.ErrnoException) {
    super(`Session history is inaccessible (${error.code}). OneCode preserved the journal. Check file access or security-software alerts, then reload this chat. An unconfirmed message or tool must not be resent automatically.`, { cause: error });
    this.name = 'SessionHistoryUnavailable';
    this.code = error.code!; this.syscall = error.syscall!; this.path = file;
  }
}

export function sessionHistoryUnavailable(error: unknown): error is SessionHistoryUnavailable {
  return error instanceof SessionHistoryUnavailable;
}

const blocked = (error: unknown): error is NodeJS.ErrnoException => {
  const value = error as NodeJS.ErrnoException;
  return value?.syscall === 'open' && ['EPERM', 'EACCES', 'EBUSY'].includes(value.code ?? '');
};

async function opening<T>(file: string, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!blocked(error)) throw error;
      if (attempt >= 3) {
        throw new SessionHistoryUnavailable(file, error);
      }
      await new Promise(resolve => setTimeout(resolve, [40, 120, 300][attempt]));
    }
  }
}

export function openJournal(file: string): Promise<Awaited<ReturnType<typeof fs.open>>> {
  return opening(file, () => fs.open(file, 'r'));
}

export function appendJournal(file: string, line: string): Promise<void> {
  // appendFile reports syscall=open only when acquiring its handle failed. A write/close
  // error is an uncertain commit and goes directly to the store's tail reconciliation.
  return opening(file, () => fs.appendFile(file, line, 'utf8'));
}
