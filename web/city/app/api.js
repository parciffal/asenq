export function readToken() {
  const match = location.hash.match(/^#token=([^&]*)/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); }
  catch { return null; }
}

export function createApi(token = readToken()) {
  if (!token) return { token: null, events: () => () => {}, history: async () => { throw new Error("Open the URL printed by asenq city"); }, send: async () => { throw new Error("Open the URL printed by asenq city"); } };

  const headers = { "X-Asenq-Token": token };
  const request = async (url, init = {}) => {
    const response = await fetch(url, {
      cache: "no-store",
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
    });
    let payload;
    try { payload = await response.json(); }
    catch { payload = null; }
    if (!response.ok) {
      const error = new Error(payload?.message ?? payload?.error ?? `Request failed (${response.status})`);
      error.status = response.status;
      error.code = payload?.error;
      throw error;
    }
    return payload;
  };

  return {
    token,
    events(handlers = {}) {
      const params = new URLSearchParams({ token });
      const source = new EventSource(`/api/events?${params}`);
      const names = ["state", "packet", "message"];
      for (const name of names) source.addEventListener(name, (event) => {
        let data;
        try { data = JSON.parse(event.data); }
        catch { return; }
        handlers[name]?.(data);
      });
      source.onopen = () => handlers.connection?.(true);
      source.onerror = () => handlers.connection?.(false, source.readyState);
      return () => source.close();
    },
    history(scope, before) {
      const params = new URLSearchParams();
      params.set("scope", scope.scope);
      if (scope.scope === "channel") params.set("channel", scope.channel);
      else if (scope.scope === "session") params.set("sessionId", scope.sessionId);
      else throw new TypeError("Unsupported history scope");
      if (before !== undefined && before !== null) params.set("before", String(before));
      return request(`/api/history?${params}`, { method: "GET" });
    },
    send(target, text) {
      return request("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, text }),
      });
    },
  };
}
