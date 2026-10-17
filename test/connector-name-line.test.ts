import { describe, expect, it } from 'vitest';
import { chatgptNameLine } from '../src/renderer/connector-name.js';

// A connector renamed in Gemini keeps working (app ID, 2026-10-11). The Setup card still tells the
// user the configured name to type, and adds one line with what Gemini calls it now.
describe('the Setup card line for a renamed connector', () => {
  it('names the connector as Gemini shows it when that differs from the configured name', () => {
    expect(chatgptNameLine({ connectorName: 'OneCode Core', chatgptName: 'My tools' })).toBe('In provider: My tools');
  });
  it('adds nothing when Gemini uses the configured name or nothing was learned', () => {
    expect(chatgptNameLine({ connectorName: 'OneCode Core', chatgptName: 'OneCode Core' })).toBeNull();
    expect(chatgptNameLine({ connectorName: 'OneCode Core', chatgptName: null })).toBeNull();
    expect(chatgptNameLine({ connectorName: 'OneCode Core' })).toBeNull();
  });
});
