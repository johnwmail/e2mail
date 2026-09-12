import { useEffect, useState } from 'react';
import { ScrollView, Share, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import { pgpApi } from '../../../src/api';
import { LabeledInput } from '../../../src/components/LabeledInput';
import { PrimaryButton } from '../../../src/components/PrimaryButton';
import { ScreenHeader } from '../../../src/components/ScreenHeader';
import { rememberPassphrase } from '../../../src/crypto/passphrase';
import { useT } from '../../../src/hooks/useT';
import { useAuthStore } from '../../../src/stores/useAuthStore';
import { useThemeTokens } from '../../../src/theme/useTheme';

export default function PgpSettingsScreen() {
  const colors = useThemeTokens();
  const t = useT();
  const session = useAuthStore((s) => s.session);
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [importArmored, setImportArmored] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactKey, setContactKey] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const keyQuery = useQuery({
    queryKey: ['pgp-keyring'],
    queryFn: () => pgpApi().fetchKeyringFromCloud(),
  });
  const contactsQuery = useQuery({
    queryKey: ['pgp-contact-keys'],
    queryFn: () => pgpApi().getContactKeys(),
  });

  useEffect(() => {
    if (session?.email && !name) setName(session.email.split('@')[0] || '');
  }, [name, session?.email]);

  const key = keyQuery.data ?? pgpApi().getKeyPair();

  const generate = async () => {
    if (!session?.email) return;
    setBusy(true);
    setMsg(null);
    try {
      await pgpApi().generateKey(name || 'User', session.email, passphrase || undefined);
      if (passphrase) await rememberPassphrase(passphrase);
      void queryClient.invalidateQueries({ queryKey: ['pgp-keyring'] });
      setMsg(t('pgp.generated'));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t('pgp.generateFailed', { error: String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const importKey = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await pgpApi().importPersonalKey(importArmored, undefined, passphrase || undefined);
      if (passphrase) await rememberPassphrase(passphrase);
      void queryClient.invalidateQueries({ queryKey: ['pgp-keyring'] });
      setMsg(t('pgp.importedPersonal', { userId: session?.email || '' }));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t('pgp.importPrivateFailed', { error: String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const pickKeyFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    const text = await fetch(res.assets[0].uri).then((r) => r.text());
    setImportArmored(text);
  };

  const lookup = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const armored = await pgpApi().fetchPublicKeyFromKeyserver(contactEmail);
      if (!armored) {
        setMsg(t('pgp.notOnKeyserver', { email: contactEmail }));
        return;
      }
      setContactKey(armored);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t('pgp.keyserverFailed', { error: String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const saveContact = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await pgpApi().saveContactKey(contactEmail, contactKey);
      void queryClient.invalidateQueries({ queryKey: ['pgp-contact-keys'] });
      setContactKey('');
      setMsg(t('pgp.importedKeys', { count: 1 }));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <ScreenHeader title={t('settings.pgp')} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {key ? (
          <>
            <Text style={{ color: colors.text, fontWeight: '700' }}>{key.userId}</Text>
            <Text selectable style={{ color: colors.textMuted }}>
              {key.fingerprint}
            </Text>
            <PrimaryButton
              label={t('pgp.copyPublic')}
              onPress={() => void Share.share({ message: key.publicKeyArmored })}
            />
            <PrimaryButton
              label={t('pgp.backupNow')}
              onPress={() => void pgpApi().syncKeyringToCloud(key)}
            />
          </>
        ) : (
          <Text style={{ color: colors.textMuted }}>{t('pgp.noCloudKey')}</Text>
        )}
        <LabeledInput label={t('pgp.keyName')} value={name} onChangeText={setName} />
        <LabeledInput label={t('pgp.passphrase')} value={passphrase} onChangeText={setPassphrase} secureTextEntry />
        <PrimaryButton label={t('pgp.generateNow')} onPress={() => void generate()} disabled={busy} />
        <LabeledInput label={t('pgp.pasteOrUpload')} value={importArmored} onChangeText={setImportArmored} multiline />
        <PrimaryButton label={t('pgp.chooseAsc')} onPress={() => void pickKeyFile()} />
        <PrimaryButton label={t('pgp.confirmImport')} onPress={() => void importKey()} disabled={busy} />

        <Text style={[styles.h, { color: colors.text }]}>{t('pgp.importContactTitle')}</Text>
        {(contactsQuery.data ?? []).map((c) => (
          <Text key={c.email} style={{ color: colors.text }}>
            {c.name || c.email} · {c.fingerprint?.slice(0, 8)}
          </Text>
        ))}
        <LabeledInput label={t('contacts.email')} value={contactEmail} onChangeText={setContactEmail} autoCapitalize="none" />
        <PrimaryButton label={t('pgp.searchKeyserver')} onPress={() => void lookup()} disabled={busy} />
        <LabeledInput label={t('contacts.pgpKeyPlaceholder')} value={contactKey} onChangeText={setContactKey} multiline />
        <PrimaryButton label={t('common.save')} onPress={() => void saveContact()} disabled={busy} />
        {msg ? <Text style={{ color: colors.text }}>{msg}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  h: { fontSize: 16, fontWeight: '700', marginTop: 8 },
});
