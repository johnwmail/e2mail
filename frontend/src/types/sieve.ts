export type SieveTestType = 'header' | 'address' | 'exists' | 'true';

export type SieveAddressPart = '' | 'domain' | 'localpart' | 'user';

export type SieveConditionOp = 'contains' | 'is' | 'matches';

export interface SieveCondition {
  id: string;
  test: SieveTestType;
  part: SieveAddressPart; // 僅 address（或 header 用不上）
  op: SieveConditionOp;
  negated: boolean; // not 修飾
  header: string; // 逗號分隔多個標頭（header/address/exists）
  value: string;
}

export type SieveActionType =
  | 'fileinto'
  | 'redirect'
  | 'reject'
  | 'discard'
  | 'keep'
  | 'stop'
  | 'setflag'
  | 'addflag'
  | 'removeflag';

export interface SieveAction {
  id: string;
  type: SieveActionType;
  mailbox?: string; // fileinto（逗號分隔多個）
  copy?: boolean; // fileinto :copy
  address?: string; // redirect
  text?: string; // reject
  flag?: string; // setflag/addflag/removeflag（逗號分隔，如 \Seen）
}

export interface SieveRule {
  id: string;
  name: string;
  enabled: boolean;
  conditionJoin: 'allof' | 'anyof';
  conditions: SieveCondition[];
  actions: SieveAction[];
}
