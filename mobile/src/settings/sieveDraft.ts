import type { SieveAction, SieveCondition, SieveRule } from '@e2mail/shared';

const uid = () => Math.random().toString(36).slice(2, 10);

export function newCondition(): SieveCondition {
  return {
    id: uid(),
    test: 'header',
    part: '',
    op: 'contains',
    negated: false,
    header: 'Subject',
    value: '',
  };
}

export function newAction(): SieveAction {
  return { id: uid(), type: 'fileinto', mailbox: 'INBOX' };
}

export function newRule(name: string): SieveRule {
  return {
    id: uid(),
    name,
    enabled: true,
    conditionJoin: 'allof',
    conditions: [newCondition()],
    actions: [newAction()],
  };
}
