// services/enchants.js
const fs = require("fs");
const path = require("path");

class DefaultEnchants {
  static DATA_FILE = path.resolve(
    __dirname,
    "../data/recommend_item_details.json"
  );

  // -------- file I/O --------
  static readJSONSafe(fp, fb) {
    try {
      if (!fs.existsSync(fp)) return fb;
      return JSON.parse(fs.readFileSync(fp, "utf-8"));
    } catch {
      return fb;
    }
  }

  // -------- normalize & map --------
  static normalizeValue(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const s = v.trim().replace(/,/g, "");
      const m = s.match(/-?\d+(\.\d+)?/);
      if (m) return parseFloat(m[0]);
    }
    return NaN;
  }

  static normalizeName(name) {
    return String(name || "")
      .trim()
      .replace(/\s+/g, "");
  }
}

module.exports = DefaultEnchants;
