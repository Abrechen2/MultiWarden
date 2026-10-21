// Regression tests for the autofill hardening of this fork: URI matching must not cross private
// suffixes or app schemes, basic auth must not downgrade https logins, card data must not be
// sprayed into cross-origin frames, and device-login approval must encrypt to the key the user saw.
import "./chrome-stub";
import { makeMatchContext, uriMatches } from "../src/shared/uri";
import { CipherType, UriMatch } from "../src/shared/types";
import * as autofill from "../src/background/autofill";
import * as basicAuth from "../src/background/basic-auth";
import { VaultService } from "../src/background/vault-service";
import { b64encode, generateCbcHmacKey } from "../src/crypto/bw";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

const m = (cipherUri: string, url: string, match: UriMatch, eq: string[][] = []) =>
  uriMatches(cipherUri, match, makeMatchContext(url, eq), UriMatch.Domain);

const login = (uris: string[], extra: any = {}): any => ({
  accountKey: "a",
  id: "i" + Math.random(),
  type: CipherType.Login,
  reprompt: 0,
  fields: [],
  login: { username: "u", password: "p", uris: uris.map((uri) => ({ uri, match: null })) },
  ...extra,
});

// --- executeScript stub: collect returns the given frames, fill records what it was sent
let frames: { frameId: number; result: any }[] = [];
let fills: { frameId: number; data: any }[] = [];
(globalThis as any).chrome.scripting = {
  executeScript: async (o: any) => {
    if (o.target.allFrames) return o.files ? [] : frames.map((f) => ({ frameId: f.frameId, result: f.result }));
    const frameId = o.target.frameIds[0];
    fills.push({ frameId, data: o.args?.[0] });
    return [{ frameId, result: { filled: 1 } }];
  },
};
const frame = (frameId: number, origin: string, extra: any = {}) => ({
  frameId,
  result: {
    url: origin + "/checkout",
    origin,
    hasPassword: false,
    hasNewPassword: false,
    hasUsername: false,
    hasTotp: false,
    cardFields: 0,
    hasCardNumber: false,
    identityFields: 0,
    fields: [],
    ...extra,
  },
});
const fakeSvc: any = { markUsed: async () => {}, events: { collect() {} }, itemMatchesUrl: () => true };
const card: any = { accountKey: "a", id: "c", type: CipherType.Card, reprompt: 0, fields: [], card: { number: "4111111111111111", code: "123" } };

(async () => {
  // 1: private suffixes
  check("domain: a.github.io does not match b.github.io", !m("https://a.github.io", "https://b.github.io/x", UriMatch.Domain));
  check("domain: x.herokuapp.com does not match y.herokuapp.com", !m("https://x.herokuapp.com", "https://y.herokuapp.com", UriMatch.Domain));
  check("domain: a.pages.dev does not match b.pages.dev", !m("a.pages.dev", "https://b.pages.dev/", UriMatch.Domain));
  check("domain: same private subdomain still matches", m("https://a.github.io/login", "https://a.github.io/x", UriMatch.Domain));
  check("domain: login.example.com matches www.example.com", m("https://login.example.com", "https://www.example.com/a", UriMatch.Domain));
  check("domain: schemeless uri still matches", m("example.com", "https://www.example.com/a", UriMatch.Domain));
  check("domain: equivalent domains still match", m("https://google.de", "https://mail.google.com", UriMatch.Domain, [["google.com", "google.de"]]));

  // 2: app uris are not web domains
  for (const mt of [UriMatch.Domain, UriMatch.Host, UriMatch.StartsWith]) {
    check(`app uri androidapp://com.foo.app does not match https://foo.app (match ${mt})`, !m("androidapp://com.foo.app", "https://foo.app/", mt));
    check(`app uri iosapp://foo.app does not match https://foo.app (match ${mt})`, !m("iosapp://foo.app", "https://foo.app/", mt));
    check(`web uri https://foo.app does not match androidapp://com.foo.app (match ${mt})`, !m("https://foo.app", "androidapp://com.foo.app", mt));
  }
  check("app uri still matches the same app (host)", m("androidapp://com.foo.app", "androidapp://com.foo.app", UriMatch.Host));

  // 3: basic auth downgrade
  const pick = (basicAuth as any).pickBasicAuthItem;
  check("basic auth: pickBasicAuthItem exported", typeof pick === "function");
  if (typeof pick === "function") {
    const https = login(["https://intranet.example"]);
    const http = login(["http://intranet.example"]);
    check("basic auth: https-only login not sent to http challenge", pick([https], "http://intranet.example/") === undefined);
    check("basic auth: https-only login answers https challenge", pick([https], "https://intranet.example/") === https);
    check("basic auth: http login answers http challenge", pick([http], "http://intranet.example/") === http);
    check("basic auth: two matches → no answer", pick([http, login(["intranet.example"])], "http://intranet.example/") === undefined);
    check("basic auth: non-logins ignored", pick([{ ...http, type: CipherType.Card }], "http://intranet.example/") === undefined);
  }

  // 4: card / identity frame selection
  const sel = (autofill as any).cardIdentityTargets;
  check("frames: cardIdentityTargets exported", typeof sel === "function");
  if (typeof sel === "function") {
    const top = frame(0, "https://shop.example", { cardFields: 2, hasCardNumber: true, identityFields: 3 });
    const same = frame(1, "https://shop.example", { cardFields: 1, hasCardNumber: true });
    const evil = frame(2, "https://evil.example", { cardFields: 2, hasCardNumber: true, identityFields: 2 });
    const r1 = sel([top, same, evil].map((f) => ({ frameId: f.frameId, result: f.result })), { isCard: true });
    check("frames: card without confirmation only top + same-origin", JSON.stringify(r1.targets.map((x: any) => x.frameId)) === "[0,1]", r1);
    check("frames: skipped cross-origin card frame reported", r1.blockedCrossOrigin === true, r1);
    const r2 = sel([top, same, evil], { isCard: true, force: true });
    check("frames: card after confirmation includes cross-origin payment frame", JSON.stringify(r2.targets.map((x: any) => [x.frameId, x.crossOrigin])) === "[[0,false],[1,false],[2,true]]", r2);
    const r3 = sel([top, evil], { isCard: false, force: true });
    check("frames: identity never cross-origin", JSON.stringify(r3.targets.map((x: any) => x.frameId)) === "[0]", r3);
    const r4 = sel([top, evil], { isCard: true, frameId: 2 });
    check("frames: explicit frame (inline/context menu) is the only target", JSON.stringify(r4.targets.map((x: any) => x.frameId)) === "[2]", r4);
  }

  // 4 + 6: end to end through fillItem with a stubbed executeScript
  frames = [frame(0, "https://shop.example"), frame(3, "https://evil.example", { cardFields: 2, hasCardNumber: true })];
  fills = [];
  let r = await autofill.fillItem(fakeSvc, 1, card);
  check("fill: card not sent to cross-origin frame without confirmation", fills.length === 0, fills.map((f) => f.frameId));
  check("fill: asks for confirmation (mismatch code)", !r.ok && r.code === autofill.FILL_MISMATCH, r);
  fills = [];
  r = await autofill.fillItem(fakeSvc, 1, card, { force: true });
  check("fill: confirmed card goes to the payment frame", r.ok && fills.length === 1 && fills[0].frameId === 3, fills);
  check("fill: payment frame needs a card number field", fills[0]?.data?.requireCardNumber === true, fills[0]?.data);
  check("fill: expectOrigin is the matched frame origin", fills[0]?.data?.expectOrigin === "https://evil.example", fills[0]?.data);

  frames = [frame(0, "https://shop.example", { cardFields: 3, hasCardNumber: true }), frame(3, "https://evil.example", { cardFields: 2, hasCardNumber: true })];
  fills = [];
  r = await autofill.fillItem(fakeSvc, 1, card);
  check("fill: top-frame card fill skips the cross-origin frame", r.ok && JSON.stringify(fills.map((f) => f.frameId)) === "[0]", fills.map((f) => f.frameId));
  check("fill: top-frame expectOrigin", fills[0]?.data?.expectOrigin === "https://shop.example", fills[0]?.data);

  frames = [frame(0, "https://site.example", { hasPassword: true, hasUsername: true })];
  fills = [];
  r = await autofill.fillItem(fakeSvc, 1, login(["https://site.example"]));
  check("fill: login expectOrigin", r.ok && fills[0]?.data?.expectOrigin === "https://site.example", fills[0]?.data);
  fills = [];
  await (autofill.fillGenerated as any)(1, 0, "pw", undefined, "https://site.example");
  check("fill: generated password expectOrigin", fills[0]?.data?.expectOrigin === "https://site.example", fills[0]?.data);

  // 5: device-login approval must use the key the user verified
  const kp = (await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  const kp2 = (await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  const shown = b64encode(new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey)));
  const swapped = b64encode(new Uint8Array(await crypto.subtle.exportKey("spki", kp2.publicKey)));
  const mkSvc = (serverKey: string) => {
    const puts: any[] = [];
    const svc: any = Object.create(VaultService.prototype);
    svc.deviceId = "dev";
    svc.account = () => ({ key: "a", email: "u@example.com" });
    svc.unlocked = new Map([["a", { userKey: generateCbcHmacKey() }]]);
    svc.api = () => ({
      send: async (method: string, path: string, body?: any) => {
        if (method === "GET") return { id: "r1", publicKey: serverKey };
        puts.push({ path, body });
        return {};
      },
    });
    return { svc, puts };
  };
  {
    const { svc, puts } = mkSvc(swapped);
    const err = await svc.respondAuthRequest("a", "r1", true, shown).then(() => null, (e: any) => e);
    check("auth request: swapped public key refused", !!err && puts.length === 0, { err: String(err), puts: puts.length });
    check("auth request: refusal carries a message", !!err?.message && !/undefined/.test(err.message), String(err));
  }
  {
    const { svc, puts } = mkSvc(shown);
    const err = await svc.respondAuthRequest("a", "r1", true).then(() => null, (e: any) => e);
    check("auth request: approval without the shown key refused", !!err && puts.length === 0, { err: String(err), puts: puts.length });
  }
  {
    const { svc, puts } = mkSvc(shown);
    await svc.respondAuthRequest("a", "r1", true, shown);
    check("auth request: approval with the shown key encrypts", puts.length === 1 && puts[0].body.requestApproved === true && !!puts[0].body.key, puts);
  }
  {
    const { svc, puts } = mkSvc(swapped);
    await svc.respondAuthRequest("a", "r1", false);
    check("auth request: deny needs no key", puts.length === 1 && puts[0].body.requestApproved === false && puts[0].body.key === "", puts);
  }
  {
    const { svc } = mkSvc(shown);
    svc.api = () => ({ send: async () => ({ data: [{ id: "r1", publicKey: shown, creationDate: new Date().toISOString() }] }) });
    svc.unlocked = new Map([["a", {}]]);
    const list = await svc.pendingAuthRequests("a");
    check("auth request: pending list carries the public key shown", list[0]?.publicKey === shown, list[0]);
  }

  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
})();
