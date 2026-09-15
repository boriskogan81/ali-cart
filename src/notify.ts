import notifier from "node-notifier";
import { exec } from "node:child_process";

export function playSound(): void {
  if (process.platform !== "win32") return;
  const ps = `(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\notify.wav').PlaySync()`;
  exec(`powershell -NoProfile -Command "${ps}"`, () => {});
}

export function notify(title: string, message: string): void {
  try {
    notifier.notify({ title, message, sound: false, wait: false });
  } catch {
    // Toasts are best-effort; the UI and console carry the same information.
  }
  playSound();
}
