const fs = require('node:fs');
const path = require('node:path');

class EventLog {
  constructor({ dataDir, maxEvents = 500 } = {}) {
    this.dataDir = dataDir || path.resolve(process.cwd(), 'work/hermes-os-data');
    this.maxEvents = maxEvents;
    this.path = path.join(this.dataDir, 'events.jsonl');
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  append(event) {
    const events = this.#read();
    const lastId = events.length ? events[events.length - 1].id : 0;
    const entry = {
      id: lastId + 1,
      time: event.time || new Date().toISOString(),
      ...event,
    };
    events.push(entry);
    const trimmed = events.slice(-this.maxEvents);
    fs.writeFileSync(this.path, `${trimmed.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
    return entry;
  }

  replaySince(lastId = 0) {
    return this.#read().filter((event) => Number(event.id) > Number(lastId));
  }

  #read() {
    if (!fs.existsSync(this.path)) return [];
    return fs.readFileSync(this.path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

module.exports = {
  EventLog,
};
