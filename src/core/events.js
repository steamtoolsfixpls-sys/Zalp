// Tiny synchronous event bus shared by every engine module.
export class EventBus {
    constructor() {
        this._listeners = new Map();
    }

    on(type, fn) {
        // Copy-on-write keeps emit() safe when listeners subscribe or unsubscribe mid-dispatch.
        this._listeners.set(type, (this._listeners.get(type) || []).concat(fn));
        return () => this.off(type, fn);
    }

    once(type, fn) {
        const off = this.on(type, (payload) => {
            off();
            fn(payload);
        });
        return off;
    }

    off(type, fn) {
        const list = this._listeners.get(type);
        if (!list) return;
        this._listeners.set(type, list.filter((f) => f !== fn));
    }

    emit(type, payload) {
        const list = this._listeners.get(type);
        if (!list) return;
        for (let i = 0; i < list.length; i++) {
            try {
                list[i](payload);
            } catch (err) {
                console.error(`[events] listener for "${type}" failed`, err);
            }
        }
    }
}
