// Allocation-free pools for combat hot paths (particles, tracers, casings, decals).

// Fixed capacity; acquire() recycles the oldest slot when everything is live.
export class RingPool {
    constructor(capacity, factory) {
        this.items = new Array(capacity);
        for (let i = 0; i < capacity; i++) this.items[i] = factory(i);
        this.cursor = 0;
    }

    get capacity() {
        return this.items.length;
    }

    acquire() {
        const item = this.items[this.cursor];
        this.cursor = (this.cursor + 1) % this.items.length;
        return item;
    }
}

// Grow-on-demand pool with explicit release.
export class FreeList {
    constructor(factory, prealloc = 0) {
        this.factory = factory;
        this.free = [];
        for (let i = 0; i < prealloc; i++) this.free.push(factory());
    }

    get() {
        return this.free.length ? this.free.pop() : this.factory();
    }

    release(item) {
        this.free.push(item);
    }
}

// Unordered removal without splice() shifting or allocation.
export function swapRemove(array, index) {
    const last = array.pop();
    if (index < array.length) array[index] = last;
}
