// services/cache.js
class TTLCache {
  constructor(ttlMs = 300_000, maxSize = 2000) {
    this.ttl = ttlMs;
    this.max = maxSize;
    this.map = new Map(); // key -> { value, exp }
  }
  get(key) {
    const ent = this.map.get(key);
    if (!ent) return null;
    if (Date.now() > ent.exp) {
      this.map.delete(key);
      return null;
    }
    return ent.value;
  }
  set(key, value) {
    // 간단한 용량 제한
    if (this.map.size >= this.max) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, { value, exp: Date.now() + this.ttl });
  }
}
module.exports = TTLCache;
