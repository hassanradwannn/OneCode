/** Catch an unchanged terminal refusal loop, while allowing output pages to make progress. */
export class ApiRefusalWatch {
  private previous = '';
  private repeats = 0;
  private step: number | undefined;
  observe(text: string, step?: number): { guidance: string; stalled: boolean } {
    // Parallel proposals from one response have not seen each other's results yet.
    if (step !== undefined && step === this.step) return { guidance: '', stalled: false };
    this.step = step;
    if (!text.includes('EXEC_RESULTS_UNREAD:')) { this.previous = ''; this.repeats = 0; return { guidance: '', stalled: false }; }
    this.repeats = text === this.previous ? this.repeats + 1 : 1;
    this.previous = text;
    return { guidance: this.repeats >= 3
      ? '\nOneCode recovery: this same refusal has repeated without new output. Stop issuing PING/probe commands. Read the listed completed results with write_stdin and inspect their output. A running process is separate; use its exact owned process ID to poll or interrupt it when appropriate. This is result delivery, not revoked command permission. Do not repeat completed task actions.' : '',
      stalled: this.repeats >= 8 };
  }
}
