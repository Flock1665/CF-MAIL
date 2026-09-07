export class SingleFlight {
    #pending = new Map();

    async run(key, task) {
        if (this.#pending.has(key)) return await this.#pending.get(key);

        const result = task();
        this.#pending.set(key, result);
        try {
            return await result;
        } finally {
            this.#pending.delete(key);
        }
    }
}
