import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, type MailAttachment, type OutgoingMessage } from '@e2mail/shared';
import { mailApi, pgpApi } from '../../src/api';
import { requestPassphrase } from '../../src/crypto/passphrasePrompt';
import { LabeledInput } from '../../src/components/LabeledInput';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { useT } from '../../src/hooks/useT';
import { useMailboxStore } from '../../src/stores/useMailboxStore';
import { useThemeTokens } from '../../src/theme/useTheme';

function splitAddrs(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function ComposeScreen() {
  const colors = useThemeTokens();
  const t = useT();
  const params = useLocalSearchParams<{
    to?: string;
    subject?: string;
    body?: string;
    inReplyTo?: string;
  }>();
  const accountId = useMailboxStore((s) => s.activeAccountId);
  const queryClient = useQueryClient();
  const [to, setTo] = useState(params.to ?? '');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(params.subject ?? '');
  const [body, setBody] = useState(params.body ?? '');
  const [encrypt, setEncrypt] = useState(false);
  const [sign, setSign] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<Array<{ uri: string; name: string; type: string }>>([]);

  const pickFiles = async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return;
    setFiles((prev) => [
      ...prev,
      ...result.assets.map((a) => ({
        uri: a.uri,
        name: a.name,
        type: a.mimeType || 'application/octet-stream',
      })),
    ]);
  };

  const send = async () => {
    const recipients = splitAddrs(to);
    if (!recipients.length) {
      setError(t('composer.needRecipient'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let textBody = body;
      const attachments: MailAttachment[] = files;
      const wantPgp = encrypt || sign;
      let passphrase: string | undefined;
      if (wantPgp) {
        const key = await pgpApi().ensureKey();
        if (!key) throw new Error(t('composer.needPrivateKey'));
        if (sign) {
          const asked = await requestPassphrase({ allowPersist: true });
          if (asked === null) {
            setBusy(false);
            return;
          }
          passphrase = asked;
        }
        const contactKeys = await pgpApi().getContactKeys();
        const recipientKeys: string[] = [];
        for (const addr of recipients) {
          let found = contactKeys.find((k) => k.email.toLowerCase() === addr.toLowerCase())?.publicKeyArmored;
          if (!found && encrypt) {
            const online = await pgpApi().fetchPublicKeyFromKeyserver(addr).catch(() => null);
            if (online) {
              await pgpApi().saveContactKey(addr, online);
              found = online;
            }
          }
          if (found) recipientKeys.push(found);
        }
        if (encrypt) {
          if (!recipientKeys.length) throw new Error(t('composer.missingKeys', { emails: recipients.join(', ') }));
          if (recipientKeys.length < recipients.length) {
            throw new Error(t('composer.someMissingKeys', { count: recipients.length - recipientKeys.length }));
          }
        }
        textBody = await pgpApi().encrypt({
          text: body,
          recipientPublicKeysArmored: recipientKeys.length ? recipientKeys : [key.publicKeyArmored],
          signerPrivateKeyArmored: sign ? key.privateKeyArmored : undefined,
          passphrase,
        });
      }
      const msg: OutgoingMessage = {
        to: recipients,
        cc: splitAddrs(cc),
        subject,
        textBody,
        htmlBody: encrypt || sign ? '' : `<div>${body.replace(/\n/g, '<br/>')}</div>`,
        inReplyTo: params.inReplyTo,
        attachments,
      };
      await mailApi().sendMessage(msg, accountId ?? undefined);
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
      router.back();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    setBusy(true);
    try {
      await mailApi().saveDraft(
        {
          to: splitAddrs(to),
          cc: splitAddrs(cc),
          subject,
          textBody: body,
        },
        accountId ?? undefined
      );
      router.back();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={[styles.top, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} style={styles.nav}>
          <Text style={{ color: colors.primary }}>{t('common.close')}</Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>{t('mail.compose')}</Text>
        <View style={{ width: 64 }} />
      </View>
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <LabeledInput label={t('composer.toLabel')} value={to} onChangeText={setTo} autoCapitalize="none" />
        <LabeledInput label={t('composer.ccLabel')} value={cc} onChangeText={setCc} autoCapitalize="none" />
        <LabeledInput label={t('composer.subjectLabel')} value={subject} onChangeText={setSubject} />
        <LabeledInput
          label={t('composer.bodyPlaceholder')}
          value={body}
          onChangeText={setBody}
          multiline
          style={{ minHeight: 160, textAlignVertical: 'top' }}
        />
        <View style={styles.row}>
          <Text style={{ color: colors.text, flex: 1 }}>{t('composer.encrypt')}</Text>
          <Switch value={encrypt} onValueChange={setEncrypt} />
        </View>
        <View style={styles.row}>
          <Text style={{ color: colors.text, flex: 1 }}>{t('composer.sign')}</Text>
          <Switch value={sign} onValueChange={setSign} />
        </View>
        <PrimaryButton label={t('composer.attachFiles')} onPress={() => void pickFiles()} />
        {files.map((f) => (
          <Text key={f.uri} style={{ color: colors.textMuted }}>
            {f.name}
          </Text>
        ))}
        {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
        <PrimaryButton
          label={busy ? t('composer.sendingBtn') : t('composer.send')}
          disabled={busy}
          onPress={() => void send()}
        />
        <PrimaryButton label={t('composer.saveDraft')} disabled={busy} onPress={() => void saveDraft()} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    minHeight: 52,
  },
  title: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700' },
  nav: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  form: { padding: 16, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
});
