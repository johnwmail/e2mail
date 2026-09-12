import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { contactsApi, importContactsFile } from '../../../src/api';
import { LabeledInput } from '../../../src/components/LabeledInput';
import { PrimaryButton } from '../../../src/components/PrimaryButton';
import { ScreenHeader } from '../../../src/components/ScreenHeader';
import { useT } from '../../../src/hooks/useT';
import { useThemeTokens } from '../../../src/theme/useTheme';

export default function ContactsListScreen() {
  const colors = useThemeTokens();
  const t = useT();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const query = useQuery({
    queryKey: ['contacts', q],
    queryFn: () => contactsApi().list(q || undefined),
  });

  const pickImport = async () => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    const result = await importContactsFile(
      { uri: asset.uri, name: asset.name || 'contacts.csv', type: asset.mimeType || 'text/csv' },
      'skip'
    );
    Alert.alert(t('contacts.importDone', { saved: result.saved, skipped: result.skipped.length, invalid: result.invalid }));
    void queryClient.invalidateQueries({ queryKey: ['contacts'] });
  };

  const exportContacts = async () => {
    const { blob, filename } = await contactsApi().exportContacts('vcf');
    const buf = await blob.arrayBuffer();
    const file = new File(Paths.cache, filename);
    if (!file.exists) file.create();
    file.write(new Uint8Array(buf));
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(file.uri);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <ScreenHeader title={t('settings.contacts')} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <LabeledInput label={t('common.search')} value={q} onChangeText={setQ} autoCapitalize="none" />
        <PrimaryButton label={t('contacts.addContact')} onPress={() => router.push('/(app)/settings/contact/new')} />
        <PrimaryButton label={t('contacts.import')} onPress={() => void pickImport()} />
        <PrimaryButton label={t('contacts.exportVcard')} onPress={() => void exportContacts()} />
        {(query.data ?? []).map((c) => (
          <Pressable
            key={c.id}
            accessibilityRole="button"
            accessibilityLabel={c.displayName || c.email}
            onPress={() => router.push(`/(app)/settings/contact/${c.id}`)}
            style={[styles.row, { borderColor: colors.border }]}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>{c.displayName || c.email}</Text>
              <Text style={{ color: colors.textMuted }}>{c.email}</Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  row: { borderWidth: 1, borderRadius: 10, padding: 12, minHeight: 56, justifyContent: 'center' },
});
