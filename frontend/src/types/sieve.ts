export type SieveConditionOp = 'contains' | 'is' | 'matches' | 'exists' | 'notcontains' | 'notis';

export interface SieveCondition {
  id: string;
  header: string; // e.g. Subject, From, To, custom header
  op: SieveConditionOp;
  value: string;
}

export type SieveActionType = 'fileinto' | 'redirect' | 'reject' | 'discard' | 'keep' | 'stop';

export interface SieveAction {
  id: string;
  type: SieveActionType;
  mailbox?: string; // fileinto
  address?: string; // redirect
  text?: string;    // reject
}

export interface SieveRule {
  id: string;
  name: string;
  enabled: boolean;
  conditionJoin: 'allof' | 'anyof';
  conditions: SieveCondition[];
  actions: SieveAction[];
}
