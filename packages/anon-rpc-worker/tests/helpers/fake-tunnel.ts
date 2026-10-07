/**
 * Stand-ins for the tunnel path: a `TunnelPort` that records every copy and
 * lets a test answer it with reply parts, and a TLS module whose "sessions"
 * pass bytes through (the handshake is one round trip and a request is
 * answered by whatever the test streams back).
 */
import { encodeTunnelReplyV1, type TopologyNode, type TunnelReplyV1, type TunnelRequestV1, type TunnelSendHandle, type TunnelSendOptions } from "@hisoka-io/nox-client";
import type { HttpParserLike, HttpReplyHead, NoxTlsBindings, TlsSessionLike } from "../../src/tls/module.js";
import type { TunnelPort } from "../../src/tls/tunnel.js";

export interface SentCopy {
  readonly exit: TopologyNode;
  readonly request: TunnelRequestV1;
  readonly options: TunnelSendOptions;
  readonly entryId: string;
  readonly mixId: string;
  /** Deliver a reply part to this copy (as the SDK would); returns the handler's verdict. */
  reply(part: TunnelReplyV1): "more" | "done" | "closed";
}

export function exitNode(id: string): TopologyNode {
  return { id, role: 2, capabilities: ["tunnel_v1"] } as unknown as TopologyNode;
}

export class FakeTunnelPort implements TunnelPort {
  readonly sent: SentCopy[] = [];
  exits: TopologyNode[] = [exitNode("exit-1"), exitNode("exit-2"), exitNode("exit-3")];
  /** Called on every copy; the default leaves it unanswered. */
  onSend: (copy: SentCopy) => void = () => undefined;
  private routes = 0;

  tunnelExits(): TopologyNode[] {
    return this.exits;
  }

  tunnelSend(exit: TopologyNode, request: TunnelRequestV1, options: TunnelSendOptions): TunnelSendHandle {
    this.routes += 1;
    let closed = false;
    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    done.catch(() => undefined);
    const finish = (error?: unknown): void => {
      if (closed) return;
      closed = true;
      if (error === undefined) resolveDone();
      else rejectDone(error);
    };
    options.signal?.addEventListener("abort", () => finish(Object.assign(new Error("aborted"), { code: "ABORTED" })), { once: true });
    if (options.surbs === 0) finish();
    const copy: SentCopy = {
      exit,
      request,
      options,
      entryId: `entry-${this.routes}`,
      mixId: `mix-${this.routes}`,
      reply: (part) => {
        if (closed) return "closed";
        const verdict = options.onReply?.(encodeTunnelReplyV1(part)) ?? "more";
        if (verdict === "done") finish();
        return verdict;
      },
    };
    this.sent.push(copy);
    this.onSend(copy);
    return { entryId: copy.entryId, mixId: copy.mixId, done };
  }
}

const text = new TextEncoder();
const decode = new TextDecoder();

/**
 * A pass-through "TLS" session: the ClientHello is `HELLO`; any bytes during
 * the handshake are the server flight, after which `FIN` waits to be sent;
 * afterwards every byte is plaintext both ways. `ALERT` from the server fails
 * like a TLS alert.
 */
export class FakeTlsSession implements TlsSessionLike {
  handshaking = true;
  closeNotify = false;
  closed = false;
  freed = false;
  private outgoing: Uint8Array[] = [text.encode("HELLO")];
  private plaintext: Uint8Array[] = [];

  takeOutgoing(): Uint8Array {
    const out = concat(this.outgoing);
    this.outgoing = [];
    return out;
  }

  pushIncoming(data: Uint8Array): void {
    if (decode.decode(data).includes("ALERT")) throw Object.assign(new Error("received fatal alert"), { code: "TLS_ALERT_RECEIVED" });
    if (this.handshaking) {
      this.handshaking = false;
      this.outgoing.push(text.encode("FIN"));
      return;
    }
    this.plaintext.push(data);
  }

  pushTransportEof(): void {
    this.closed = true;
  }

  isHandshaking(): boolean {
    return this.handshaking;
  }

  wantsWrite(): boolean {
    return this.outgoing.length > 0;
  }

  closeNotifyReceived(): boolean {
    return this.closeNotify;
  }

  isClosed(): boolean {
    return this.closed || this.closeNotify;
  }

  writePlaintext(data: Uint8Array): void {
    this.outgoing.push(data);
  }

  takePlaintext(): Uint8Array {
    const out = concat(this.plaintext);
    this.plaintext = [];
    return out;
  }

  close(): void {
    this.outgoing.push(text.encode("CLOSE"));
  }

  protocol(): string {
    return "TLSv1_3";
  }

  free(): void {
    this.freed = true;
  }
}

/** A response is complete at `END`; its body is everything before it. */
export class FakeParser implements HttpParserLike {
  private buffer = "";
  private done = false;

  push(data: Uint8Array): boolean {
    this.buffer += decode.decode(data);
    this.done ||= this.buffer.includes("END");
    return this.done;
  }

  finishOnClose(closeNotify: boolean): void {
    if (!closeNotify) throw Object.assign(new Error("truncated"), { code: "HTTP_RESPONSE_TRUNCATED" });
    this.done = true;
  }

  response(): HttpReplyHead | null {
    if (!this.done) return null;
    const body = this.buffer.replace(/END[\s\S]*$/u, "");
    return { status: 200, headers: [["content-type", "text/plain"]], body: text.encode(body), keepAlive: true };
  }

  free(): void {}
}

export function fakeTls(): NoxTlsBindings & { sessions: FakeTlsSession[]; requests: { target: string; headers: string[]; keepAlive: boolean; padJson: boolean }[] } {
  const sessions: FakeTlsSession[] = [];
  const requests: { target: string; headers: string[]; keepAlive: boolean; padJson: boolean }[] = [];
  return {
    sessions,
    requests,
    newSession: () => {
      const session = new FakeTlsSession();
      sessions.push(session);
      return session;
    },
    newParser: () => new FakeParser(),
    encodeRequest: (method, _authority, target, headers, body, keepAlive, padJson) => {
      requests.push({ target, headers, keepAlive, padJson });
      return concat([text.encode(`${method} ${target}\n`), body]);
    },
    info: { crate: "0.0.0", webpkiRoots: 0 },
  };
}

/** A `Data` part. */
export function data(seq: number, offset: number, bytes: string, fin: "Eof" | "NeedSurbs" | "Expired" | null = null): TunnelReplyV1 {
  return { kind: "Data", seq, offset: BigInt(offset), data: text.encode(bytes), fin };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
