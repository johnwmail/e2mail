import { newRule } from './sieveDraft';

describe('sieveDraft', () => {
  it('creates an enabled header/fileinto rule', () => {
    const rule = newRule('Rule 1');
    expect(rule.enabled).toBe(true);
    expect(rule.conditions[0].header).toBe('Subject');
    expect(rule.actions[0].type).toBe('fileinto');
  });
});
