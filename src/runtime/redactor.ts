// Streaming secret redactor: redacts COMPLETE token units BEFORE release.
// A possible-secret region is held in a bounded carry until it is either
// (a) closed by a delimiter — then evaluated and redacted, or (b) found to be
// overlong — then the whole run is dropped and further token chars keep
// dropping until a delimiter arrives. Additionally the trailing token-run is
// always held (never split across a release) so a secret arriving at ANY
// delta boundary stays opaque; ordinary text ends mid-word, never redacted.
// On flush, a CONFIRMED open region (complete marker + token run) is
// redacted, while an UNCONFIRMED partial-prefix tail is ordinary text and is
// released — "Bearer" alone survives, "Bearer <40 token chars>" does not.
// Known exact in-memory secrets (router/Jev values) are matched verbatim at
// every release via a compiled matcher. Best-effort for known shapes — not
// a DLP guarantee.
import { redactText } from "../decisions/jev.js";

// Secret-shape prefixes. A token run starting with any of these is always
// redacted, regardless of tail length (over-redaction is fail-safe).
const SECRET_PREFIXES = [
  "sk-", "pk-", "xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-",
  "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_",
  "AIza", "AKIA", "ASIA", "ya29.", "glpat-", "sk_live_", "rk_live_",
  "-----BEGIN",
];
// Assignment-style markers: the token follows the marker.
const SECRET_MARKERS = ["bearer ", "token=", "api_key=", "apikey=", "secret=", "access_token="];

const TOKEN_CHAR = /[A-Za-z0-9_\-+/=.]/;
const isTokenChar = (ch: string | undefined) => ch !== undefined && TOKEN_CHAR.test(ch);

// Bounded carry: a suspected secret run longer than this is dropped wholesale
// so an unterminated token flood cannot grow memory or leak a suffix.
const MAX_HOLD = 4096;
const MAX_PREFIX = Math.max(...SECRET_PREFIXES.map((p) => p.length), ...SECRET_MARKERS.map((p) => p.length));

// confirmed: the region already contains a COMPLETE marker/exact match and
// is open only because its token run is unterminated — redact on flush.
// unconfirmed open regions are partial prefixes that may yet be ordinary
// text — release on flush.
interface Region { start: number; end: number; open: boolean; confirmed: boolean }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Compile a matcher for exact known in-memory secrets (router/Jev values).
// Only values with real entropy qualify — short common words would
// over-redact ordinary text.
export function exactSecretMatcher(secrets: readonly (string | undefined | null)[]): RegExp | null {
  const parts = [...new Set(secrets.filter((s): s is string => typeof s === "string" && s.length >= 6))].map(escapeRe);
  return parts.length ? new RegExp(parts.join("|"), "g") : null;
}

export class DeltaRedactor {
  private pending = "";
  private dropping = false; // overlong run being swallowed until a delimiter
  private exact: RegExp | null;

  constructor(secrets: string[] = []) {
    // raw list retained for region scanning (proper-prefix holds); the regex
    // matches complete occurrences at release. Values only — never logged.
    this._secrets = secrets.filter((s) => typeof s === "string" && s.length >= 6).slice(0, 64);
    this.exact = exactSecretMatcher(this._secrets);
  }

  get pendingLen(): number {
    return this.pending.length;
  }

  // Generic shape redaction + exact known secrets, applied to every release.
  private redactFinal(s: string): string {
    let out = redactText(s);
    if (this.exact) out = out.replace(this.exact, "[REDACTED]");
    return out;
  }

  feed(delta: string): string {
    this.pending += delta;
    let out = "";
    for (;;) {
      if (this.dropping) {
        let i = 0;
        while (i < this.pending.length && isTokenChar(this.pending[i])) i++;
        if (i === this.pending.length) { this.pending = ""; return out; }
        this.pending = this.pending.slice(i);
        this.dropping = false;
      }
      const region = this.earliestRegion(this.pending);
      if (!region) {
        // Hold the trailing token-run: it may be an in-flight secret whose
        // terminator hasn't arrived. Releasing it would split a secret at
        // the release boundary — the exact matcher only sees whole runs.
        let j = this.pending.length;
        while (j > 0 && isTokenChar(this.pending[j - 1])) j--;
        out += this.redactFinal(this.pending.slice(0, j));
        this.pending = this.pending.slice(j);
        if (this.pending.length > MAX_HOLD) {
          out += "[REDACTED]";
          this.pending = "";
          this.dropping = true;
        }
        return out;
      }
      out += this.redactFinal(this.pending.slice(0, region.start));
      if (region.open) {
        // hold the suspected secret; drop if it outgrows the bounded carry
        this.pending = this.pending.slice(region.start);
        if (this.pending.length > MAX_HOLD) {
          out += "[REDACTED]";
          this.pending = "";
          this.dropping = true;
        }
        return out;
      }
      out += "[REDACTED]";
      this.pending = this.pending.slice(region.end);
    }
  }

  flush(): string {
    // end of stream: a confirmed secret-shape run is redacted; a partial
    // prefix tail is ordinary text and is released (never silently eaten).
    let out = "";
    for (;;) {
      if (this.dropping) {
        let i = 0;
        while (i < this.pending.length && isTokenChar(this.pending[i])) i++;
        this.pending = this.pending.slice(i);
        this.dropping = false;
        if (!this.pending.length) return out;
      }
      const region = this.earliestRegion(this.pending);
      if (!region) {
        out += this.redactFinal(this.pending);
        this.pending = "";
        return out;
      }
      out += this.redactFinal(this.pending.slice(0, region.start));
      if (region.open && !region.confirmed) {
        out += this.redactFinal(this.pending.slice(region.start));
        this.pending = "";
        return out;
      }
      out += "[REDACTED]";
      this.pending = region.open ? "" : this.pending.slice(region.end);
    }
  }

  // Earliest sensitive region in s: a complete secret/secret-shape match, or
  // an OPEN region — a suspected secret still forming at end-of-buffer that
  // must be held until a delimiter (or the carry bound) decides it.
  private earliestRegion(s: string): Region | null {
    let best: Region | null = null;
    const consider = (r: Region) => {
      if (!best || r.start < best.start) best = r;
    };
    // 1) secret-shape prefixes and assignment markers — matched
    //    case-insensitively, so patterns are searched lowercase.
    const lower = s.toLowerCase();
    for (const p of [...SECRET_PREFIXES, ...SECRET_MARKERS].map((x) => x.toLowerCase())) {
      let idx = 0;
      for (;;) {
        const at = lower.indexOf(p, idx);
        if (at < 0) break;
        // prefix must start at a boundary (start or non-token char)
        if (at === 0 || !isTokenChar(s[at - 1])) {
          let end = at + p.length;
          while (end < s.length && isTokenChar(s[end])) end++;
          // open + confirmed: marker is complete, only the run is pending
          consider({ start: at, end, open: end === s.length, confirmed: true });
        }
        idx = at + 1;
      }
    }
    // 2) exact known secrets: complete match, or an open region whose suffix
    //    is a proper prefix of a known secret (unconfirmed — may be text)
    for (const sec of this._secrets) {
      let idx = 0;
      for (;;) {
        const at = s.indexOf(sec, idx);
        if (at < 0) break;
        consider({ start: at, end: at + sec.length, open: false, confirmed: true });
        idx = at + 1;
      }
      const maxTail = Math.min(sec.length - 1, s.length);
      for (let len = maxTail; len >= 4; len--) {
        if (s.endsWith(sec.slice(0, len))) {
          consider({ start: s.length - len, end: s.length, open: true, confirmed: false });
          break;
        }
      }
    }
    // 3) a trailing partial prefix of any secret-shape marker (e.g. "...sk").
    //    Same boundary rule: a marker can't start inside a token ("x" in
    //    "suffix" is not an xox* beginning). UNCONFIRMED — released on flush.
    const tailStart = Math.max(0, s.length - MAX_PREFIX);
    for (let i = tailStart; i < s.length; i++) {
      if (i > 0 && isTokenChar(s[i - 1])) continue;
      const tail = lower.slice(i);
      if (SECRET_PREFIXES.some((p) => p.toLowerCase().startsWith(tail)) || SECRET_MARKERS.some((p) => p.toLowerCase().startsWith(tail))) {
        consider({ start: i, end: s.length, open: true, confirmed: false });
        break;
      }
    }
    return best;
  }

  private _secrets: string[] = [];
}

// ---------- shared recursive redaction for persisted/exported records ----------

const DEEP_MAX_NODES = 4096;
const DEEP_MAX_DEPTH = 16;
const DEEP_MAX_STRING = 262144;

// Recursively redact every string leaf in an arbitrary record — shape
// patterns plus exact configured secrets. Used for everything that lands in
// the durable event log or the exported job result. Best-effort — NOT a DLP
// guarantee.
export function redactDeep(value: unknown, exact?: RegExp | null): unknown {
  const budget = { n: 0 };
  const walk = (v: unknown, depth: number): unknown => {
    if (budget.n++ > DEEP_MAX_NODES) return "[TRUNCATED]";
    if (typeof v === "string") {
      let out = redactText(v);
      if (exact) out = out.replace(exact, "[REDACTED]");
      return out.length > DEEP_MAX_STRING ? out.slice(0, DEEP_MAX_STRING) + "…[truncated]" : out;
    }
    if (v === null || typeof v !== "object") return v;
    if (depth >= DEEP_MAX_DEPTH) return "[TRUNCATED]";
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) out[k] = walk(o[k], depth + 1);
    return out;
  };
  return walk(value, 0);
}

// Collect the exact in-memory secrets a Runtime must never let reach a
// persisted record or exported payload: principal bearer tokens, the Jev API
// key (named env var, read for redaction only — never propagated), and
// high-entropy operator profile env values.
export function collectRuntimeSecrets(config: {
  principals?: { token: string }[];
  profiles?: Record<string, { env?: Record<string, string> }>;
  jev?: { api_key_env?: string };
}): string[] {
  const out: string[] = [];
  for (const p of config.principals ?? []) out.push(p.token);
  for (const prof of Object.values(config.profiles ?? {})) {
    for (const v of Object.values(prof.env ?? {})) if (v.length >= 16) out.push(v);
  }
  const jevEnv = config.jev?.api_key_env;
  if (jevEnv) {
    const key = process.env[jevEnv];
    if (key) out.push(key);
  }
  return out;
}
