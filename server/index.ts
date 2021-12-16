import { IncomingMessage } from "http";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as mutex from "lib0/mutex";
import WebSocket from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const messageSync = 0;
const messageAwareness = 1;
// const messageAuth = 2

const pingTimeout = 30000;
const port = 1234;
const docs = new Map();
const wss = new WebSocket.Server({ port });

type AwarenessChangeHandlerArg = {
  added: number[];
  updated: number[];
  removed: number[];
};

class WSSharedDoc extends Y.Doc {
  name: string;
  mux: mutex.mutex;
  // Maps from conn to set of controlled user ids. Delete all user ids from awareness when this conn is closed
  conns: Map<WebSocket, Set<number>>;
  awareness: awarenessProtocol.Awareness;

  constructor(name: string) {
    super();
    this.name = name;
    this.mux = mutex.createMutex();
    this.conns = new Map();
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);

    this.awareness.on(
      "update",
      (arg: AwarenessChangeHandlerArg, conn: WebSocket) => {
        const { added, updated, removed } = arg;
        const changedClients = added.concat(updated, removed);
        // conn: Origin is the connection that made the change
        if (conn) {
          const connControlledIDs = this.conns.get(conn);
          if (connControlledIDs) {
            added.forEach((clientID) => connControlledIDs.add(clientID));
            removed.forEach((clientID) => connControlledIDs.delete(clientID));
          }
        }
        // broadcast awareness update
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(
            this.awareness,
            changedClients,
          ),
        );
        const buff = encoding.toUint8Array(encoder);
        this.conns.forEach((_, c) => {
          send(this, c, buff);
        });
      },
    );

    this.on("update", (update: Uint8Array, origin: any, doc: WSSharedDoc) => {
      let shouldPersist = false;

      if (origin instanceof WebSocket && doc.conns.has(origin)) {
        // pub.publishBuffer(doc.name, Buffer.from(update)); // do not await
        shouldPersist = true;
      }

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      doc.conns.forEach((_, conn) => send(doc, conn, message));

      if (shouldPersist) {
        // save update in DB
        // await persistUpdate(doc, update);
      }
    });

    // if (isCallbackSet) {
    //   this.on(
    //     "update",
    //     debounce(callbackHandler, CALLBACK_DEBOUNCE_WAIT, {
    //       maxWait: CALLBACK_DEBOUNCE_MAXWAIT,
    //     }),
    //   );
    // }

    // sub.subscribe(this.name).then(() => {
    //   sub.on('messageBuffer', (channel, update) => {
    //     if (channel.toString() !== this.name) {
    //       return;
    //     }

    //     // update is a Buffer, Buffer is a subclass of Uint8Array, update can be applied
    //     // as an update directly
    //     Y.applyUpdate(this, update, sub);
    //   })
    // })
  }
}

wss.on("connection", (conn: WebSocket, req: IncomingMessage) => {
  conn.binaryType = "arraybuffer";
  const docname = req.url!.slice(1).split("?")[0];
  // get doc, initialize if it does not exist yet
  const [doc, isNew] = getYDoc(docname);
  doc.conns.set(conn, new Set());
  // listen and reply to events
  conn.on("message", (message: WebSocket.RawData) => {
    // TODO: authenticate request
    try {
      const encoder = encoding.createEncoder();
      const decoder = decoding.createDecoder(
        new Uint8Array(message as ArrayBuffer),
      );
      const messageType = decoding.readVarUint(decoder);
      switch (messageType) {
        case messageSync:
          encoding.writeVarUint(encoder, messageSync);
          syncProtocol.readSyncMessage(decoder, encoder, doc, null);
          if (encoding.length(encoder) > 1) {
            send(doc, conn, encoding.toUint8Array(encoder));
          }
          break;
        case messageAwareness: {
          awarenessProtocol.applyAwarenessUpdate(
            doc.awareness,
            decoding.readVarUint8Array(decoder),
            conn,
          );
          break;
        }
      }
    } catch (err) {
      console.error(err);
      doc.emit("error", [err]);
    }
  });

  if (isNew) {
    // TODO
    /*
    // getUpdates from database by doc id
    const persistedUpdates = await getUpdates(doc);
    const dbYDoc = new Y.Doc()
    // for each persisted update, apply to doc 
    dbYDoc.transact(() => {
      for (const u of persistedUpdates) {
        Y.applyUpdate(dbYDoc, u.update);
      }
    });

    // update doc using the replayed dbYDoc
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(dbYDoc))
    */
  }

  // Check if connection is still alive
  let pongReceived = true;
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      if (doc.conns.has(conn)) {
        closeConn(doc, conn);
      }
      clearInterval(pingInterval);
    } else if (doc.conns.has(conn)) {
      pongReceived = false;
      try {
        conn.ping();
      } catch (e) {
        closeConn(doc, conn);
        clearInterval(pingInterval);
      }
    }
  }, pingTimeout);

  conn.on("close", () => {
    closeConn(doc, conn);
    clearInterval(pingInterval);
  });

  conn.on("pong", () => {
    pongReceived = true;
  });

  // put the following in a variables in a block so the interval handlers don't keep in in
  // scope
  {
    // send sync step 1
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(doc, conn, encoding.toUint8Array(encoder));
    const awarenessStates = doc.awareness.getStates();
    if (awarenessStates.size > 0) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(
          doc.awareness,
          Array.from(awarenessStates.keys()),
        ),
      );
      send(doc, conn, encoding.toUint8Array(encoder));
    }
  }
});

const closeConn = (doc: WSSharedDoc, conn: WebSocket) => {
  if (doc.conns.has(conn)) {
    const controlledIds = doc.conns.get(conn)!;
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(
      doc.awareness,
      Array.from(controlledIds),
      null,
    );
    if (doc.conns.size === 0) {
      // if persisted, we store state and destroy ydocument
      doc.destroy();
      docs.delete(doc.name);
    }
  }
  conn.close();
};

const send = (doc: WSSharedDoc, conn: WebSocket, m: Uint8Array): void => {
  if (
    conn.readyState !== WebSocket.CONNECTING &&
    conn.readyState !== WebSocket.OPEN
  ) {
    closeConn(doc, conn);
  }
  try {
    conn.send(m, (err) => err && closeConn(doc, conn));
  } catch (e) {
    closeConn(doc, conn);
  }
};

/**
 * Gets a Y.Doc by name, whether in memory or on disk
 *
 * @param {string} docname - the name of the Y.Doc to find or create
 * @param {boolean} gc - whether to allow gc on the doc (applies only when created)
 * @return {WSSharedDoc}
 */
const getYDoc = (docname: string, gc = true): [WSSharedDoc, boolean] => {
  const existing = docs.get(docname);
  if (existing) return [existing, false];

  const doc = new WSSharedDoc(docname);
  doc.gc = gc;
  docs.set(docname, doc);
  return [doc, true];
};

console.log(`Listening to http://localhost:${port}`);
