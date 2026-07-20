export class EventEmitter {
  #listeners = new Set();

  event = (listener) => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };

  fire(value) {
    for (const listener of this.#listeners) {
      listener(value);
    }
  }

  dispose() {
    this.#listeners.clear();
  }
}

export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
};

export class TreeItem {
  constructor(label, collapsibleState = TreeItemCollapsibleState.None) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}
