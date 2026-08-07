// The deployable op-executor Worker for the workerd oracle (plain standard-Workers JS).
//
// workerd loads JS modules, not TS, so this is the runnable twin of the typed reference in
// op_executor.ts — same op→ctx.storage mapping, hand-kept in sync. Being an independent
// implementation is a feature here: agreement between it, the in-memory reference, and the corpus
// is stronger evidence than a single shared codepath. The default export routes each request to a
// Durable Object chosen by the `x-object-id` header, giving per-instance isolation.

export class OpExecutor {
  constructor(state) {
    this.state = state;
  }

  // Required: workerd refuses setAlarm() unless the class defines an alarm() handler.
  async alarm() {}

  async fetch(request) {
    const op = await request.json();
    const s = this.state.storage;
    let result;
    switch (op.kind) {
      case "put":
        await s.put(op.key, op.value);
        result = null;
        break;
      case "get": {
        const v = await s.get(op.key);
        result = v === undefined ? null : v;
        break;
      }
      case "delete":
        result = await s.delete(op.key);
        break;
      case "deleteAll":
        await s.deleteAll();
        result = null;
        break;
      case "list": {
        const o = op.options || {};
        const opts = {};
        if (o.prefix !== undefined) opts.prefix = o.prefix;
        if (o.limit !== undefined) opts.limit = o.limit;
        if (o.reverse !== undefined) opts.reverse = o.reverse;
        const map = await s.list(opts);
        result = [...map.entries()];
        break;
      }
      case "setAlarm":
        await s.setAlarm(op.scheduledTime);
        result = null;
        break;
      case "getAlarm":
        result = await s.getAlarm();
        break;
      case "deleteAlarm":
        await s.deleteAlarm();
        result = null;
        break;
      default:
        return new Response(`unknown op: ${op.kind}`, { status: 400 });
    }
    return Response.json({ result });
  }
}

export default {
  fetch(request, env) {
    const id = request.headers.get("x-object-id") || "default";
    return env.OBJ.get(env.OBJ.idFromName(id)).fetch(request);
  },
};
