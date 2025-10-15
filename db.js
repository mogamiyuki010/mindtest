import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const DB_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DB_DIR, 'app.db');
const MIG_DIR = path.join(ROOT, 'migrations');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_FILE);

// 跑 migrations
const initSql = fs.readFileSync(path.join(MIG_DIR, '001_init.sql'), 'utf-8');
db.exec(initSql);

// 事件操作函數
export const insertEvent = db.prepare(`
  INSERT INTO events (id, ts, session_id, ip, page, type, payload)
  VALUES (@id, @ts, @session_id, @ip, @page, @type, @payload)
`);

export const queryEvents = db.prepare(`
  SELECT * FROM events
  WHERE (@type = 'all' OR type = @type)
    AND (@start IS NULL OR ts >= @start)
    AND (@end IS NULL OR ts <= @end)
  ORDER BY ts DESC
  LIMIT @limit OFFSET @offset
`);

export const countEvents = db.prepare(`
  SELECT COUNT(*) AS cnt
  FROM events
  WHERE (@type = 'all' OR type = @type)
    AND (@start IS NULL OR ts >= @start)
    AND (@end IS NULL OR ts <= @end)
`);

// 結果操作函數
export const insertResult = db.prepare(`
  INSERT INTO results (id, ts, session_id, result_name, score_json)
  VALUES (@id, @ts, @session_id, @result_name, @score_json)
`);

export const queryResults = db.prepare(`
  SELECT * FROM results
  WHERE (@start IS NULL OR ts >= @start)
    AND (@end IS NULL OR ts <= @end)
  ORDER BY ts DESC
  LIMIT @limit OFFSET @offset
`);

export default db;
