// rework of example code from https://github.com/yjs/yjs-demos/blob/main/demo-server/demo-server.js
import http from "http";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as mutex from "lib0/mutex";
import WebSocket from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const CALLBACK_DEBOUNCE_WAIT = 2000;
const CALLBACK_DEBOUNCE_MAXWAIT = 10000;

// /**
//  * @param {Uint8Array} update
//  * @param {any} origin
//  * @param {WSSharedDoc} doc
//  */
// const callbackHandler = (update, origin, doc) => {
//   const room = doc.name;
//   const dataToSend = {
//     room: room,
//     data: {},
//   };
//   const sharedObjectList = Object.keys(CALLBACK_OBJECTS);
//   sharedObjectList.forEach((sharedObjectName) => {
//     const sharedObjectType = CALLBACK_OBJECTS[sharedObjectName];
//     dataToSend.data[sharedObjectName] = {
//       type: sharedObjectType,
//       content: getContent(sharedObjectName, sharedObjectType, doc).toJSON(),
//     };
//   });
//   callbackRequest(CALLBACK_URL, CALLBACK_TIMEOUT, dataToSend);
// };

// /**
//  * @param {URL} url
//  * @param {number} timeout
//  * @param {Object} data
//  */
// const callbackRequest = (url, timeout, data) => {
//   data = JSON.stringify(data);
//   const options = {
//     hostname: url.hostname,
//     port: url.port,
//     path: url.pathname,
//     timeout: timeout,
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//       "Content-Length": data.length,
//     },
//   };
//   const req = http.request(options);
//   req.on("timeout", () => {
//     console.warn("Callback request timed out.");
//     req.abort();
//   });
//   req.on("error", (e) => {
//     console.error("Callback request error.", e);
//     req.abort();
//   });
//   req.write(data);
//   req.end();
// };

// /**
//  * @param {string} objName
//  * @param {string} objType
//  * @param {WSSharedDoc} doc
//  */
// const getContent = (objName: string, objType: string, doc: WSSharedDoc) => {
//   switch (objType) {
//     case "Array":
//       return doc.getArray(objName);
//     case "Map":
//       return doc.getMap(objName);
//     case "Text":
//       return doc.getText(objName);
//     case "XmlFragment":
//       return doc.getXmlFragment(objName);
//     case "XmlElement":
//       return doc.getXmlElement(objName);
//     default:
//       return {};
//   }
// };

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

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;
const wsReadyStateClosing = 2; // eslint-disable-line
const wsReadyStateClosed = 3; // eslint-disable-line

// disable gc when using snapshots!
const gcEnabled = process.env.GC !== "false" && process.env.GC !== "0";

/**
 * @type {{bindState: function(string,WSSharedDoc):void, writeState:function(string,WSSharedDoc):Promise<any>, provider: any}|null}
 */
// let persistence = null;
// if (typeof persistenceDir === "string") {
//   console.info('Persisting documents to "' + persistenceDir + '"');
//   // @ts-ignore
//   const LeveldbPersistence = require("y-leveldb").LeveldbPersistence;
//   const ldb = new LeveldbPersistence(persistenceDir);
//   persistence = {
//     provider: ldb,
//     bindState: async (docName, ydoc) => {
//       const persistedYdoc = await ldb.getYDoc(docName);
//       const newUpdates = Y.encodeStateAsUpdate(ydoc);
//       ldb.storeUpdate(docName, newUpdates);
//       Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc));
//       ydoc.on("update", (update) => {
//         ldb.storeUpdate(docName, update);
//       });
//     },
//     writeState: async (docName, ydoc) => {},
//   };
// }

// exporting docs so that others can use it
// 在内存cache所有ws连接的docs
export const docs = new Map();

const messageSync = 0;
const messageAwareness = 1;
// const messageAuth = 2

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

const pingTimeout = 30000;

/**
 * @param {any} conn
 * @param {any} req
 * @param {any} opts
 */
const setupWSConnection = (conn: WebSocket, req: http.IncomingMessage) => {
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
};

export default setupWSConnection;
