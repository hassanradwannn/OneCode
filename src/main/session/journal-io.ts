/** Retry only an OS open that failed before any journal bytes could be written. */
import { promises as fs } from 'node:fs';

const blocked = (error: unknown): error is NodeJS.ErrnoException => {
  const value = error as NodeJS.ErrnoException;
  return value?.syscall === 'open' && ['EPERM', 'EACCES', 'EBUSY'].includes(value.code ?? '');
};

async function opening<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!blocked(error)) throw error;
      if (attempt >= 3) {
        const failure = new Error(`Session history is inaccessible (${error.code}). OneCode preserved the journal. Check file access or security-software alerts, then reload this chat. An unconfirmed message or tool must not be resent automatically.`, { cause: error });
        Object.assign(failure, { code: error.code, syscall: error.syscall });
        throw failure;
      }
      await new Promise(resolve => setTimeout(resolve, [40, 120, 300][attempt]));
    }
  }
}

export function openJournal(file: string): Promise<Awaited<ReturnType<typeof fs.open>>> {
  return opening(() => fs.open(file, 'r'));
}

export function appendJournal(file: string, line: string): Promise<void> {
  // appendFile reports syscall=open only when acquiring its handle failed. A write/close
  // error is an uncertain commit and goes directly to the store's tail reconciliation.
  return opening(() => fs.appendFile(file, line, 'utf8'));
}
