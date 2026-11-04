// One Trystero room per key for the whole page.
//
// Leaving and joining the same room in quick succession (React StrictMode,
// fast navigation) can hand the new session a room that is shutting down. So
// rooms are shared and reference-counted, and left a moment after the last
// user releases them. A session that takes over a room is told about the
// peers already in it.

import type { Transport } from "@peerdash/core";
import { connectTrystero } from "@peerdash/core/trystero";

const LINGER_MS = 1500;

interface Room {
  transport: Promise<Transport>;
  users: number;
  peers: Set<string>;
  onJoin: ((id: string) => void) | null;
  onLeave: ((id: string) => void) | null;
  timer?: ReturnType<typeof setTimeout>;
}

const rooms = new Map<string, Room>();

function open(key: string): Room {
  const room: Room = { transport: connectTrystero(key), users: 0, peers: new Set(), onJoin: null, onLeave: null };
  void room.transport.then((t) => {
    t.onPeerJoin((id) => {
      room.peers.add(id);
      room.onJoin?.(id);
    });
    t.onPeerLeave((id) => {
      room.peers.delete(id);
      room.onLeave?.(id);
    });
  });
  return room;
}

export async function acquireTransport(key: string): Promise<Transport> {
  let room = rooms.get(key);
  if (!room) {
    room = open(key);
    rooms.set(key, room);
  }
  clearTimeout(room.timer);
  room.users++;
  const t = await room.transport;
  const r = room;
  let released = false;
  return {
    hello: t.hello,
    update: t.update,
    presence: t.presence,
    onPeerJoin: (handler) => {
      r.onJoin = handler;
      r.peers.forEach((id) => handler(id));
    },
    onPeerLeave: (handler) => {
      r.onLeave = handler;
    },
    // Only releases this user's share of the room.
    leave: () => {
      if (released) return;
      released = true;
      if (--r.users > 0) return;
      r.onJoin = r.onLeave = null;
      r.timer = setTimeout(() => {
        rooms.delete(key);
        void r.transport.then((tr) => tr.leave());
      }, LINGER_MS);
    },
  };
}
