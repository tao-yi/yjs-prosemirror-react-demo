// @ts-ignore
import { exampleSetup } from "prosemirror-example-setup";
// @ts-ignore
import { keymap } from "prosemirror-keymap";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import React, { useCallback } from "react";
import {
  redo,
  undo,
  yCursorPlugin,
  ySyncPlugin,
  yUndoPlugin,
} from "y-prosemirror";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import "./App.css";
import { schema } from "./schema";

function App() {
  const wrapperRef = useCallback((wrapper: HTMLDivElement) => {
    if (!wrapper) return;
    wrapper.innerHTML = "";
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(
      "wss://localhost:1234",
      "prosemirror",
      ydoc,
    );
    const type = ydoc.getXmlFragment("prosemirror");
    const state = EditorState.create({
      schema,
      plugins: [
        ySyncPlugin(type),
        yCursorPlugin(provider.awareness),
        yUndoPlugin(),
        keymap({
          "Mod-z": undo,
          "Mod-y": redo,
          "Mod-Shift-z": redo,
        }),
      ].concat(exampleSetup({ schema })),
    });
    const view = new EditorView(wrapper, {
      state,
      dispatchTransaction(tr) {
        const state = view.state.apply(tr);
        view.updateState(state);
      },
    });
  }, []);

  return <div ref={wrapperRef} />;
}

export default App;
