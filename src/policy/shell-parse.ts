/**
 * A small POSIX-shell parser for the blocklist (§8): enough structure to judge commands by
 * what they run, not by substrings. It understands quoting, escapes, `$(…)`, backticks,
 * `<(…)`, subshells, `{ …; }`, `;` `&&` `||` `|` `&`, redirections and here-documents.
 * Anything it cannot parse is reported as an error, and the caller blocks it.
 */

export interface Redirect {
  readonly op: string;
  /** Target word (file) for file redirects; delimiter for here-docs. */
  readonly target: string;
  /** Here-document body. */
  readonly body?: string;
}

export interface SimpleCommand {
  readonly kind: "simple";
  /** Leading `NAME=value` words. */
  readonly assigns: string[];
  /** Words after quote removal (expansions like `$X` stay literal). */
  readonly words: string[];
  readonly redirects: Redirect[];
  /** Scripts inside `$(…)`, backticks and `<(…)` that run as part of this command. */
  readonly substitutions: Script[];
}

export interface SubshellCommand {
  readonly kind: "subshell";
  readonly script: Script;
  readonly redirects: Redirect[];
}

export type Command = SimpleCommand | SubshellCommand;

/** Commands joined by `|`. */
export interface Pipeline {
  readonly commands: Command[];
}

export interface Script {
  readonly pipelines: Pipeline[];
}

export class ShellParseError extends Error {}

type WordToken = { t: "word"; value: string; subs: Script[] };
type Token =
  | WordToken
  | { t: "op"; value: string }
  | { t: "redir"; op: string; fd?: string; body?: string };

const OPS = ["&&", "||", ";;", ";", "|&", "|", "&", "(", ")", "\n"];

class Lexer {
  pos = 0;
  readonly tokens: Token[] = [];
  readonly pendingHeredocs: { delim: string; strip: boolean; set: (body: string) => void }[] = [];

  constructor(readonly src: string) {}

  peek(n = 0): string {
    return this.src.charAt(this.pos + n);
  }

  /** Reads up to the matching close paren of `$(` / `<(` (pos is just past the open paren). */
  readParenBody(): string {
    let depth = 1;
    const start = this.pos;
    let quote: string | undefined;
    while (this.pos < this.src.length) {
      const ch = this.src.charAt(this.pos);
      if (quote) {
        if (ch === "\\" && quote === '"') this.pos++;
        else if (ch === quote) quote = undefined;
      } else if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "\\") this.pos++;
      else if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          const body = this.src.slice(start, this.pos);
          this.pos++;
          return body;
        }
      }
      this.pos++;
    }
    throw new ShellParseError("unterminated $( … )");
  }

  readBacktick(): string {
    let out = "";
    while (this.pos < this.src.length) {
      const ch = this.src.charAt(this.pos++);
      if (ch === "\\" && this.pos < this.src.length) out += this.src.charAt(this.pos++);
      else if (ch === "`") return out;
      else out += ch;
    }
    throw new ShellParseError("unterminated backtick");
  }

  readWord(): WordToken {
    let value = "";
    const subs: Script[] = [];
    const sub = (body: string) => subs.push(parseScript(body));
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (
        /\s/.test(ch) ||
        OPS.some((op) => this.src.startsWith(op, this.pos)) ||
        this.isRedirStart()
      )
        break;
      this.pos++;
      if (ch === "\\") {
        const next = this.src.charAt(this.pos++);
        if (next !== "\n") value += next;
      } else if (ch === "'") {
        const end = this.src.indexOf("'", this.pos);
        if (end === -1) throw new ShellParseError("unterminated single quote");
        value += this.src.slice(this.pos, end);
        this.pos = end + 1;
      } else if (ch === "$" && this.peek() === "'") {
        this.pos++;
        value += this.readAnsiC();
      } else if (ch === '"') {
        value += this.readDouble(sub);
      } else if (ch === "$" && this.peek() === "(" && this.peek(1) !== "(") {
        this.pos++;
        const body = this.readParenBody();
        sub(body);
        value += `$(${body})`;
      } else if ((ch === "<" || ch === ">") && this.peek() === "(") {
        this.pos++;
        const body = this.readParenBody();
        sub(body);
        value += `${ch}(${body})`;
      } else if (ch === "`") {
        const body = this.readBacktick();
        sub(body);
        value += `$(${body})`;
      } else {
        value += ch;
      }
    }
    return { t: "word", value, subs };
  }

  readAnsiC(): string {
    let out = "";
    const map: Record<string, string> = {
      n: "\n",
      t: "\t",
      r: "\r",
      "\\": "\\",
      "'": "'",
      '"': '"',
      a: "\u0007",
      e: "\u001b",
    };
    while (this.pos < this.src.length) {
      const ch = this.src.charAt(this.pos++);
      if (ch === "'") return out;
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const esc = this.src.charAt(this.pos++);
      if (esc === "x") {
        const hex = this.src.slice(this.pos).match(/^[0-9a-fA-F]{1,2}/)?.[0] ?? "";
        this.pos += hex.length;
        out += String.fromCharCode(Number.parseInt(hex || "0", 16));
      } else if (/[0-7]/.test(esc)) {
        const oct = esc + (this.src.slice(this.pos).match(/^[0-7]{0,2}/)?.[0] ?? "");
        this.pos += oct.length - 1;
        out += String.fromCharCode(Number.parseInt(oct, 8));
      } else {
        out += map[esc] ?? esc;
      }
    }
    throw new ShellParseError("unterminated $'…'");
  }

  readDouble(sub: (body: string) => void): string {
    let out = "";
    while (this.pos < this.src.length) {
      const ch = this.src.charAt(this.pos++);
      if (ch === '"') return out;
      if (ch === "\\") {
        const next = this.src.charAt(this.pos++);
        out += '$`"\\\n'.includes(next) ? (next === "\n" ? "" : next) : `\\${next}`;
      } else if (ch === "$" && this.peek() === "(" && this.peek(1) !== "(") {
        this.pos++;
        const body = this.readParenBody();
        sub(body);
        out += `$(${body})`;
      } else if (ch === "`") {
        const body = this.readBacktick();
        sub(body);
        out += `$(${body})`;
      } else {
        out += ch;
      }
    }
    throw new ShellParseError("unterminated double quote");
  }

  isRedirStart(): boolean {
    const rest = this.src.slice(this.pos);
    if (/^\d*(<<<|<<-|<<|>>|>&|<&|<>|>\||>|<)/.test(rest) && !/^\d*[<>]\(/.test(rest)) {
      // A digit run only counts as an fd if a redirection follows immediately.
      return /^\d+[<>]/.test(rest) ? true : /^[<>]/.test(rest);
    }
    return /^&>/.test(rest);
  }

  readHeredocs(): void {
    // Here-doc bodies start after the newline that ends the command line.
    for (const doc of this.pendingHeredocs.splice(0)) {
      const lines: string[] = [];
      for (;;) {
        if (this.pos >= this.src.length)
          throw new ShellParseError(`here-document ${doc.delim} not terminated`);
        const nl = this.src.indexOf("\n", this.pos);
        const line = this.src.slice(this.pos, nl === -1 ? undefined : nl);
        this.pos = nl === -1 ? this.src.length : nl + 1;
        const check = doc.strip ? line.replace(/^\t+/, "") : line;
        if (check === doc.delim) break;
        lines.push(check);
      }
      doc.set(lines.join("\n"));
    }
  }

  lex(): Token[] {
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (ch === "\n") {
        this.pos++;
        this.tokens.push({ t: "op", value: "\n" });
        this.readHeredocs();
        continue;
      }
      if (/\s/.test(ch)) {
        this.pos++;
        continue;
      }
      if (ch === "#" && (this.tokens.length === 0 || this.src.charAt(this.pos - 1).match(/\s|;/))) {
        const nl = this.src.indexOf("\n", this.pos);
        this.pos = nl === -1 ? this.src.length : nl;
        continue;
      }
      if (this.isRedirStart()) {
        const m = this.src.slice(this.pos).match(/^(\d*)(<<<|<<-|<<|&>>|&>|>>|>&|<&|<>|>\||>|<)/);
        if (!m) throw new ShellParseError("bad redirection");
        this.pos += m[0].length;
        this.tokens.push({ t: "redir", op: m[2] ?? "", ...(m[1] ? { fd: m[1] } : {}) });
        continue;
      }
      const op = OPS.find((o) => this.src.startsWith(o, this.pos));
      if (op) {
        this.pos += op.length;
        this.tokens.push({ t: "op", value: op });
        continue;
      }
      const word = this.readWord();
      const prev = this.tokens.at(-1);
      if (prev?.t === "redir" && (prev.op === "<<" || prev.op === "<<-")) {
        // The body follows the end of this command line.
        this.pendingHeredocs.push({
          delim: word.value,
          strip: prev.op === "<<-",
          set: (body) => {
            prev.body = body;
          },
        });
      }
      this.tokens.push(word);
    }
    if (this.pendingHeredocs.length > 0) this.readHeredocs();
    return this.tokens;
  }
}

const SKIP_WORDS = new Set([
  "then",
  "else",
  "elif",
  "do",
  "done",
  "fi",
  "esac",
  "{",
  "}",
  "!",
  "in",
]);
const HEADER_WORDS = new Set(["for", "select", "case"]);

class Parser {
  i = 0;
  constructor(readonly tokens: Token[]) {}

  peek(): Token | undefined {
    return this.tokens[this.i];
  }

  script(stopAtParen: boolean): Script {
    const pipelines: Pipeline[] = [];
    for (;;) {
      const tok = this.peek();
      if (tok === undefined) break;
      if (tok.t === "op" && tok.value === ")") {
        if (stopAtParen) break;
        throw new ShellParseError("unexpected )");
      }
      if (tok.t === "op" && [";", "\n", "&", "&&", "||", ";;"].includes(tok.value)) {
        this.i++;
        continue;
      }
      pipelines.push(this.pipeline());
    }
    return { pipelines };
  }

  pipeline(): Pipeline {
    const commands: Command[] = [this.command()];
    for (;;) {
      const tok = this.peek();
      if (tok?.t === "op" && (tok.value === "|" || tok.value === "|&")) {
        this.i++;
        commands.push(this.command());
      } else {
        return { commands };
      }
    }
  }

  redirect(tok: { op: string; body?: string }, redirects: Redirect[]): void {
    const target = this.tokens[this.i++];
    if (target?.t !== "word") throw new ShellParseError(`missing target for ${tok.op}`);
    const body = tok.op === "<<<" ? target.value : tok.body;
    redirects.push({ op: tok.op, target: target.value, ...(body === undefined ? {} : { body }) });
  }

  command(): Command {
    const first = this.peek();
    if (first?.t === "op" && first.value === "(") {
      this.i++;
      const script = this.script(true);
      const close = this.tokens[this.i++];
      if (close?.t !== "op" || close.value !== ")") throw new ShellParseError("unterminated (");
      const redirects: Redirect[] = [];
      while (this.peek()?.t === "redir") {
        const r = this.tokens[this.i++] as { op: string; body?: string };
        this.redirect(r, redirects);
      }
      return { kind: "subshell", script, redirects };
    }
    const assigns: string[] = [];
    const words: string[] = [];
    const redirects: Redirect[] = [];
    const substitutions: Script[] = [];
    for (;;) {
      const tok = this.peek();
      if (tok === undefined || tok.t === "op") {
        // `name()` function definition: skip the parentheses.
        if (
          tok?.t === "op" &&
          tok.value === "(" &&
          words.length === 1 &&
          this.tokens[this.i + 1]?.t === "op"
        ) {
          this.i += 2;
          words.length = 0;
          continue;
        }
        break;
      }
      this.i++;
      if (tok.t === "redir") {
        this.redirect(tok, redirects);
        continue;
      }
      substitutions.push(...tok.subs);
      if (words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.value)) assigns.push(tok.value);
      else if (words.length === 0 && SKIP_WORDS.has(tok.value)) continue;
      else words.push(tok.value);
    }
    if (words.length > 0 && HEADER_WORDS.has(words[0] ?? "")) {
      // Loop/case headers name variables and patterns, not commands.
      return { kind: "simple", assigns, words: [], redirects, substitutions };
    }
    return { kind: "simple", assigns, words, redirects, substitutions };
  }
}

export function parseScript(src: string): Script {
  return new Parser(new Lexer(src).lex()).script(false);
}
