// Node integration test of VaultService + login flows against local Vaultwarden (chrome.* stubbed)
import { localData as mem, loginUi, sessionData as sess } from "./chrome-stub";
import { LoginFlows } from "../src/background/login-flow";
import { VaultService } from "../src/background/vault-service";
import { CipherType } from "../src/shared/types";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

(async () => {
  const events: string[] = [];
  const svc = new VaultService((e) => events.push(e));
  await svc.ready;
  const flows = new LoginFlows(svc, loginUi);
  const login = async (p: { server: "selfhosted"; baseUrl: string; email: string; password: string }) => {
    const f = await flows.startPassword(p);
    await flows.ack();
    return f.step === "done" ? { status: "ok" as const, f } : { status: f.step, f };
  };
  const PW = "Test-Passwort-123!";
  let r = await login({ server: "selfhosted", baseUrl: "http://localhost:8001", email: "alex@privat.test", password: "falsch" });
  check("wrong password rejected", r.status === "error", r);
  r = await login({ server: "selfhosted", baseUrl: "http://localhost:8001", email: "Alex@Privat.test ", password: PW });
  check("login A", r.status === "ok", r);
  r = await login({ server: "selfhosted", baseUrl: "http://localhost:8002", email: "alex@firma.test", password: PW });
  check("login B (argon2)", r.status === "ok", r);
  r = await login({ server: "selfhosted", baseUrl: "http://localhost:8001", email: "familie@privat.test", password: PW });
  check("login A2 (same server)", r.status === "ok", r);
  const accs = svc.publicAccounts();
  check("3 accounts unlocked", accs.length === 3 && accs.every((a) => a.status === "unlocked"), accs);
  const v = await svc.getVault();
  check("items from all accounts", v.items.length === 16, v.items.length);
  check(
    "no decrypt errors",
    v.items.every((i) => !i.decryptError),
    v.items.filter((i) => i.decryptError),
  );
  check(
    "folders",
    v.folders
      .map((f) => f.name)
      .sort()
      .join(",") === "Banking,Infrastruktur,Social Media",
    v.folders,
  );
  check(
    "collections",
    v.collections
      .map((c) => c.name)
      .sort()
      .join(",") === "Gemeinsam,Streaming",
    v.collections,
  );
  check("org", v.organizations.length === 1 && v.organizations[0].name === "Familie Beispiel", v.organizations);
  const net = v.items.find((i) => i.name === "Netflix");
  check("org item decrypted", net?.login?.password === "netflix-fam" && net.collectionIds.length === 1, net);
  const legacy = v.items.find((i) => i.name.startsWith("Altes Forum"));
  check("legacy item w/o cipher key", legacy?.login?.password === "legacy-pw" && legacy.login.uris.length === 1, legacy);
  const card = v.items.find((i) => i.type === CipherType.Card);
  check("card", card?.card?.number === "4111111111111111", card);
  const ssh = v.items.find((i) => i.type === CipherType.SshKey);
  check("ssh", !!ssh?.sshKey?.publicKey?.startsWith("ssh-ed25519"), ssh);
  const m = await svc.matchesForUrl("http://localhost:9000/login.html");
  check(
    "matches across accounts",
    m.length === 4,
    m.map((x) => x.name),
  );
  const m2 = await svc.matchesForUrl("https://github.com/login");
  check(
    "github matches 2 accounts",
    m2.length === 2,
    m2.map((x) => x.name),
  );

  // save new item into account B
  const bKey = accs.find((a) => a.email === "alex@firma.test")!.key;
  const saved = await svc.saveItem(
    bKey,
    {
      id: "",
      accountKey: bKey,
      type: CipherType.Login,
      name: "Neu angelegt",
      favorite: false,
      reprompt: 0,
      edit: true,
      viewPassword: true,
      collectionIds: [],
      fields: [{ name: "x", value: "y", type: 0 }],
      passwordHistory: [],
      attachments: [],
      login: { username: "neu", password: "neu-pw", uris: [{ uri: "https://neu.example" }], passkeys: 0 },
    } as any,
    true,
  );
  check("create item", saved?.name === "Neu angelegt" && saved.login?.uris.length === 1, saved);
  // edit it
  const edited = await svc.saveItem(bKey, { ...saved!, name: "Neu bearbeitet", login: { ...saved!.login!, password: "geaendert" } }, false);
  check("edit item", edited?.name === "Neu bearbeitet" && edited.login?.password === "geaendert", edited);
  // edit legacy (no key) item
  const aKey = accs.find((a) => a.email === "alex@privat.test")!.key;
  const le = await svc.saveItem(aKey, { ...legacy!, notes: "jetzt mit Notiz" }, false);
  check("edit legacy item", le?.notes === "jetzt mit Notiz" && le.login?.password === "legacy-pw", le);
  // new org item
  const col = v.collections.find((c) => c.name === "Gemeinsam")!;
  const oi = await svc.saveItem(
    aKey,
    {
      id: "",
      accountKey: aKey,
      organizationId: col.organizationId,
      collectionIds: [col.id],
      type: CipherType.SecureNote,
      name: "Org-Notiz",
      notes: "geteilt",
      favorite: false,
      reprompt: 0,
      edit: true,
      viewPassword: true,
      fields: [],
      passwordHistory: [],
      attachments: [],
      secureNote: { type: 0 },
    } as any,
    true,
  );
  check("create org item", oi?.notes === "geteilt" && oi.organizationId === col.organizationId, oi);

  // fresh service: lock state persisted? session restored
  const svc2 = new VaultService(() => {});
  await svc2.ready;
  check(
    "session restore",
    svc2.publicAccounts().every((a) => a.status === "unlocked"),
  );
  const v2 = await svc2.getVault();
  check("vault from cache", v2.items.length === v.items.length + 2, [v2.items.length, v.items.length]);
  await svc2.lock();
  check(
    "locked",
    svc2.publicAccounts().every((a) => a.status === "locked"),
  );
  const ur = await svc2.unlock("falsch");
  check(
    "unlock wrong",
    ur.every((x) => !x.ok),
  );
  const ur2 = await svc2.unlock(PW);
  check("unlock all", ur2.length === 3 && ur2.every((x) => x.ok), ur2);
  const v3 = await svc2.getVault();
  check("vault after unlock", v3.items.length === v2.items.length, v3.items.length);
  // sync again
  const errs = await svc2.syncAll();
  check("sync all", Object.keys(errs).length === 0, errs);
  await svc2.deleteItem(bKey, saved!.id);
  const v4 = await svc2.getVault();
  check("soft delete", !!v4.items.find((i) => i.id === saved!.id)?.deletedDate);
  await svc2.restoreItem(bKey, saved!.id);
  await svc2.deleteItem(bKey, saved!.id, true);
  const v5 = await svc2.getVault();
  check("permanent delete", !v5.items.find((i) => i.id === saved!.id));
  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
