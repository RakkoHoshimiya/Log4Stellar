/**
 * A small in-memory IndexedDB for the offline tests.
 *
 * It exists so the real `offline-store.js` can run unmodified: the store's whole job is
 * transaction orchestration, and the failure modes this task must prove (a crash between
 * two writes, a quota rejection, a schema one version newer) only exist if the
 * transaction boundary is real. Mocking the store instead would test the mock.
 *
 * Timing model, which is the only subtle part: a transaction finishes in a MACROTASK
 * after its last request settles, so every `await` the store performs inside a
 * transaction has already run before completion fires — exactly like a real IndexedDB,
 * where the transaction stays open while requests are pending. `oncomplete` is a setter
 * so a handler attached after completion still runs.
 */

function clone(value) {
	if (value === undefined || value === null || typeof value !== 'object') {
		return value;
	}
	return structuredClone(value);
}

class FakeKeyRange {
	constructor(only) {
		this.only = only;
	}
}

class FakeRequest {
	constructor(run, transaction) {
		this.result = undefined;
		this.error = null;
		this._onsuccess = null;
		this._onerror = null;
		this.done = false;
		transaction?.noteRequest();
		queueMicrotask(() => {
			try {
				this.result = run();
			} catch (error) {
				this.error = error;
				this.done = true;
				transaction?.settleRequest();
				this._onerror?.();
				return;
			}
			this.done = true;
			transaction?.settleRequest();
			this._onsuccess?.();
		});
	}
	get onsuccess() {
		return this._onsuccess;
	}
	set onsuccess(handler) {
		this._onsuccess = handler;
		if (this.done && !this.error) {
			queueMicrotask(() => handler?.());
		}
	}
	get onerror() {
		return this._onerror;
	}
	set onerror(handler) {
		this._onerror = handler;
		if (this.done && this.error) {
			queueMicrotask(() => handler?.());
		}
	}
}

class FakeIndex {
	constructor(name, keyPath, records) {
		this.name = name;
		this.keyPath = keyPath;
		this.records = records;
	}
	getAll(range) {
		return new FakeRequest(() => {
			const wanted = range instanceof FakeKeyRange ? range.only : range;
			const matches = [];
			for (const record of this.records.values()) {
				if (record[this.keyPath] === wanted) {
					matches.push(clone(record));
				}
			}
			return matches;
		});
	}
}

class FakeObjectStore {
	constructor(name, keyPath, records, transaction) {
		this.name = name;
		this.keyPath = keyPath;
		this.records = records;
		this.indexes = new Map();
		this.transaction = transaction;
	}
	get indexNames() {
		return { contains: name => this.indexes.has(name) };
	}
	createIndex(name, keyPath) {
		const index = new FakeIndex(name, keyPath, this.records);
		this.indexes.set(name, index);
		return index;
	}
	index(name) {
		const index = this.indexes.get(name);
		if (!index) {
			throw new Error('NotFoundError: no index named ' + name);
		}
		index.records = this.records;
		return index;
	}
	get(key) {
		return new FakeRequest(() => clone(this.records.get(key)), this.transaction);
	}
	getAll() {
		return new FakeRequest(() => [...this.records.values()].map(clone), this.transaction);
	}
	put(value) {
		return new FakeRequest(() => {
			const key = value[this.keyPath];
			this.records.set(key, clone(value));
			return key;
		}, this.transaction);
	}
	delete(key) {
		return new FakeRequest(() => {
			this.records.delete(key);
			return undefined;
		}, this.transaction);
	}
}

class FakeTransaction {
	constructor(database, names, mode) {
		this.database = database;
		this.mode = mode;
		this.names = names;
		this.error = null;
		this.aborted = false;
		this.outstanding = 0;
		this.finished = false;
		this._oncomplete = null;
		this._onerror = null;
		this._onabort = null;
		this._checkScheduled = false;
		if (mode === 'readwrite') {
			database.begin();
		}
		this.objectStore = name => {
			if (!this.names.includes(name)) {
				throw new Error('NotFoundError: object store ' + name + ' is not in this transaction');
			}
			return database.storeHandle(name, this);
		};
		this.scheduleCheck();
	}
	noteRequest() {
		this.outstanding += 1;
		this.scheduleCheck();
	}
	settleRequest() {
		this.outstanding -= 1;
		this.scheduleCheck();
	}
	scheduleCheck() {
		if (this._checkScheduled || this.finished) {
			return;
		}
		this._checkScheduled = true;
		// A macrotask, not a microtask: every `await` continuation of the caller runs
		// first, so completion never fires in the middle of the caller's request chain.
		setTimeout(() => {
			this._checkScheduled = false;
			if (this.finished) {
				return;
			}
			if (this.outstanding > 0) {
				this.scheduleCheck();
				return;
			}
			if (this.database.failuresRemaining > 0 && this.mode === 'readwrite') {
				this.database.failuresRemaining -= 1;
				this.aborted = true;
				this.error = new Error(this.database.failureReason);
				this.finished = true;
				this.database.rollback();
				this._onerror?.(this.error);
				this._onabort?.(this.error);
				return;
			}
			this.finished = true;
			this.database.commit();
			this._oncomplete?.();
		}, 0);
	}
	get oncomplete() {
		return this._oncomplete;
	}
	set oncomplete(handler) {
		this._oncomplete = handler;
		if (this.finished && !this.aborted) {
			setTimeout(() => handler?.(), 0);
		}
	}
	get onerror() {
		return this._onerror;
	}
	set onerror(handler) {
		this._onerror = handler;
	}
	get onabort() {
		return this._onabort;
	}
	set onabort(handler) {
		this._onabort = handler;
		if (this.aborted) {
			setTimeout(() => handler?.(this.error), 0);
		}
	}
	abort() {
		this.aborted = true;
		this.finished = true;
		this.database.rollback();
		this._onabort?.(this.error);
	}
}

class FakeDatabase {
	constructor(name, version) {
		this.name = name;
		this.version = version;
		this.stores = new Map();
		this.pending = null;
		this.failuresRemaining = 0;
		this.failureReason = 'QuotaExceededError';
		this.closed = false;
		this.objectStoreNames = { contains: name => this.stores.has(name) };
	}
	close() {
		this.closed = true;
	}
	begin() {
		if (this.pending) {
			return;
		}
		this.pending = new Map();
		for (const [name, store] of this.stores) {
			const copy = new Map();
			for (const [key, value] of store.records) {
				copy.set(key, clone(value));
			}
			this.pending.set(name, copy);
		}
	}
	commit() {
		if (!this.pending) {
			return;
		}
		for (const [name, records] of this.pending) {
			const store = this.stores.get(name);
			if (store) {
				store.records = records;
			}
		}
		this.pending = null;
	}
	rollback() {
		this.pending = null;
	}
	storeHandle(name, transaction) {
		const template = this.stores.get(name);
		if (!template) {
			throw new Error('NotFoundError: object store ' + name + ' does not exist');
		}
		const records = this.pending?.get(name) ?? template.records;
		const handle = new FakeObjectStore(name, template.keyPath, records, transaction);
		handle.indexes = new Map();
		for (const [indexName, index] of template.indexes) {
			handle.indexes.set(indexName, new FakeIndex(indexName, index.keyPath, records));
		}
		return handle;
	}
	transaction(names, mode = 'readonly') {
		return new FakeTransaction(this, Array.isArray(names) ? names : [names], mode);
	}
	createObjectStore(name, { keyPath }) {
		const records = new Map();
		const store = new FakeObjectStore(name, keyPath, records, null);
		store.indexes = new Map();
		this.stores.set(name, store);
		if (this.pending) {
			this.pending.set(name, records);
		}
		return store;
	}
	failNextTransaction(reason = 'QuotaExceededError') {
		this.failuresRemaining += 1;
		this.failureReason = reason;
	}
}

export function createFakeIndexedDB() {
	const databases = new Map();
	const factory = {
		databases,
		open(databaseName, requestedVersion = 1) {
			const request = { result: undefined, error: null, transaction: null, onsuccess: null, onerror: null, onupgradeneeded: null };
			queueMicrotask(() => {
				let database = databases.get(databaseName);
				if (!database) {
					database = new FakeDatabase(databaseName, 0);
					databases.set(databaseName, database);
				}
				const oldVersion = database.version;
				if (requestedVersion > oldVersion) {
					database.version = requestedVersion;
					database.begin();
					request.result = database;
					request.transaction = {
						objectStore: storeName => database.storeHandle(storeName, null),
					};
					try {
						request.onupgradeneeded?.({ oldVersion, newVersion: requestedVersion });
					} catch (error) {
						database.rollback();
						request.error = error;
						request.onerror?.();
						return;
					}
					database.commit();
				}
				request.result = database;
				request.onsuccess?.();
			});
			return request;
		},
	};
	globalThis.IDBKeyRange = FakeKeyRange;
	return factory;
}

export function fakeKeyRangeOnly(key) {
	return new FakeKeyRange(key);
}
