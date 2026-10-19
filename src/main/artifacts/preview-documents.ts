import { randomUUID } from 'node:crypto';

export const ARTIFACT_DOCUMENT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
/** Short-lived documents, never filesystem routes, credentials or an execution bridge. */
export class PreviewDocuments {
  private rows = new Map<string, { document: string; owner: string; expires: number; bytes: number }>();
  constructor(private now: () => number = Date.now) {}
  create(document: string, owner: string): string {
    const bytes = Buffer.byteLength(document);
    if (!bytes || bytes > 4 * 1024 * 1024) throw new Error('Preview document exceeds its size limit');
    this.sweep();
    while (this.rows.size >= 64 || [...this.rows.values()].reduce((total, row) => total + row.bytes, 0) + bytes > 16 * 1024 * 1024) this.rows.delete(this.rows.keys().next().value!);
    const id = randomUUID(); this.rows.set(id, { document, owner, bytes, expires: this.now() + 10 * 60_000 }); return id;
  }
  private sweep(): void { for (const [id, row] of this.rows) if (row.expires <= this.now()) this.rows.delete(id); }
  get(id: string): { document: string; owner: string } | null { this.sweep(); return this.rows.get(id) ?? null; }
  release(id: string, owner: string): void { if (this.rows.get(id)?.owner === owner) this.rows.delete(id); }
  clear(): void { this.rows.clear(); }
}
export const desktopPreviews = new PreviewDocuments();
