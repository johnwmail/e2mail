import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { pushApi } from '../api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowAlert: true,
  }),
});

let lastToken: string | null = null;

export function lastPushToken(): string | null {
  return lastToken;
}

function projectId(): string | undefined {
  return Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
}

export async function registerForPushAsync(accountIds?: string[]): Promise<string | null> {
  if (!Device.isDevice) return null;
  if (Platform.OS === 'web') return null;

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('mail', {
      name: 'Mail',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    });
  }

  const pid = projectId();
  if (!pid) return null;
  const tokenRes = await Notifications.getExpoPushTokenAsync({ projectId: pid });
  const token = tokenRes.data;
  lastToken = token;
  await pushApi().register({
    token,
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    accountIds,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  return token;
}

export async function unregisterPushAsync(): Promise<void> {
  const token = lastToken;
  lastToken = null;
  if (!token) return;
  try {
    await pushApi().unregister(token);
  } catch {
    // Token may already be gone with the session.
  }
}

export async function setBadgeCount(count: number): Promise<void> {
  try {
    await Notifications.setBadgeCountAsync(Math.max(0, count));
  } catch {
    // Web / Expo Go without notifications.
  }
}
