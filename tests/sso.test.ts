// SSO login against Vaultwarden (server C, :8003) with the mock OpenID provider (:9100).
// The browser tab is simulated: the redirect chain is followed with fetch (incl. cookies).
import { opened, resetStorage } from "./chrome-stub";
import { LoginFlows } from "../src/background/login-flow";
import { VaultService } from "../src/background/vault-service";

const BASE = "http://localhost:8003";
let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

/** Plays the browser: VW authorize → IdP login → VW callback → sso-connector.html */
async function runIdp(authorizeUrl: string, email: string): Promise<string> {
  const cookies = new Map<string, string>();
  const keep = (r: Response) => {
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
  };
  const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  let r = await fetch(authorizeUrl, { redirect: "manual" });
  keep(r);
  const idp = new URL(r.headers.get("location")!);
  if (!idp.href.startsWith("http://localhost:9100/authorize")) throw new Error("unexpected redirect " + idp.href);
  const done = new URL("http://localhost:9100/authorize/done");
  for (const k of ["state", "redirect_uri", "nonce", "client_id", "code_challenge"])
    done.searchParams.set(k, idp.searchParams.get(k) ?? "");
  done.searchParams.set("email", email);
  r = await fetch(done, { redirect: "manual" });
  const callback = r.headers.get("location")!;
  r = await fetch(callback, { redirect: "manual", headers: { Cookie: cookieHeader() } });
  const loc = r.headers.get("location");
  if (!loc) throw new Error("callback failed: " + r.status + " " + (await r.text()).slice(0, 200));
  return loc;
}

(async () => {
  let svc = new VaultService(() => {});
  await svc.ready;
  let flows = new LoginFlows(svc, { async openLoginWindow() {}, async focusLoginWindow() {}, changed() {} });
  const ident = await flows.lookupSsoIdentifier({ server: "selfhosted", baseUrl: BASE, email: "anna@sso.test" });
  check("sso identifier lookup", !!ident, ident);

  // ---------------------------------------------------------------- first login: JIT user → set master password
  let f = await flows.startSso({ server: "selfhosted", baseUrl: BASE, email: "anna@sso.test", orgIdentifier: ident! });
  check("sso-wait", f.step === "sso-wait", f);
  const authUrl = opened.tabs.at(-1)!;
  check(
    "authorize url",
    authUrl.startsWith(BASE + "/identity/connect/authorize?client_id=browser") && authUrl.includes("code_challenge_method=S256"),
    authUrl,
  );
  let connector = await runIdp(authUrl, "anna@sso.test");
  check("redirect to sso-connector", connector.startsWith(BASE + "/sso-connector.html?code="), connector);
  await flows.onTabUpdated(1001, connector);
  f = (await flows.current())!;
  check("new SSO user must set password", f.step === "set-password", f);
  f = await flows.setInitialPassword({ password: "zu-kurz" });
  check("short password rejected", f.step === "set-password" && /12 Zeichen/.test(f.error ?? ""), f);
  f = await flows.setInitialPassword({ password: "SSO-Master-Passwort-1", hint: "Test" });
  check("password set → done", f.step === "done", f);
  await flows.ack();
  const acc = svc.publicAccounts()[0];
  check("account added via SSO", acc?.email === "anna@sso.test" && acc.sso && acc.hasMasterPassword && acc.status === "unlocked", acc);

  // create an item so we can see the vault decrypts after the next logins
  const { newLoginItem } = await import("../src/shared/items");
  await svc.saveItem(acc.key, newLoginItem(acc.key, { name: "SSO-Test", username: "anna", password: "pw", uri: "https://sso.test" }), true);

  // ---------------------------------------------------------------- unlock via master password (SSO account with MP)
  await svc.lock();
  const u = await svc.unlock("SSO-Master-Passwort-1");
  check("unlock SSO account with master password", u.length === 1 && u[0].ok, u);

  // ---------------------------------------------------------------- second SSO login (fresh install): master password step
  resetStorage();
  svc = new VaultService(() => {});
  await svc.ready;
  flows = new LoginFlows(svc, { async openLoginWindow() {}, async focusLoginWindow() {}, changed() {} });
  f = await flows.startSso({ server: "selfhosted", baseUrl: BASE, email: "", orgIdentifier: ident! });
  connector = await runIdp(opened.tabs.at(-1)!, "anna@sso.test");
  await flows.onTabUpdated(1002, connector);
  f = (await flows.current())!;
  check("existing SSO user → master password step", f.step === "mp" && f.email === "anna@sso.test", f);
  f = await flows.submitMasterPassword({ password: "falsch" });
  check("wrong master password", f.step === "mp" && !!f.error, f);
  f = await flows.submitMasterPassword({ password: "SSO-Master-Passwort-1" });
  check("SSO + master password → done", f.step === "done", f);
  await flows.ack();
  const v = await svc.getVault();
  check(
    "vault decrypted after SSO",
    v.items.some((i) => i.name === "SSO-Test"),
    v.items.map((i) => i.name),
  );

  // ---------------------------------------------------------------- state mismatch is rejected
  f = await flows.startSso({ server: "selfhosted", baseUrl: BASE, email: "", orgIdentifier: ident! });
  await flows.onTabUpdated(1003, BASE + "/sso-connector.html?code=abc&state=falsch");
  f = (await flows.current())!;
  check("forged state rejected", f.step === "error" && /state/.test(f.error ?? ""), f);
  await flows.ack();

  // ---------------------------------------------------------------- closing the IdP tab cancels
  f = await flows.startSso({ server: "selfhosted", baseUrl: BASE, email: "", orgIdentifier: ident! });
  const st = (await flows.current())!;
  check("sso-wait again", st.step === "sso-wait");
  await flows.onTabRemoved(opened.tabs.length + 1000);
  f = (await flows.current())!;
  check("tab closed → aborted", f.step === "error" && /abgebrochen/.test(f.error ?? ""), f);
  await flows.cancel();

  // ---------------------------------------------------------------- password login is refused for SSO-only? (VW allows) → still works
  const pw = await flows.startPassword({ server: "selfhosted", baseUrl: BASE, email: "anna@sso.test", password: "SSO-Master-Passwort-1" });
  check("password login of SSO user (allowed by VW)", pw.step === "done", pw);

  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
