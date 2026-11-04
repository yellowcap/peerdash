// Transport over WebRTC data channels, using Trystero with public Nostr relays
// for signalling. No server of our own: the relays only see encrypted
// connection offers for an opaque room name; the data flows peer to peer,
// encrypted by WebRTC (DTLS).
//
// Browsers use their own WebRTC. The agent peer passes `rtcPolyfill` (werift).

import { joinRoom } from "trystero/nostr";
import type { Channel, Hello, Presence, Transport } from "./session";
import { roomIdFor } from "./link";

const APP_ID = "peerdash-v1";

type Action<T> = {
  send: (data: T, options?: { target?: string }) => Promise<void>;
  onMessage: ((data: T, context: { peerId: string }) => void) | null;
};

function channel<T, W = T>(action: Action<W>, encode: (v: T) => W, decode: (v: W) => T): Channel<T> {
  return {
    send: (data, to) => void action.send(encode(data), to ? { target: to } : undefined).catch(() => {}),
    on: (handler) => {
      action.onMessage = (data, ctx) => handler(decode(data), ctx.peerId);
    },
  };
}

export interface TrysteroOptions {
  /** RTCPeerConnection implementation outside the browser. */
  rtcPolyfill?: unknown;
  /** Optional TURN relay for networks that block direct connections. */
  turn?: { urls: string[]; username?: string; credential?: string };
}

export async function connectTrystero(key: string, options: TrysteroOptions = {}): Promise<Transport> {
  const room = joinRoom(
    {
      appId: APP_ID,
      password: key,
      ...(options.rtcPolyfill ? { rtcPolyfill: options.rtcPolyfill as never } : {}),
      ...(options.turn ? { turnConfig: [options.turn] } : {}),
    },
    await roomIdFor(key),
  );

  const id = <T>(v: T) => v;
  const toBytes = (v: ArrayBuffer | ArrayBufferView): Uint8Array =>
    v instanceof Uint8Array ? v : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v);

  return {
    hello: channel<Hello>(room.makeAction<Hello>("hello") as unknown as Action<Hello>, id, id),
    update: channel<Uint8Array, ArrayBuffer | ArrayBufferView>(
      room.makeAction<ArrayBufferView>("update") as unknown as Action<ArrayBuffer | ArrayBufferView>,
      id,
      toBytes,
    ),
    presence: channel<Presence>(room.makeAction<Presence>("presence") as unknown as Action<Presence>, id, id),
    onPeerJoin: (handler) => {
      room.onPeerJoin = handler;
    },
    onPeerLeave: (handler) => {
      room.onPeerLeave = handler;
    },
    leave: () => void room.leave(),
  };
}
