// Inline autofill menu, rendered inside an extension-origin iframe next to the login field.
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { InlineMenuData, InlineMenuItem } from "../shared/messages";
import { CipherType } from "../shared/types";
import { Icon, Logo } from "../popup/icons";
import "./inline-menu.css";

import { initLanguage, t } from "../shared/i18n";
import { initAppearance } from "../shared/appearance";
import { ArmState, isArmed } from "./arming";
const token = decodeURIComponent(location.hash.slice(1));

// Entries ignore clicks / Enter right after the menu appeared or moved and while the browser reports it
// as covered: a page must not be able to slide the menu under a click aimed at its own content.
const arm: ArmState = { shownAt: performance.now(), occluded: false };
const rearm = () => {
  arm.shownAt = performance.now();
};
const armed = () => isArmed(arm, performance.now());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") rearm();
});

async function rpc(name: string, args: any) {
  const r = await chrome.runtime.sendMessage({ rpc: name, args });
  if (!r?.ok) throw new Error(r?.error ?? t("Fehler"));
  return r.data;
}

function post(msg: any) {
  window.parent.postMessage({ mwToken: token, ...msg }, "*");
}

function Fav({ it }: { it: InlineMenuItem }) {
  const [failed, setFailed] = useState(false);
  if (it.icon && !failed)
    return (
      <img
        class="fav"
        src={it.icon}
        alt=""
        onError={() => setFailed(true)}
        onLoad={(e) => {
          if ((e.currentTarget as HTMLImageElement).naturalWidth < 4) setFailed(true);
        }}
      />
    );
  return (
    <span class="fav ph">
      <Icon name="globe" size={16} />
    </span>
  );
}

function Menu() {
  const [data, setData] = useState<InlineMenuData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const load = () =>
    rpc("inlineMenuData", { token })
      .then((d: InlineMenuData) => {
        setData(d);
      })
      .catch(() =>
        setData({
          kind: "login",
          locked: false,
          hasAccounts: false,
          items: [],
          passkeys: [],
          showFavicons: false,
          theme: "system",
          multi: false,
        }),
      );

  useEffect(() => {
    load();
    const l = (msg: any) => {
      if (msg?.event === "stateChanged" || msg?.event === "vaultChanged" || msg?.event === "locked") load();
    };
    chrome.runtime.onMessage.addListener(l);
    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== window.parent || ev.data?.mwToken !== token) return;
      if (ev.data.moved) rearm();
      if (ev.data.focusFirst) root.current?.querySelector<HTMLElement>("button")?.focus();
    };
    window.addEventListener("message", onMsg);
    return () => {
      chrome.runtime.onMessage.removeListener(l);
      window.removeEventListener("message", onMsg);
    };
  }, []);

  // new entries under the pointer count as "appeared"
  useEffect(rearm, [data]);

  // IntersectionObserver v2 (Chromium): occlusion by other content – also by pointer-events: none
  // overlays the page side cannot detect – and transparency of the frame and its ancestors
  useEffect(() => {
    if (!root.current) return;
    let io: IntersectionObserver | undefined;
    try {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const visible = (e as any).isVisible;
            if (typeof visible !== "boolean") return; // no v2 support (Firefox)
            if (visible && arm.occluded) rearm();
            arm.occluded = !visible;
          }
        },
        { trackVisibility: true, delay: 100, threshold: [0, 1] } as IntersectionObserverInit,
      );
      io.observe(root.current);
    } catch {
      /* not supported */
    }
    return () => io?.disconnect();
  }, [root.current]);

  useEffect(() => {
    if (!root.current) return;
    const ro = new ResizeObserver(() => post({ height: Math.ceil(root.current!.getBoundingClientRect().height) }));
    ro.observe(root.current);
    return () => ro.disconnect();
  }, [root.current]);

  useEffect(() => {
    if (data && !data.locked && data.items.length === 0 && data.passkeys.length === 0 && !data.generated && data.hasAccounts)
      post({ close: true });
    if (data && !data.hasAccounts) post({ close: true });
  }, [data]);

  const regenerate = async () => {
    try {
      const r = await rpc("inlineMenuGenerate", { token });
      setData((d) => (d ? { ...d, generated: r.password } : d));
    } catch {
      /* token expired */
    }
  };

  const onKey = (e: KeyboardEvent) => {
    const btns = Array.from(root.current?.querySelectorAll<HTMLElement>("button.entry, button.unlock, button.new") ?? []);
    const i = btns.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      btns[(i + 1) % btns.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      btns[(i - 1 + btns.length) % btns.length]?.focus();
    } else if (e.key === "Escape") {
      post({ close: true });
    }
  };

  if (!data) return <div ref={root} class="menu loading" />;

  return (
    <div ref={root} class="menu" onKeyDown={onKey as any} role="listbox" aria-label={t("Anmeldedaten")}>
      {data.generated && (
        <div class="gen-row">
          <button
            class="entry gen"
            role="option"
            disabled={!!busy}
            data-testid="inline-generate"
            onClick={async () => {
              if (!armed()) return;
              setBusy("gen");
              try {
                const r = await rpc("inlineMenuFillGenerated", { token });
                if (r?.ok) post({ close: true });
              } finally {
                setBusy(null);
              }
            }}
          >
            <span class="fav ph pk">
              <Icon name="wand" size={16} />
            </span>
            <span class="txt">
              <b>{t("Generiertes Passwort einsetzen")}</b>
              <small class="mono" data-testid="inline-generated">
                {data.generated}
              </small>
            </span>
          </button>
          <button
            class="icon"
            title={t("Neues Passwort generieren")}
            aria-label={t("Neues Passwort generieren")}
            onClick={regenerate}
            data-testid="inline-regenerate"
          >
            <Icon name="refresh" size={15} />
          </button>
        </div>
      )}
      {data.locked ? (
        <button class="unlock" onClick={() => rpc("openPopup", {})}>
          <Logo size={22} />
          <span class="txt">
            <b>{t("Tresor gesperrt")}</b>
            <small>{t("Zum Entsperren klicken")}</small>
          </span>
          <Icon name="unlock" size={16} />
        </button>
      ) : (
        <>
          {data.passkeys.map((pk) => (
            <button
              class="entry passkey"
              key={"pk" + pk.accountKey + pk.itemId}
              role="option"
              disabled={!!busy}
              data-testid="inline-passkey"
              onClick={async () => {
                if (!armed()) return;
                setBusy("pk" + pk.accountKey + pk.itemId);
                try {
                  const r = await rpc("inlineMenuPasskey", { token, accountKey: pk.accountKey, itemId: pk.itemId });
                  if (r?.ok) post({ close: true });
                } finally {
                  setBusy(null);
                }
              }}
            >
              <span class="fav ph pk">
                <Icon name="passkey" size={16} />
              </span>
              <span class="txt">
                <b>{pk.userName || pk.name}</b>
                <small>{t("Passkey · {name}", { name: pk.name })}</small>
              </span>
              {data.multi && (
                <span
                  class="badge"
                  style={{ color: pk.accountColor, borderColor: pk.accountColor + "66", background: pk.accountColor + "1a" }}
                  title={pk.accountLabel}
                >
                  <span class="dot" style={{ background: pk.accountColor }} />
                  {pk.accountInitials}
                </span>
              )}
            </button>
          ))}
          {data.items.slice(0, 8).map((it) => (
            <button
              class="entry"
              key={it.accountKey + it.id}
              role="option"
              disabled={!!busy}
              data-testid="inline-item"
              onClick={async () => {
                if (!armed()) return;
                setBusy(it.accountKey + it.id);
                try {
                  await rpc("inlineMenuFill", { token, accountKey: it.accountKey, itemId: it.id });
                } finally {
                  setBusy(null);
                }
              }}
            >
              {it.type === CipherType.Card || it.type === CipherType.Identity ? (
                <span class="fav ph">
                  <Icon name={it.type === CipherType.Card ? "card" : "identity"} size={16} />
                </span>
              ) : data.showFavicons ? (
                <Fav it={it} />
              ) : (
                <span class="fav ph">
                  <Icon name="globe" size={16} />
                </span>
              )}
              <span class="txt">
                <b>{it.name}</b>
                <small>{it.username || "—"}</small>
              </span>
              {data.multi && (
                <span
                  class="badge"
                  style={{ color: it.accountColor, borderColor: it.accountColor + "66", background: it.accountColor + "1a" }}
                  title={it.accountLabel}
                >
                  <span class="dot" style={{ background: it.accountColor }} />
                  {it.accountInitials}
                </span>
              )}
            </button>
          ))}
          {data.items.length > 8 && (
            <button class="unlock more" onClick={() => rpc("openPopup", {})}>
              <span class="txt">
                <small>{t("{n} weitere im Popup …", { n: data.items.length - 8 })}</small>
              </span>
            </button>
          )}
          {data.kind !== "newPassword" && (
            <button class="new" onClick={() => rpc("inlineMenuNew", { token })} data-testid="inline-new">
              <Icon name="plus" size={15} />
              <span>{data.kind === "card" ? t("Neue Karte") : data.kind === "identity" ? t("Neue Identität") : t("Neuer Login")}</span>
            </button>
          )}
        </>
      )}
    </div>
  );
}

Promise.all([initLanguage(() => rerender()), initAppearance({ surfaceAsBg: true })]).finally(() => rerender());
function rerender() {
  render(<Menu />, document.getElementById("root")!);
}
