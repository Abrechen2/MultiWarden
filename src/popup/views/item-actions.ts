import { generateTotp } from "../../crypto/totp";
import { EventType } from "../../shared/events";
import { personalItemAllowed } from "../../shared/policies";
import { CipherType, ItemView } from "../../shared/types";
import { useApp } from "../app-state";
import { useToast } from "../components";
import { useDialogs } from "../dialogs";
import type { IconName } from "../icons";
import { call } from "../rpc";
import { copyToClipboard, launchUrl } from "../util";
import { EXTRA_FIELDS } from "./item-fields";

import { t } from "../../shared/i18n";
export interface CopyOption {
  label: string;
  run: () => void;
  icon?: IconName;
}

export function useItemActions(item: ItemView) {
  const app = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const clearSec = app.state.settings.clearClipboardSeconds;

  const guard = async () => (item.reprompt === 1 ? dialogs.reprompt(item.accountKey) : true);

  /** event log of the organization (only items of organizations; the background checks "use events") */
  const logEvent = (type: number) => {
    if (item.organizationId) call("collectEvent", { accountKey: item.accountKey, itemId: item.id, type }).catch(() => {});
  };

  const copy = async (value: string | undefined, what: string, sensitive = false, event?: number) => {
    if (!value) return;
    if (sensitive && !(await guard())) return;
    try {
      await copyToClipboard(value, clearSec);
      toast.show(t("{what} kopiert", { what }));
      if (event) logEvent(event);
      if (sensitive) call("markUsed", { accountKey: item.accountKey, itemId: item.id }).catch(() => {});
    } catch {
      toast.show(t("Kopieren fehlgeschlagen"), "error");
    }
  };

  const copyOptions = (): CopyOption[] => {
    const o: CopyOption[] = [];
    const add = (label: string, v: string | undefined, sensitive = false, icon?: IconName, event?: number) => {
      if (v) o.push({ label, run: () => copy(v, label, sensitive, event), icon });
    };
    switch (item.type) {
      case CipherType.Login:
        add(t("Benutzername"), item.login?.username, false, "user");
        if (item.viewPassword) add(t("Passwort"), item.login?.password, true, "key", EventType.CipherClientCopiedPassword);
        if (item.login?.totp)
          o.push({
            icon: "clock",
            label: t("Bestätigungscode"),
            run: async () => {
              const tx = await generateTotp(item.login!.totp!);
              if (tx) copy(tx.code, t("Bestätigungscode"));
              else toast.show(t("TOTP-Schlüssel ungültig"), "error");
            },
          });
        break;
      case CipherType.Card:
        add(t("Kartennummer"), item.card?.number, true);
        add(t("Prüfnummer"), item.card?.code, true, undefined, EventType.CipherClientCopiedCardCode);
        break;
      case CipherType.Identity: {
        const id = item.identity ?? {};
        add(t("Name"), [id.title, id.firstName, id.middleName, id.lastName].filter(Boolean).join(" "));
        add("E-Mail", id.email);
        add(t("Telefon"), id.phone);
        add(
          t("Adresse"),
          [id.address1, id.address2, [id.postalCode, id.city].filter(Boolean).join(" "), id.country].filter(Boolean).join(", "),
        );
        break;
      }
      case CipherType.SecureNote:
        add(t("Notiz"), item.notes, true);
        break;
      case CipherType.SshKey:
        add(t("Öffentlicher Schlüssel"), item.sshKey?.publicKey);
        add(t("Fingerabdruck"), item.sshKey?.keyFingerprint);
        add(t("Privater Schlüssel"), item.sshKey?.privateKey, true);
        break;
      default: {
        const defs = EXTRA_FIELDS[item.type];
        if (defs) for (const f of defs) add(t(f.label), item.extra?.[f.key], !!f.secret);
        else for (const [k, v] of Object.entries(item.extra ?? {})) add(k, v, true);
      }
    }
    return o;
  };

  const fill = async () => {
    if (!(await guard())) return;
    let r = await call("autofill", { accountKey: item.accountKey, itemId: item.id });
    const insecure = !r.ok && r.code === "insecure";
    if (!r.ok && (r.code === "mismatch" || insecure)) {
      const ok = await dialogs.confirm({
        title: t("Trotzdem ausfüllen?"),
        message: insecure
          ? t(
              "Dieser Login ist nur für HTTPS gespeichert, die Seite ist aber unverschlüsselt (http). Die Zugangsdaten könnten mitgelesen werden.",
            )
          : t(
              "Die aktuelle Seite passt zu keiner der gespeicherten Websites dieses Eintrags. Nur fortfahren, wenn du der Seite vertraust.",
            ),
        okLabel: t("Ausfüllen"),
      });
      if (!ok) return;
      r = await (call as any)("autofill", { accountKey: item.accountKey, itemId: item.id, force: true });
    }
    if (!r.ok) {
      toast.show(r.error ?? t("Ausfüllen fehlgeschlagen"), "error");
      return;
    }
    if (r.totpCopied) {
      try {
        await copyToClipboard(r.totpCopied, clearSec);
      } catch {
        /* ignore */
      }
    }
    if (!app.popout) window.close();
    else toast.show(t("Ausgefüllt"));
  };

  const firstUri = item.login?.uris.map((u) => launchUrl(u.uri)).find(Boolean);
  const launch = firstUri
    ? () => {
        chrome.tabs.create({ url: firstUri! });
        if (!app.popout) window.close();
      }
    : undefined;

  const toggleFavorite = async () => {
    const r = await call("saveItem", { accountKey: item.accountKey, item: { ...item, favorite: !item.favorite }, isNew: false });
    if (!r.ok) toast.show(r.error ?? t("Speichern fehlgeschlagen"), "error");
    else toast.show(item.favorite ? t("Aus Favoriten entfernt") : t("Zu Favoriten hinzugefügt"));
  };

  const canFill = item.type === CipherType.Login || item.type === CipherType.Card || item.type === CipherType.Identity;

  /** "copy into another account": needs another unlocked account; not for items in the trash */
  const canCopyToAccount = !item.deletedDate && app.accounts.some((a) => a.status === "unlocked" && a.key !== item.accountKey);
  const copyToAccount = async () => {
    // the organization hides the password: a copy in another account would reveal it
    if (!item.viewPassword) {
      toast.show(t("Das Passwort dieses Eintrags ist für dich verborgen – er kann nicht kopiert werden."), "error");
      return;
    }
    if (!(await guard())) return;
    const r = await dialogs.copyToAccount(item);
    if (!r) return;
    await app.reloadVault();
    const target = app.accountMap.get(r.targetAccountKey)?.label ?? "";
    if (r.attachmentsFailed.length)
      toast.show(
        t("In {account} kopiert, aber diese Anhänge konnten nicht kopiert werden: {names}", {
          account: target,
          names: r.attachmentsFailed.join(", "),
        }),
        "error",
      );
    else toast.show(t("In {account} kopiert", { account: target }));
  };

  /** "move into my personal vault": editable organization items whose account allows personal items */
  const canMoveToPersonal =
    !item.deletedDate &&
    !!item.organizationId &&
    item.edit &&
    personalItemAllowed(app.accountMap.get(item.accountKey)?.policies, item.type);
  const moveToPersonal = async () => {
    // the organization hides the password: a personal copy would reveal it
    if (!item.viewPassword) {
      toast.show(t("Das Passwort dieses Eintrags ist für dich verborgen – er kann nicht kopiert werden."), "error");
      return;
    }
    if (!(await guard())) return;
    const r = await dialogs.moveToPersonal(item);
    if (!r) return;
    await app.reloadVault();
    if (r.attachmentsFailed.length)
      toast.show(
        t("In deinen persönlichen Tresor kopiert, das Original bleibt erhalten – diese Anhänge konnten nicht kopiert werden: {names}", {
          names: r.attachmentsFailed.join(", "),
        }),
        "error",
      );
    else if (!r.originalRemoved)
      toast.show(
        t("In deinen persönlichen Tresor kopiert, aber das Original konnte nicht entfernt werden: {error}", { error: r.removeError ?? "" }),
        "error",
      );
    else toast.show(t("In deinen persönlichen Tresor verschoben"));
    app.go({ name: "item", key: item.accountKey + "::" + r.id });
  };

  return {
    logEvent,
    copy,
    copyOptions,
    fill,
    canFill,
    launch,
    toggleFavorite,
    guard,
    canCopyToAccount,
    copyToAccount,
    canMoveToPersonal,
    moveToPersonal,
  };
}
