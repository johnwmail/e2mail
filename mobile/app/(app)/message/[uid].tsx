import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { WebView } from 'react-native-webview';
import {
  isPgpArmored,
  replaceCidImages,
  rewriteRemoteImages,
  sanitizeMailHtml,
  wrapMailDocument,
  type ParsedMessage,
} from '@e2mail/shared';
import { extractTextFromMime } from '@e2mail/shared/pgp';
import { arrayBufferToBase64, getApiClient, mailApi, pgpApi } from '../../../src/api';
import { requestPassphrase } from '../../../src/crypto/passphrasePrompt';
import { PrimaryButton } from '../../../src/components/PrimaryButton';
import { useT } from '../../../src/hooks/useT';
import { useMailboxStore } from '../../../src/stores/useMailboxStore';
import { useResolvedScheme, useThemeTokens } from '../../../src/theme/useTheme';

export default function MessageDetailScreen() {
  const colors = useThemeTokens();
  const dark = useResolvedScheme() === 'dark';
  const t = useT();
  const params = useLocalSearchParams<{ uid: string; folder?: string }>();
  const uid = Number(params.uid);
  const accountId = useMailboxStore((s) => s.activeAccountId);
  const currentFolder = useMailboxStore((s) => s.currentFolder);
  const folder = params.folder || currentFolder;
  const queryClient = useQueryClient();
  const [allowRemote, setAllowRemote] = useState(false);
  const [plainOverride, setPlainOverride] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ['message', accountId, folder, uid],
    queryFn: () => mailApi().getMessageDetail(uid, folder, accountId ?? undefined),
    enabled: Number.isFinite(uid),
  });

  const foldersQuery = useQuery({
    queryKey: ['folders', accountId],
    queryFn: () => mailApi().getFolders(accountId ?? undefined),
    enabled: !!accountId,
  });

  const msg = detailQuery.data;

  useEffect(() => {
    setPlainOverride(null);
    setAllowRemote(false);
  }, [uid]);

  useEffect(() => {
    if (!msg || !msg.unread) return;
    void mailApi()
      .setFlags(folder, [uid], ['\\Seen'], 'add', accountId ?? undefined)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ['messages'] });
        void queryClient.invalidateQueries({ queryKey: ['folders'] });
      })
      .catch(() => undefined);
  }, [accountId, folder, msg, queryClient, uid]);

  const flagMut = useMutation({
    mutationFn: (starred: boolean) =>
      mailApi().setFlags(folder, [uid], ['\\Flagged'], starred ? 'add' : 'remove', accountId ?? undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['message', accountId, folder, uid] });
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => mailApi().deleteMessages(folder, [uid], false, accountId ?? undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
      router.back();
    },
  });

  const [cidMap, setCidMap] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!msg) return;
    const inlines = msg.attachments.filter((a) => a.isInline && a.contentId);
    if (!inlines.length) {
      setCidMap({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const att of inlines) {
        try {
          const path = mailApi().getAttachmentPath(uid, att.id, folder, accountId ?? undefined);
          const res = await getApiClient().raw(path);
          if (!res.ok) continue;
          const b64 = await arrayBufferToBase64(await res.arrayBuffer());
          const cid = (att.contentId || '').replace(/^<|>$/g, '');
          next[cid] = `data:${att.contentType || 'application/octet-stream'};base64,${b64}`;
        } catch {
          // skip
        }
      }
      if (!cancelled) setCidMap(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, folder, msg, uid]);

  const htmlSource = useMemo(() => {
    if (!msg) return '';
    const raw = plainOverride ?? msg.htmlBody ?? '';
    if (!raw) return '';
    const sanitized = rewriteRemoteImages(
      replaceCidImages(sanitizeMailHtml(raw), cidMap),
      allowRemote
    );
    return wrapMailDocument(sanitized, dark);
  }, [allowRemote, cidMap, dark, msg, plainOverride]);

  const encrypted = isPgpArmored(msg?.textBody) || isPgpArmored(msg?.htmlBody);

  const decrypt = async () => {
    if (!msg) return;
    const armored = msg.textBody || msg.htmlBody;
    const passphrase = await requestPassphrase({ allowPersist: true });
    if (passphrase === null) return;
    try {
      const key = await pgpApi().ensureKey();
      if (!key) throw new Error('No PGP key');
      const result = await pgpApi().decrypt({
        armoredMessage: armored,
        privateKeyArmored: key.privateKeyArmored,
        passphrase,
      });
      const mime = extractTextFromMime(result.data);
      setPlainOverride(mime || result.data);
    } catch (err) {
      Alert.alert(t('error.title'), err instanceof Error ? err.message : String(err));
    }
  };

  const openAttachment = async (att: ParsedMessage['attachments'][number]) => {
    try {
      const path = mailApi().getAttachmentPath(uid, att.id, folder, accountId ?? undefined);
      const res = await getApiClient().raw(path);
      if (!res.ok) throw new Error(String(res.status));
      const buf = await res.arrayBuffer();
      const safe = (att.filename || att.id).replace(/[^\w.-]+/g, '_');
      const file = new File(Paths.cache, safe);
      if (file.exists) file.delete();
      file.write(new Uint8Array(buf));
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri);
      else await Share.share({ url: file.uri, message: att.filename });
    } catch (err) {
      Alert.alert(t('error.title'), err instanceof Error ? err.message : String(err));
    }
  };

  const moveTo = () => {
    const names = (foldersQuery.data ?? []).map((f) => f.name).filter((n) => n !== folder);
    const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = names
      .slice(0, 8)
      .map((dest) => ({
        text: dest,
        onPress: () => {
          void mailApi()
            .moveMessages(folder, [uid], dest, accountId ?? undefined)
            .then(() => {
              void queryClient.invalidateQueries({ queryKey: ['messages'] });
              router.back();
            });
        },
      }));
    buttons.push({ text: t('common.cancel'), style: 'cancel' });
    Alert.alert(t('mail.move'), undefined, buttons);
  };

  if (detailQuery.isLoading) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      </SafeAreaView>
    );
  }

  if (detailQuery.isError || !msg) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg, padding: 24, gap: 12 }]}>
        <Text style={{ color: colors.danger }}>
          {(detailQuery.error as Error)?.message || t('error.title')}
        </Text>
        <PrimaryButton label={t('mail.retry')} onPress={() => void detailQuery.refetch()} />
        <PrimaryButton label={t('common.back')} onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  const from = (msg.from || []).map((a) => a.name || a.address).join(', ');
  const textBody = plainOverride && !msg.htmlBody ? plainOverride : msg.textBody;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={[styles.top, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} style={styles.navBtn}>
          <Text style={{ color: colors.primary }}>{t('common.back')}</Text>
        </Pressable>
        <View style={styles.actions}>
          <Pressable onPress={() => flagMut.mutate(!msg.starred)} style={styles.navBtn}>
            <Text style={{ color: colors.primary }}>{msg.starred ? t('mailList.unstar') : t('mailList.star')}</Text>
          </Pressable>
          <Pressable onPress={moveTo} style={styles.navBtn}>
            <Text style={{ color: colors.primary }}>{t('mail.move')}</Text>
          </Pressable>
          <Pressable onPress={() => deleteMut.mutate()} style={styles.navBtn}>
            <Text style={{ color: colors.danger }}>{t('mail.delete')}</Text>
          </Pressable>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <View style={styles.headers}>
          <Text style={[styles.subject, { color: colors.text }]}>{msg.subject || t('mailList.noSubject')}</Text>
          <Text style={{ color: colors.textMuted }}>{from}</Text>
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>{msg.date}</Text>
        </View>
        {encrypted && !plainOverride ? (
          <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
            <PrimaryButton label={t('mail.decrypt')} onPress={() => void decrypt()} />
          </View>
        ) : null}
        {htmlSource ? (
          <WebView
            originWhitelist={allowRemote ? ['http://', 'https://', 'about:', 'data:'] : ['about:', 'data:']}
            source={{ html: htmlSource }}
            javaScriptEnabled={false}
            style={{ height: 420, backgroundColor: colors.bg }}
          />
        ) : (
          <Text style={[styles.body, { color: colors.text }]}>{textBody}</Text>
        )}
        <Pressable
          onPress={() => setAllowRemote((v) => !v)}
          style={{ padding: 16 }}
        >
          <Text style={{ color: colors.primary }}>
            {allowRemote ? t('mail.blockRemoteImages') : t('mail.allowRemoteImages')}
          </Text>
        </Pressable>
        {msg.attachments.filter((a) => !a.isInline).map((att) => (
          <Pressable
            key={att.id}
            onPress={() => void openAttachment(att)}
            style={[styles.att, { borderColor: colors.border }]}
          >
            <Text style={{ color: colors.text }}>{att.filename}</Text>
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>{att.contentType}</Text>
          </Pressable>
        ))}
        <View style={{ padding: 16, gap: 8 }}>
          <PrimaryButton
            label={t('viewer.reply')}
            onPress={() =>
              router.push({
                pathname: '/(app)/compose',
                params: {
                  to: msg.from?.[0]?.address ?? '',
                  subject: msg.subject?.startsWith('Re:') ? msg.subject : `Re: ${msg.subject || ''}`,
                  inReplyTo: msg.messageId,
                  body: textBody,
                },
              })
            }
          />
          <PrimaryButton
            label={t('viewer.forward')}
            onPress={() =>
              router.push({
                pathname: '/(app)/compose',
                params: {
                  subject: msg.subject?.startsWith('Fwd:') ? msg.subject : `Fwd: ${msg.subject || ''}`,
                  body: textBody,
                },
              })
            }
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  top: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
  },
  navBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap' },
  headers: { padding: 16, gap: 4 },
  subject: { fontSize: 20, fontWeight: '700' },
  body: { paddingHorizontal: 16, fontSize: 16, lineHeight: 22 },
  att: { marginHorizontal: 16, marginTop: 8, borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 44 },
});
