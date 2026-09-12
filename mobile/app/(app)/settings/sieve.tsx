import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  rulesToSieve,
  sieveToRules,
  type SieveActionType,
  type SieveRule,
  type SieveTestType,
} from '@e2mail/shared';
import { mailApi, sieveApi } from '../../../src/api';
import { ChoiceChips } from '../../../src/components/ChoiceChips';
import { LabeledInput } from '../../../src/components/LabeledInput';
import { PrimaryButton } from '../../../src/components/PrimaryButton';
import { ScreenHeader } from '../../../src/components/ScreenHeader';
import { useT } from '../../../src/hooks/useT';
import { newAction, newCondition, newRule } from '../../../src/settings/sieveDraft';
import { useAuthStore } from '../../../src/stores/useAuthStore';
import { useMailboxStore } from '../../../src/stores/useMailboxStore';
import { useThemeTokens } from '../../../src/theme/useTheme';

export default function SieveScreen() {
  const colors = useThemeTokens();
  const t = useT();
  const accounts = useAuthStore((s) => s.session?.accounts ?? []);
  const accountId = useMailboxStore((s) => s.activeAccountId) || accounts[0]?.id || '';
  const setAccount = useMailboxStore((s) => s.setActiveAccountId);
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState('');
  const [newName, setNewName] = useState('');
  const [rules, setRules] = useState<SieveRule[]>([]);
  const [raw, setRaw] = useState('');
  const [rawMode, setRawMode] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const scriptsQuery = useQuery({
    queryKey: ['sieveScripts', accountId],
    queryFn: () => sieveApi().list(accountId),
    enabled: !!accountId,
    retry: false,
  });
  const contentQuery = useQuery({
    queryKey: ['sieveScript', accountId, selected],
    queryFn: () => sieveApi().get(selected, accountId),
    enabled: !!accountId && !!selected,
  });
  const foldersQuery = useQuery({
    queryKey: ['folders', accountId],
    queryFn: () => mailApi().getFolders(accountId),
    enabled: !!accountId,
  });
  const folderNames = (foldersQuery.data ?? []).map((f) => f.name);

  useEffect(() => {
    const scripts = scriptsQuery.data ?? [];
    if (!scripts.length) {
      setSelected('');
      return;
    }
    if (!selected || !scripts.some((s) => s.name === selected)) {
      const active = scripts.find((s) => s.active);
      setSelected(active ? active.name : scripts[0].name);
    }
  }, [scriptsQuery.data, selected]);

  useEffect(() => {
    const content = contentQuery.data?.content ?? '';
    setRaw(content);
    const parsed = content ? sieveToRules(content) : [];
    if (parsed) {
      setRules(parsed);
      setRawMode(false);
    } else {
      setRules([]);
      setRawMode(true);
    }
  }, [contentQuery.data]);

  const save = async (activate: boolean) => {
    const body = rawMode ? raw : rulesToSieve(rules);
    try {
      await sieveApi().put(selected, body, accountId);
      if (activate) await sieveApi().activate(selected, accountId);
      void queryClient.invalidateQueries({ queryKey: ['sieveScripts', accountId] });
      void queryClient.invalidateQueries({ queryKey: ['sieveScript', accountId, selected] });
      setMsg(activate ? t('sieve.savedReload') : t('sieve.saved'));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t('sieve.saveFailed'));
    }
  };

  const createScript = async () => {
    const name = newName.trim();
    if (!name) return;
    await sieveApi().put(name, rulesToSieve([newRule(t('sieve.ruleN', { n: 1 }))]), accountId);
    setNewName('');
    setSelected(name);
    void queryClient.invalidateQueries({ queryKey: ['sieveScripts', accountId] });
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <ScreenHeader title={t('settings.sieve')} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {accounts.length > 1 ? (
          <ChoiceChips
            value={accountId}
            options={accounts.map((a) => ({ id: a.id, label: a.label || a.email }))}
            onChange={setAccount}
          />
        ) : null}
        {(scriptsQuery.data ?? []).map((s) => (
          <Pressable
            key={s.name}
            accessibilityRole="button"
            accessibilityState={{ selected: s.name === selected }}
            onPress={() => setSelected(s.name)}
            style={[styles.row, { borderColor: s.name === selected ? colors.primary : colors.border }]}
          >
            <Text style={{ color: colors.text }}>
              {s.name}
              {s.active ? ` · ${t('sieve.active')}` : ''}
            </Text>
          </Pressable>
        ))}
        <LabeledInput label={t('sieve.new')} value={newName} onChangeText={setNewName} />
        <PrimaryButton label={t('sieve.create')} onPress={() => void createScript()} />
        {selected ? (
          <>
            <PrimaryButton
              label={t('sieve.setActive')}
              onPress={() =>
                void sieveApi()
                  .activate(selected, accountId)
                  .then(() => queryClient.invalidateQueries({ queryKey: ['sieveScripts', accountId] }))
                  .catch((err) => setMsg(err instanceof Error ? err.message : t('sieve.activateFailed', { error: String(err) })))
              }
            />
            <PrimaryButton
              label={t('sieve.deactivate')}
              onPress={() =>
                void sieveApi()
                  .deactivate(accountId)
                  .then(() => queryClient.invalidateQueries({ queryKey: ['sieveScripts', accountId] }))
                  .catch((err) => setMsg(err instanceof Error ? err.message : t('sieve.activateFailed', { error: String(err) })))
              }
            />
            <PrimaryButton
              label={t('sieve.checkSyntax')}
              onPress={() => {
                const body = rawMode ? raw : rulesToSieve(rules);
                void sieveApi()
                  .check(body, accountId)
                  .then((res) => setMsg(res.message || t('sieve.syntaxOk')))
                  .catch((err) => setMsg(err instanceof Error ? err.message : t('sieve.syntaxBad')));
              }}
            />
            <PrimaryButton
              label={t('sieve.deleteTitle')}
              danger
              onPress={() => {
                Alert.alert(t('sieve.deleteTitle'), t('sieve.deleteConfirm', { name: selected }), [
                  { text: t('common.cancel'), style: 'cancel' },
                  {
                    text: t('common.delete'),
                    style: 'destructive',
                    onPress: () => {
                      void sieveApi()
                        .remove(selected, accountId)
                        .then(() => queryClient.invalidateQueries({ queryKey: ['sieveScripts', accountId] }));
                    },
                  },
                ]);
              }}
            />
            <ChoiceChips
              value={rawMode ? 'source' : 'rules'}
              options={[
                { id: 'rules', label: t('sieve.rulesMode') },
                { id: 'source', label: t('sieve.sourceMode') },
              ]}
              onChange={(id) => setRawMode(id === 'source')}
            />
            {rawMode ? (
              <TextInput
                accessibilityLabel={t('sieve.sourceMode')}
                multiline
                value={raw}
                onChangeText={setRaw}
                style={[styles.raw, { color: colors.text, borderColor: colors.border, backgroundColor: colors.bgMuted }]}
              />
            ) : (
              <>
                <PrimaryButton label={t('sieve.addRule')} onPress={() => setRules((r) => [...r, newRule(t('sieve.ruleN', { n: r.length + 1 }))])} />
                {rules.map((rule) => (
                  <View key={rule.id} style={[styles.card, { borderColor: colors.border }]}>
                    <LabeledInput label={t('sieve.ruleName')} value={rule.name} onChangeText={(v) => setRules((rs) => rs.map((r) => (r.id === rule.id ? { ...r, name: v } : r)))} />
                    <View style={styles.switchRow}>
                      <Text style={{ color: colors.text, flex: 1 }}>{t('sieve.enabled')}</Text>
                      <Switch
                        value={rule.enabled}
                        onValueChange={(v) => setRules((rs) => rs.map((r) => (r.id === rule.id ? { ...r, enabled: v } : r)))}
                      />
                    </View>
                    <ChoiceChips
                      value={rule.conditionJoin}
                      options={[
                        { id: 'allof', label: t('sieve.allConditions') },
                        { id: 'anyof', label: t('sieve.anyCondition') },
                      ]}
                      onChange={(join) =>
                        setRules((rs) =>
                          rs.map((r) => (r.id === rule.id ? { ...r, conditionJoin: join as SieveRule['conditionJoin'] } : r))
                        )
                      }
                    />
                    {rule.conditions.map((c) => (
                      <View key={c.id} style={{ gap: 6 }}>
                        <ChoiceChips
                          value={c.test}
                          options={[
                            { id: 'header', label: 'header' },
                            { id: 'address', label: 'address' },
                            { id: 'exists', label: 'exists' },
                            { id: 'true', label: 'true' },
                          ]}
                          onChange={(test) =>
                            setRules((rs) =>
                              rs.map((r) =>
                                r.id === rule.id
                                  ? {
                                      ...r,
                                      conditions: r.conditions.map((x) =>
                                        x.id === c.id ? { ...x, test: test as SieveTestType } : x
                                      ),
                                    }
                                  : r
                              )
                            )
                          }
                        />
                        <LabeledInput
                          label={t('sieve.header')}
                          value={c.header}
                          onChangeText={(v) =>
                            setRules((rs) =>
                              rs.map((r) =>
                                r.id === rule.id
                                  ? { ...r, conditions: r.conditions.map((x) => (x.id === c.id ? { ...x, header: v } : x)) }
                                  : r
                              )
                            )
                          }
                        />
                        <LabeledInput
                          label={t('sieve.matchValue')}
                          value={c.value}
                          onChangeText={(v) =>
                            setRules((rs) =>
                              rs.map((r) =>
                                r.id === rule.id
                                  ? { ...r, conditions: r.conditions.map((x) => (x.id === c.id ? { ...x, value: v } : x)) }
                                  : r
                              )
                            )
                          }
                        />
                      </View>
                    ))}
                    <PrimaryButton
                      label={t('sieve.addCondition')}
                      onPress={() =>
                        setRules((rs) => rs.map((r) => (r.id === rule.id ? { ...r, conditions: [...r.conditions, newCondition()] } : r)))
                      }
                    />
                    {rule.actions.map((a) => (
                      <View key={a.id} style={{ gap: 6 }}>
                        <ChoiceChips
                          value={a.type}
                          options={[
                            { id: 'fileinto', label: t('sieve.fileinto') },
                            { id: 'redirect', label: t('sieve.redirect') },
                            { id: 'discard', label: t('sieve.discard') },
                            { id: 'keep', label: t('sieve.keep') },
                            { id: 'stop', label: t('sieve.stop') },
                          ]}
                          onChange={(type) =>
                            setRules((rs) =>
                              rs.map((r) =>
                                r.id === rule.id
                                  ? {
                                      ...r,
                                      actions: r.actions.map((x) =>
                                        x.id === a.id ? { ...x, type: type as SieveActionType } : x
                                      ),
                                    }
                                  : r
                              )
                            )
                          }
                        />
                        {a.type === 'fileinto' ? (
                          <>
                            <LabeledInput
                              label={t('sieve.fileinto')}
                              value={a.mailbox || ''}
                              onChangeText={(v) =>
                                setRules((rs) =>
                                  rs.map((r) =>
                                    r.id === rule.id
                                      ? { ...r, actions: r.actions.map((x) => (x.id === a.id ? { ...x, mailbox: v } : x)) }
                                      : r
                                  )
                                )
                              }
                            />
                            <Text style={{ color: colors.textMuted, fontSize: 12 }}>{folderNames.slice(0, 8).join(', ')}</Text>
                          </>
                        ) : null}
                        {a.type === 'redirect' ? (
                          <LabeledInput
                            label={t('sieve.redirect')}
                            value={a.address || ''}
                            onChangeText={(v) =>
                              setRules((rs) =>
                                rs.map((r) =>
                                  r.id === rule.id
                                    ? { ...r, actions: r.actions.map((x) => (x.id === a.id ? { ...x, address: v } : x)) }
                                    : r
                                )
                              )
                            }
                          />
                        ) : null}
                      </View>
                    ))}
                    <PrimaryButton
                      label={t('sieve.addAction')}
                      onPress={() =>
                        setRules((rs) => rs.map((r) => (r.id === rule.id ? { ...r, actions: [...r.actions, newAction()] } : r)))
                      }
                    />
                  </View>
                ))}
              </>
            )}
            <PrimaryButton label={t('common.save')} onPress={() => void save(false)} />
            <PrimaryButton label={t('sieve.saveAndActivate')} onPress={() => void save(true)} />
          </>
        ) : (
          <Text style={{ color: colors.textMuted }}>{t('sieve.empty')}</Text>
        )}
        {msg ? <Text style={{ color: colors.text }}>{msg}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { padding: 16, gap: 10, paddingBottom: 48 },
  row: { borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 44, justifyContent: 'center' },
  card: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 10 },
  switchRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  raw: { minHeight: 180, borderWidth: 1, borderRadius: 8, padding: 12, textAlignVertical: 'top', fontFamily: 'monospace' },
});
