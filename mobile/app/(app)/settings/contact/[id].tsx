import { useEffect, useState } from 'react';
import { Alert, Image, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import { arrayBufferToBase64, contactsApi, pgpApi, uploadContactAvatar } from '../../../../src/api';
import { LabeledInput } from '../../../../src/components/LabeledInput';
import { PrimaryButton } from '../../../../src/components/PrimaryButton';
import { ScreenHeader } from '../../../../src/components/ScreenHeader';
import { useT } from '../../../../src/hooks/useT';
import { useThemeTokens } from '../../../../src/theme/useTheme';

export default function ContactEditScreen() {
  const colors = useThemeTokens();
  const t = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const queryClient = useQueryClient();
  const existing = useQuery({
    queryKey: ['contact', id],
    queryFn: () => contactsApi().get(id),
    enabled: !isNew,
  });
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [note, setNote] = useState('');
  const [pgp, setPgp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [avatarUri, setAvatarUri] = useState<string | null>(null);

  useEffect(() => {
    if (!existing.data) return;
    setEmail(existing.data.email);
    setDisplayName(existing.data.displayName);
    setNote(existing.data.note || '');
  }, [existing.data]);

  useEffect(() => {
    if (isNew || !existing.data?.hasAvatar) {
      setAvatarUri(null);
      return;
    }
    void contactsApi()
      .fetchAvatarBlob(id)
      .then(async (blob) => {
        if (!blob) return;
        const b64 = await arrayBufferToBase64(await blob.arrayBuffer());
        setAvatarUri(`data:image/jpeg;base64,${b64}`);
      })
      .catch(() => undefined);
  }, [existing.data?.hasAvatar, id, isNew]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = isNew
        ? await contactsApi().create({ email, displayName, note })
        : await contactsApi().update(id, { email, displayName, note });
      if (pgp.trim()) {
        await pgpApi().saveContactKey(saved.email, pgp.trim(), displayName);
      }
      void queryClient.invalidateQueries({ queryKey: ['contacts'] });
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('contacts.addFailed', { error: String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const lookup = async () => {
    setBusy(true);
    setError(null);
    try {
      const armored = await pgpApi().fetchPublicKeyFromKeyserver(email);
      if (!armored) {
        setError(t('pgp.notOnKeyserver', { email }));
        return;
      }
      setPgp(armored);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pgp.keyserverFailed', { error: String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const pickAvatar = async () => {
    if (isNew) return;
    const res = await DocumentPicker.getDocumentAsync({ type: 'image/*', copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    await uploadContactAvatar(id, {
      uri: asset.uri,
      name: asset.name || 'avatar.jpg',
      type: asset.mimeType || 'image/jpeg',
    });
    void queryClient.invalidateQueries({ queryKey: ['contact', id] });
  };

  const remove = () => {
    Alert.alert(t('contacts.deleteTitle'), t('contacts.deleteConfirm', { name: displayName || email }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          void contactsApi()
            .remove(id)
            .then(() => pgpApi().removeContactKey(email).catch(() => undefined))
            .then(() => {
              void queryClient.invalidateQueries({ queryKey: ['contacts'] });
              router.back();
            });
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <ScreenHeader title={isNew ? t('contacts.addContact') : t('contacts.editContact')} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {avatarUri ? (
          <Image
            accessibilityLabel={t('contacts.uploadAvatar')}
            source={{ uri: avatarUri }}
            style={styles.avatar}
          />
        ) : null}
        <LabeledInput label={t('contacts.email')} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
        <LabeledInput label={t('contacts.displayName')} value={displayName} onChangeText={setDisplayName} />
        <LabeledInput label={t('contacts.notes')} value={note} onChangeText={setNote} multiline />
        <LabeledInput label={t('contacts.pgpKeyPlaceholder')} value={pgp} onChangeText={setPgp} multiline />
        <PrimaryButton label={t('pgp.searchKeyserver')} onPress={() => void lookup()} disabled={busy} />
        {!isNew ? <PrimaryButton label={t('contacts.uploadAvatar')} onPress={() => void pickAvatar()} /> : null}
        {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
        <PrimaryButton label={t('common.save')} onPress={() => void save()} disabled={busy} />
        {!isNew ? <PrimaryButton label={t('contacts.deleteContact')} danger onPress={remove} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  avatar: { width: 72, height: 72, borderRadius: 36, alignSelf: 'center' },
});
