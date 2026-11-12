// Key routing shared by all modules: registered handlers run before the legacy key chain.
export class Input {
    constructor(engine) {
        this.engine = engine;
        this.keys = engine.keys;
        // Analog movement (-1..1) from touch sticks / gamepads; summed with WASD by the controllers.
        this.axes = { moveX: 0, moveY: 0 };
        this._down = new Map();
        this._up = new Map();
    }

    // handler(event) may return true to consume the key. Higher priority runs first.
    bind(code, handler, { priority = 0 } = {}) {
        return this._add(this._down, code, handler, priority);
    }

    bindUp(code, handler, { priority = 0 } = {}) {
        return this._add(this._up, code, handler, priority);
    }

    _add(map, code, handler, priority) {
        const entry = { handler, priority };
        const list = (map.get(code) || []).concat(entry).sort((a, b) => b.priority - a.priority);
        map.set(code, list);
        return () => map.set(code, (map.get(code) || []).filter((e) => e !== entry));
    }

    dispatchDown(event) {
        return this._dispatch(this._down, event);
    }

    dispatchUp(event) {
        return this._dispatch(this._up, event);
    }

    _dispatch(map, event) {
        const list = map.get(event.code);
        if (!list) return false;
        for (let i = 0; i < list.length; i++) {
            try {
                if (list[i].handler(event) === true) return true;
            } catch (err) {
                console.error(`[input] handler for ${event.code} failed`, err);
            }
        }
        return false;
    }

    isDown(code) {
        return this.keys[code] === true;
    }

    // Virtual key presses for touch buttons and tests; they take the same path as the keyboard.
    press(code) {
        this.engine.handleKeyDown({ code, synthetic: true, preventDefault() {} });
    }

    release(code) {
        this.engine.handleKeyUp({ code, synthetic: true, preventDefault() {} });
    }

    tap(code) {
        this.press(code);
        this.release(code);
    }
}
