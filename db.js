import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

// Create data directory if it doesn't exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export class FileDB {
  constructor(name) {
    this.name = name;
    this.filePath = path.join(DATA_DIR, `${name}.json`);
    this.tempPath = path.join(DATA_DIR, `${name}.tmp`);
    this.init();
  }

  init() {
    if (!fs.existsSync(this.filePath)) {
      this.write([]);
    }
  }

  read() {
    try {
      const data = fs.readFileSync(this.filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      console.error(`Error reading database file: ${this.filePath}`, error);
      return [];
    }
  }

  write(data) {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.error(`Error writing database file: ${this.filePath}`, error);
      throw error;
    }
  }

  find(predicate) {
    const list = this.read();
    return predicate ? list.filter(predicate) : list;
  }

  findOne(predicate) {
    const list = this.read();
    return list.find(predicate) || null;
  }

  insert(item) {
    const list = this.read();
    const newItem = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...item,
    };
    list.push(newItem);
    this.write(list);
    return newItem;
  }

  insertMany(items) {
    const list = this.read();
    const newItems = items.map((item) => ({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...item,
    }));
    list.push(...newItems);
    this.write(list);
    return newItems;
  }

  update(id, updates) {
    const list = this.read();
    const index = list.findIndex((item) => item.id === id);
    if (index === -1) return null;

    list[index] = {
      ...list[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.write(list);
    return list[index];
  }

  delete(id) {
    const list = this.read();
    const initialLength = list.length;
    const filtered = list.filter((item) => item.id !== id);
    if (filtered.length === initialLength) return false;
    this.write(filtered);
    return true;
  }

  deleteMany(predicate) {
    const list = this.read();
    const filtered = list.filter((item) => !predicate(item));
    this.write(filtered);
    return true;
  }
}

// Instantiate database tables
export const db = {
  users: new FileDB("users"),
  questions: new FileDB("questions"),
  prepContent: new FileDB("prep_content"),
  prepProgress: new FileDB("prep_progress"),
  practiceSessions: new FileDB("practice_sessions"),
  bookmarks: new FileDB("bookmarks"),
  settings: new FileDB("settings"),
  codingQuestions: new FileDB("coding_questions"),
  codingAttempts: new FileDB("coding_attempts"),
  codingDrafts: new FileDB("coding_drafts"),
  chatLogs: new FileDB("chat_logs"),
  userTelemetry: new FileDB("user_telemetry"),
  supportAnalytics: new FileDB("support_analytics"),
};
