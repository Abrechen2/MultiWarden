// Open ("receive") a Send from its link, like the web vault of a recipient: send access token (new
// flow, optionally with password or e-mail code), then the content; servers without the token flow
// use the older access endpoint. The key is part of the link and never sent to the server.
import { decryptString, serializeKey, type SerializedKey } from "../crypto/bw";
import { b64decode } from "../crypto/utils";
import { t } from "../shared/i18n";
import { ReceivedSend, ReceiveAuth, ReceiveRequest, ReceiveResult, SendType } from "../shared/sends";
import { SERVER_PRESETS, ServerUrls, selfHostedUrls } from "../shared/types";
import { formEncode, httpJson } from "./api";
import { sendKeyFromMaterial, sendPasswordHash } from "./sends";

export interface ParsedSendLink {
  base: string;
  accessId: string;
  material: Uint8Array;
}

/** "https://send.bitwarden.com/#<id>/<key>" or "<web vault>/#/send/<id>/<key>" */
export function parseSendLink(link: string): ParsedSendLink | null {
  const s = link.trim();
  let m = /^(https:\/\/send\.bitwarden(?:-gov)?\.com)\/?#\/?(?:send\/)?([\w-]+)\/([\w-]+)\/?$/i.exec(s);
  if (!m) m = /^(https?:\/\/[^#\s]+?)\/?#\/send\/([\w-]+)\/([\w-]+)\/?$/i.exec(s);
  if (!m) return null;
  try {
    const material = b64decode(m[3]);
    if (material.length < 16) return null;
    return { base: m[1].replace(/\/+$/, ""), accessId: m[2], material };
  } catch {
    return null;
  }
}

function sameBase(a: string | undefined, b: string): boolean {
  return !!a && a.replace(/\/+$/, "").toLowerCase() === b.toLowerCase();
}

/** Server of a Send link: a known account (also with custom service URLs), the cloud, or the base URL. */
export function urlsForSend(base: string, accounts: { urls: ServerUrls }[]): ServerUrls {
  const acc = accounts.find((a) => sameBase(a.urls.webVault, base) || sameBase(a.urls.base, base));
  if (acc) return acc.urls;
  const host = base.replace(/^https?:\/\//i, "").toLowerCase();
  if (host === "send.bitwarden.com" || host === "vault.bitwarden.com") return SERVER_PRESETS.us;
  if (host === "vault.bitwarden.eu") return SERVER_PRESETS.eu;
  return selfHostedUrls(base);
}

const FORM = { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" };

async function decryptAccess(raw: any, material: Uint8Array, server: string): Promise<ReceivedSend> {
  const key = await sendKeyFromMaterial(material);
  const out: ReceivedSend = {
    id: raw.id ?? raw.Id,
    type: raw.type ?? raw.Type,
    name: "",
    expirationDate: raw.expirationDate ?? raw.ExpirationDate ?? null,
    creatorIdentifier: raw.creatorIdentifier ?? raw.CreatorIdentifier ?? null,
    server,
  };
  const name = raw.name ?? raw.Name;
  if (name) out.name = await decryptString(name, key);
  const text = raw.text ?? raw.Text;
  if (out.type === SendType.Text && text) {
    const v = text.text ?? text.Text;
    out.text = v ? await decryptString(v, key) : "";
    out.hidden = !!(text.hidden ?? text.Hidden);
  }
  const file = raw.file ?? raw.File;
  if (out.type === SendType.File && file) {
    const fn = file.fileName ?? file.FileName;
    const size = Number(file.size ?? file.Size);
    out.file = {
      id: file.id ?? file.Id,
      fileName: fn ? await decryptString(fn, key) : "datei",
      size: Number.isFinite(size) ? size : undefined,
      sizeName: file.sizeName ?? file.SizeName,
    };
  }
  return out;
}

function apiError(r: { status: number; json: any }): string {
  const j = r.json ?? {};
  return j.message ?? j.Message ?? j.error_description ?? j.errorModel?.message ?? t("Fehler (HTTP {status})", { status: r.status });
}

/** Older servers: POST /sends/access/{id} with the password hash in the body. */
async function legacyAccess(urls: ServerUrls, p: ParsedSendLink, password?: string): Promise<ReceiveResult> {
  const hash = password ? await sendPasswordHash(password, p.material) : undefined;
  const r = await httpJson(`${urls.api}/sends/access/${p.accessId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(hash ? { password: hash } : {}),
  });
  if (r.status === 401) return { status: password ? "wrongPassword" : "password" };
  if (r.status === 400 && password) return { status: "wrongPassword" };
  if (r.status === 404) return { status: "unavailable" };
  if (r.status < 200 || r.status >= 300) return { status: "error", error: apiError(r) };
  return { status: "ok", send: await decryptAccess(r.json, p.material, urls.webVault), auth: { legacyPassword: hash } };
}

export async function receiveSend(req: ReceiveRequest, accounts: { urls: ServerUrls }[]): Promise<ReceiveResult> {
  const p = parseSendLink(req.link);
  if (!p) return { status: "error", error: t("Das ist kein gültiger Send-Link") };
  const urls = urlsForSend(p.base, accounts);
  const form: Record<string, string | undefined> = {
    client_id: "send",
    grant_type: "send_access",
    scope: "api.send.access",
    send_id: p.accessId,
  };
  if (req.password) form.password_hash_b64 = await sendPasswordHash(req.password, p.material);
  if (req.email) form.email = req.email.trim();
  if (req.email && req.otp) form.otp = req.otp.trim();
  const tok = await httpJson(`${urls.identity}/connect/token`, { method: "POST", headers: FORM, body: formEncode(form) });
  if (tok.status < 200 || tok.status >= 300) {
    const j = tok.json ?? {};
    const kind = j.send_access_error_type ?? j.sendAccessErrorType;
    switch (kind) {
      case "password_hash_b64_required":
        return { status: "password" };
      case "password_hash_b64_invalid":
        return { status: "wrongPassword" };
      case "email_required":
        return { status: "email" };
      case "email_and_otp_required":
        return { status: req.otp ? "wrongCode" : "otp" };
      case "otp_invalid":
      case "otp_generation_failed":
        return { status: "wrongCode" };
      case "send_id_invalid":
        return { status: "unavailable" };
    }
    // server without the send access token flow (older Bitwarden / Vaultwarden versions)
    if (tok.status === 404 || /unsupported_grant_type|invalid_client|invalid_scope|Invalid type/i.test(JSON.stringify(j)))
      return legacyAccess(urls, p, req.password);
    return { status: "error", error: apiError(tok) };
  }
  const token = tok.json?.access_token;
  const r = await httpJson(`${urls.api}/sends/access`, { method: "POST", headers: { Authorization: "Bearer " + token } });
  if (r.status === 404) return { status: "unavailable" };
  if (r.status < 200 || r.status >= 300) return { status: "error", error: apiError(r) };
  return { status: "ok", send: await decryptAccess(r.json, p.material, urls.webVault), auth: { token } };
}

/** Download URL and key of the file of a received Send (fetched and decrypted by the popup). */
export async function receiveSendFile(
  link: string,
  sendId: string,
  fileId: string,
  auth: ReceiveAuth,
  accounts: { urls: ServerUrls }[],
): Promise<{ url: string; key: SerializedKey }> {
  const p = parseSendLink(link);
  if (!p) throw new Error(t("Das ist kein gültiger Send-Link"));
  const urls = urlsForSend(p.base, accounts);
  const r = auth.token
    ? await httpJson(`${urls.api}/sends/access/file/${fileId}`, { method: "POST", headers: { Authorization: "Bearer " + auth.token } })
    : await httpJson(`${urls.api}/sends/${sendId}/access/file/${fileId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(auth.legacyPassword ? { password: auth.legacyPassword } : {}),
      });
  if (r.status === 401) throw new Error(t("Der Zugriff ist abgelaufen – bitte das Send erneut öffnen"));
  if (r.status < 200 || r.status >= 300 || !r.json?.url) throw new Error(apiError(r));
  return { url: r.json.url, key: serializeKey(await sendKeyFromMaterial(p.material)) };
}
