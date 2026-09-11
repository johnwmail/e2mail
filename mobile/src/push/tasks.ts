import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { mailApi } from '../api';
import { setBadgeCount } from './register';

export const MAIL_SYNC_TASK = 'e2mail-mail-sync';

TaskManager.defineTask(MAIL_SYNC_TASK, async () => {
  try {
    const unread = await mailApi().getUnread(1, 1);
    await setBadgeCount(unread.total ?? 0);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerMailSyncTask(): Promise<void> {
  try {
    await BackgroundTask.registerTaskAsync(MAIL_SYNC_TASK, {
      minimumInterval: 15 * 60,
    });
  } catch {
    // Simulator / web.
  }
}
