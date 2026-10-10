// Connection-scoped indexes for the contract fixture; no resource roles or rooms.
export class SubscriptionIndex {
  byResource = new Map();
  bySocket = new Map();

  subscribe(socket, ids) {
    if (!socket.connected) return;
    const resources = this.bySocket.get(socket) ?? new Set();
    for (const id of ids) {
      if (resources.has(id)) continue;
      const sockets = this.byResource.get(id) ?? new Set();
      sockets.add(socket);
      this.byResource.set(id, sockets);
      resources.add(id);
    }
    if (resources.size) this.bySocket.set(socket, resources);
  }

  disconnect(socket) {
    for (const id of this.bySocket.get(socket) ?? []) {
      const sockets = this.byResource.get(id);
      sockets?.delete(socket);
      if (!sockets?.size) this.byResource.delete(id);
    }
    this.bySocket.delete(socket);
  }

  recipients(updated, deleted, author) {
    const result = new Map();
    const collect = (id, group, value) => {
      for (const socket of this.byResource.get(id) ?? []) {
        if (!socket.connected || socket === author) continue;
        const changes = result.get(socket) ?? { updated: [], deleted: [] };
        changes[group].push(value);
        result.set(socket, changes);
      }
    };
    for (const record of updated) collect(record.id, "updated", record);
    for (const id of deleted) collect(id, "deleted", id);
    return result;
  }

  remove(ids) {
    for (const id of ids) {
      for (const socket of this.byResource.get(id) ?? []) {
        const resources = this.bySocket.get(socket);
        resources?.delete(id);
        if (!resources?.size) this.bySocket.delete(socket);
      }
      this.byResource.delete(id);
    }
  }
}
