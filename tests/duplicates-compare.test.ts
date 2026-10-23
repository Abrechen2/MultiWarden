// Duplicate check: per group, which fields are the same and which differ – secrets only as variants.
import "./chrome-stub";
import { compareGroup, findDuplicates } from "../src/shared/duplicates";
import { CipherType, ItemView } from "../src/shared/types";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

const login = (id: string, o: Partial<ItemView> & { username?: string; password?: string; totp?: string; uris?: string[] }): ItemView => ({
  id,
  accountKey: "a",
  collectionIds: [],
  type: CipherType.Login,
  name: o.name ?? "Example",
  notes: o.notes,
  favorite: false,
  reprompt: 0,
  edit: true,
  viewPassword: true,
  folderId: o.folderId ?? null,
  login: { username: o.username, password: o.password, totp: o.totp, uris: (o.uris ?? []).map((uri) => ({ uri })), passkeys: 0 },
  fields: o.fields ?? [],
  passwordHistory: [],
  attachments: [],
});

const folderName = (i: ItemView) => (i.folderId === "f1" ? "Privat" : i.folderId === "f2" ? "Arbeit" : "");

(() => {
  const items = [
    login("1", { name: "Example", username: "alex", password: "pw1", uris: ["https://example.com"], folderId: "f1" }),
    login("2", { name: "example.com", username: "alex", password: "pw2", uris: ["https://example.com"], folderId: "f2", notes: "n" }),
    login("3", { name: "Example", username: "alex", password: "pw1", uris: ["https://www.example.com/login"], folderId: "f1" }),
  ];
  const diff = compareGroup(items, folderName);
  const f = (key: string) => diff.find((d) => d.key === key);

  check("username is the same", f("username")?.same === true, f("username"));
  check("password differs", f("password")?.same === false, f("password"));
  check("name differs", f("name")?.same === false);
  check("folder differs", f("folder")?.same === false);
  check("notes differ (one empty)", f("notes")?.same === false);
  check("website differs (different URIs)", f("uris")?.same === false);
  check("empty fields everywhere are left out", !f("totp"), f("totp"));

  const pw = f("password")!;
  check("password is secret", pw.secret === true);
  check("secret values are not exposed", pw.values.every((v) => v === undefined), pw.values);
  check("same password → same variant", pw.variants[0] === pw.variants[2] && pw.variants[0] !== pw.variants[1], pw.variants);
  check("variants start at 0 in item order", pw.variants[0] === 0 && pw.variants[1] === 1, pw.variants);

  const name = f("name")!;
  check("non-secret values are shown", name.secret === false && name.values[1] === "example.com", name.values);
  const notes = f("notes")!;
  check("notes are treated as secret", notes.secret === true && notes.values.every((v) => v === undefined));
  check("empty value has variant -1", notes.variants[0] === -1 && notes.variants[1] === 0, notes.variants);

  // order: differing fields first, then same
  const firstSame = diff.findIndex((d) => d.same);
  check("differing fields come first", firstSame === -1 || diff.slice(firstSame).every((d) => d.same), diff.map((d) => d.key));

  // hidden custom fields are secret, text fields are not
  const withFields = [
    login("4", { username: "u", fields: [{ name: "PIN", value: "1234", type: 1 }, { name: "Kunde", value: "K1", type: 0 }] as any }),
    login("5", { username: "u", fields: [{ name: "PIN", value: "9999", type: 1 }, { name: "Kunde", value: "K1", type: 0 }] as any }),
  ];
  const d2 = compareGroup(withFields, folderName);
  const pin = d2.find((d) => d.key === "field:PIN");
  const kunde = d2.find((d) => d.key === "field:Kunde");
  check("hidden custom field secret and different", pin?.secret === true && pin.same === false, pin);
  check("text custom field visible and same", kunde?.secret === false && kunde.same === true && kunde.values[0] === "K1", kunde);

  // cards: number and code secret
  const card = (id: string, number: string, exp: string): ItemView => ({
    ...login(id, {}),
    type: CipherType.Card,
    login: undefined,
    card: { cardholderName: "Alex", number, code: "123", expMonth: exp, expYear: "2029" },
  });
  const d3 = compareGroup([card("6", "4111", "4"), card("7", "4111", "5")], folderName);
  check("card number secret", d3.find((d) => d.key === "card:number")?.secret === true);
  check("card expiry visible and different", d3.find((d) => d.key === "card:expMonth")?.same === false && d3.find((d) => d.key === "card:expMonth")?.secret === false);
  check("cardholder same", d3.find((d) => d.key === "card:cardholderName")?.same === true);

  // port rule, exact secrets, cross-account grouping
  const ip = (id: string, uri: string, o: Partial<ItemView> = {}) => ({ ...login(id, { username: "admin", password: "pw", uris: [uri] }), ...o });
  check("IP logins on different ports are not duplicates", findDuplicates([ip("p1", "http://10.0.0.5:8080"), ip("p2", "http://10.0.0.5:5765")]).length === 0);
  check("IP logins on the same port are duplicates", findDuplicates([ip("p1", "http://10.0.0.5:8080"), ip("p2", "https://10.0.0.5:8080/login")]).length === 1);
  check(
    "domain logins still group across ports",
    findDuplicates([ip("p1", "https://nas.example.de:8443"), ip("p2", "https://nas.example.de:5001")]).length === 1,
  );
  const ws = compareGroup([login("w1", { password: "pw" }), login("w2", { password: "pw " })], folderName);
  check("passwords differing only in whitespace differ", ws.find((d) => d.key === "password")?.same === false, ws);
  const ws2 = [login("w1", { password: "pw", uris: ["https://example.de"], username: "u" }), login("w2", { password: "pw ", uris: ["https://example.de"], username: "u" })];
  check("group samePassword is false for whitespace difference", findDuplicates(ws2)[0]?.samePassword === false);
  const nm = compareGroup([login("n1", { name: "Mail" }), login("n2", { name: "Mail " })], folderName);
  check("non-secret fields are still trimmed", nm.find((d) => d.key === "name")?.same === true, nm);
  const acc = (id: string, accountKey: string, o: Partial<ItemView> = {}) => ({ ...ip(id, "https://example.de"), accountKey, ...o });
  const cross = findDuplicates([acc("c1", "a"), acc("c2", "b")]);
  check("cross-account duplicates group", cross.length === 1 && cross[0].items.map((i) => i.accountKey).sort().join() === "a,b", cross);
  const shared = { organizationId: "o" };
  check("shared org item seen by two accounts is one item", findDuplicates([acc("x", "a", shared), acc("x", "b", shared)]).length === 0);
  const g3 = findDuplicates([acc("x", "a", shared), acc("x", "b", shared), acc("y", "a")]);
  check("shared pair plus personal copy is one group of 2", g3.length === 1 && g3[0].items.length === 2, g3);

  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})();
