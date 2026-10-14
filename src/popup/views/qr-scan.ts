// Scan an authenticator QR code (otpauth://…) shown on the current page, like the official
// extension: screenshot of the visible tab, decoded locally with jsQR.
import jsQR from "jsqr";
import { t } from "../../shared/i18n";

async function targetWindowId(): Promise<number | undefined> {
  // the popout window itself must not be captured → the last focused normal browser window
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: "normal" });
  if (tab) return tab.windowId;
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  return (wins.find((w) => w.focused) ?? wins[0])?.id;
}

function decode(img: ImageBitmap | HTMLImageElement, scale: number): string | null {
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  return jsQR(data.data, w, h, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

/** otpauth:// URI (or other QR text) of the code on the visible page, null if none was found. */
export async function scanTotpQr(): Promise<string | null> {
  const windowId = await targetWindowId();
  if (windowId == null) throw new Error(t("Kein Browserfenster gefunden"));
  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch {
    throw new Error(t("Diese Seite kann nicht aufgenommen werden"));
  }
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  // full size first, then downscaled (large screenshots of high-DPI screens decode better smaller)
  for (const scale of [1, 0.5]) {
    const text = decode(img, scale);
    if (text) return /^otpauth(-migration)?:\/\//i.test(text) || /^[A-Z2-7=\s]{16,}$/i.test(text) ? text.trim() : null;
  }
  return null;
}
